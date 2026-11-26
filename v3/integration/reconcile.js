#!/usr/bin/env node
// Compares a subgraph that a graph-node has synced with the chain it indexed.
//
//   node integration/reconcile.js <subgraph query URL>                  the local chain
//   node integration/reconcile.js <subgraph query URL> <config file>    a real network
//
// The URL is, for example, http://localhost:8000/subgraphs/name/ajna-v3. For the local chain it
// needs the node that scripts/local-chain.sh start left running, and integration/.out/scenario.json.
// For a real network it needs the config the subgraph was rendered from (config/<network>.json)
// and RPC_URL, an endpoint that serves state back to the factories' start blocks.
//
// It makes two kinds of check against the entities the graph-node serves, at the scenario's last
// block or, for a real network, at the last block the subgraph has indexed:
//
//   - those of integration/expected.js, which the recorded Matchstick test makes too: which
//     entities exist, how many events were recorded, and every field that must equal the
//     chain's final state
//   - for every Pool, Bucket, Lend, Loan and PositionLend, the fields read from the contracts,
//     against the chain at the block the entity says it was refreshed in. These drift between
//     events, so the recorded test cannot check them. Where the contracts offer another way to
//     the same value than the reader the mappings use, that way is taken.
//
// On the local chain it then makes the checks integration/hostile.js left in
// integration/.out/hostile.json, at the block that script ended at: what the subgraph must hold
// after tokens and arguments chosen to break an indexer.
const fs = require("fs")
const path = require("path")

const { Interface } = require("@ethersproject/abi")

const { Chain, interfaceOf } = require("./chain")
const { decodedEvents } = require("./events")
const { decimal, expectations } = require("./expected")

const OUT = path.join(__dirname, ".out")

const POOL = interfaceOf("ERC20Pool")
const FACTORY = interfaceOf("ERC20PoolFactory")
const INFO = interfaceOf("PoolInfoUtils")
const MANAGER = interfaceOf("PositionManager")
const BALANCE = new Interface(["function balanceOf(address) view returns (uint256)"])
const WAD = 10n ** 18n
const LENDER_SHARE = (96n * WAD) / 100n

// the contracts' rounding multiplication of two WADs
const wmul = (a, b) => (a * b + WAD / 2n) / WAD

// a decimal string as an integer of 40 decimals, to compare products that have more than 18
function scaled(text) {
  const [whole, fraction = ""] = text.split(".")
  return BigInt(whole + fraction.padEnd(40, "0").slice(0, 40))
}

async function graphql(url, query) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query })
  })
  const body = await response.json()
  if (body.errors) throw new Error(`${body.errors.map((error) => error.message).join("; ")}\n  in: ${query}`)
  return body.data
}

// the innermost named type of a GraphQL type reference, and whether a list wraps it
function unwrap(type) {
  let list = false
  while (type.ofType) {
    if (type.kind === "LIST") list = true
    type = type.ofType
  }
  return { name: type.name, kind: type.kind, list }
}

// a value as integration/expected.js writes it: a reference by its id, a list in brackets, and
// a decimal without trailing zeros
function normalized(value) {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return `[${value.map(normalized).join(", ")}]`
  if (typeof value === "object") return value.id
  const text = String(value)
  return /^-?\d+\.\d+$/.test(text) ? text.replace(/0+$/, "").replace(/\.$/, "") : text
}

async function main() {
  const url = process.argv[2]
  const configFile = process.argv[3]
  if (!url) throw new Error("usage: reconcile.js <subgraph query URL> [config file]")

  const meta = (await graphql(url, `{ _meta { block { number } hasIndexingErrors } }`))._meta
  if (meta.hasIndexingErrors) throw new Error("the subgraph has indexing errors")

  let scenario
  let chain
  if (configFile) {
    // a real network: its deployments from the config, its pools from the factories, and
    // everything compared at the last block the subgraph has indexed
    if (!process.env.RPC_URL) throw new Error("set RPC_URL to an endpoint of the network the subgraph indexes")
    chain = new Chain(process.env.RPC_URL)
    const config = JSON.parse(fs.readFileSync(configFile, "utf8"))
    const lower = (address) => address.toLowerCase()
    scenario = {
      headBlock: meta.block.number,
      startBlock: Math.min(...config.deployments.map((deployment) => deployment.factory.startBlock)),
      deployments: config.deployments.map((deployment) => ({
        factory: { address: lower(deployment.factory.address) },
        positionManager: { address: lower(deployment.positionManager.address) },
        poolInfoUtils: lower(deployment.poolInfoUtils),
        poolInfoUtilsMulticall: lower(deployment.poolInfoUtilsMulticall)
      })),
      pools: {}
    }
    for (const deployment of scenario.deployments) {
      const factory = { address: deployment.factory.address, iface: FACTORY }
      const [deployed] = await chain.call(factory, "getDeployedPoolsList", [], scenario.headBlock)
      for (const pool of deployed) scenario.pools[lower(pool)] = lower(pool)
    }
  } else {
    scenario = JSON.parse(fs.readFileSync(path.join(OUT, "scenario.json"), "utf8"))
    chain = new Chain(process.env.RPC_URL || scenario.rpcUrl)
    if (meta.block.number < scenario.headBlock) {
      throw new Error(`the subgraph is at block ${meta.block.number}; the scenario ends at ${scenario.headBlock}`)
    }
  }
  const head = scenario.headBlock

  // how the graph-node names each entity's queries, and which of its fields are references
  const schema = (
    await graphql(
      url,
      `{ __schema { queryType { fields { name type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } } } }`
    )
  ).__schema
  const single = {}
  const plural = {}
  for (const query of schema.queryType.fields) {
    const target = unwrap(query.type)
    if (target.kind !== "OBJECT") continue
    if (target.list) plural[target.name] = query.name
    else single[target.name] = query.name
  }
  const references = {}
  async function isReference(entity, field) {
    if (!references[entity]) {
      const type = (
        await graphql(
          url,
          `{ __type(name: "${entity}") { fields { name type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } } }`
        )
      ).__type
      references[entity] = {}
      for (const candidate of type.fields) references[entity][candidate.name] = unwrap(candidate.type).kind === "OBJECT"
    }
    return references[entity][field]
  }

  const failures = []

  // Every entity of a kind as it was at a block, a thousand at a time. The pages follow the ids:
  // a hosted endpoint refuses to skip more than a few thousand entities.
  const all = async (entity, selection, at) => {
    const items = []
    let last = null
    for (;;) {
      const after = last === null ? "" : `where: { id_gt: "${last}" }, `
      const page = (await graphql(url, `{ ${plural[entity]}(first: 1000, orderBy: id, ${after}${at}) { id ${selection} } }`))[plural[entity]]
      items.push(...page)
      if (page.length < 1000) return items
      last = page[page.length - 1].id
    }
  }

  // makes checks of the kinds integration/expected.js writes, against the entities as they were at a block
  const run = async (checks, at) => {
    for (const check of checks) {
      if (check.kind === "count") {
        const total = (await all(check.entity, "", at)).length
        if (total !== check.count) failures.push(`${check.entity}: ${total} entities, expected ${check.count}`)
        continue
      }

      const name = single[check.entity]
      if (check.kind === "absent") {
        const found = (await graphql(url, `{ ${name}(id: "${check.id}", ${at}) { id } }`))[name]
        if (found !== null) failures.push(`${check.entity} ${check.id}: exists, expected none`)
        continue
      }

      const selection = (await isReference(check.entity, check.field)) ? `${check.field} { id }` : check.field
      const found = (await graphql(url, `{ ${name}(id: "${check.id}", ${at}) { ${selection} } }`))[name]
      if (found === null) {
        failures.push(`${check.entity} ${check.id}: missing`)
      } else if (normalized(found[check.field]) !== check.value) {
        failures.push(`${check.entity} ${check.id} ${check.field}: ${normalized(found[check.field])}, expected ${check.value}`)
      }
    }
  }

  const at = `block: { number: ${head} }`
  const events = await decodedEvents(chain, scenario)
  // the graph-node indexes the scenario's own addresses, so nothing is renamed
  const checks = await expectations(chain, scenario, events, (address) => address.toLowerCase())
  await run(checks, at)

  const finalFailures = failures.length
  console.log(`${checks.length - finalFailures} of ${checks.length} checks agree with the chain at block ${head}`)

  /***************************************************/
  /*** Fields read from the contracts, when refreshed ***/
  /***************************************************/

  let refreshed = 0
  let unread = 0
  const same = (what, actual, expected) => {
    refreshed += 1
    if (normalized(actual) !== String(expected)) failures.push(`${what}: ${normalized(actual)}, expected ${expected}`)
  }
  const deploymentOf = {}
  const infoOf = (pool) => ({ address: deploymentOf[pool].poolInfoUtils, iface: INFO })
  const poolAt = (pool) => ({ address: pool, iface: POOL })

  const pools = await all(
    "Pool",
    `id updatedAtBlockNumber factory { id } quoteToken { id decimals } collateralToken { id decimals }
     poolSize debt inflator borrowRate rateAtTarget utilization lendRate quoteTokenBalance collateralBalance
     escrowedQuote availableQuote quoteSurplus quoteSurplusClaimable quoteSurplusLotRemaining
     collateralSurplus collateralSurplusClaimable collateralSurplusLotRemaining`,
    at
  )
  for (const pool of pools) {
    deploymentOf[pool.id] = scenario.deployments.find((deployment) => deployment.factory.address === pool.factory.id)
    const block = Number(pool.updatedAtBlockNumber)
    if (block === 0) {
      unread += 1
      continue
    }
    const what = (name) => `Pool ${pool.id} ${name} at block ${block}`
    const info = infoOf(pool.id)
    const [poolSize, inflator] = await chain.call(info, "poolLoansInfo", [pool.id], block)
    const [rate, , rateAtTarget] = await chain.call(poolAt(pool.id), "interestState", [], block)
    const [utilization] = await chain.call(poolAt(pool.id), "utilization", [], block)
    const [debt] = await chain.call(poolAt(pool.id), "debtInfo", [], block)
    const [escrowed] = await chain.call(poolAt(pool.id), "escrowedQuote", [], block)
    const [available] = await chain.call(info, "availableQuoteTokenAmount", [pool.id], block)
    const quoteSurplus = await chain.call(info, "poolQuoteSurplusInfo", [pool.id], block)
    const collateralSurplus = await chain.call(info, "poolCollateralSurplusInfo", [pool.id], block)
    const balance = async (token) =>
      (await chain.call({ address: token.id, iface: BALANCE }, "balanceOf", [pool.id], block))[0] * 10n ** BigInt(18 - token.decimals)

    same(what("poolSize"), pool.poolSize, decimal(poolSize))
    same(what("inflator"), pool.inflator, decimal(inflator))
    same(what("debt"), pool.debt, decimal(debt))
    same(what("borrowRate"), pool.borrowRate, decimal(rate))
    same(what("rateAtTarget"), pool.rateAtTarget, decimal(rateAtTarget))
    same(what("utilization"), pool.utilization, decimal(utilization))
    same(what("lendRate"), pool.lendRate, decimal(wmul(wmul(rate, LENDER_SHARE), utilization)))
    same(what("quoteTokenBalance"), pool.quoteTokenBalance, decimal(await balance(pool.quoteToken)))
    same(what("collateralBalance"), pool.collateralBalance, decimal(await balance(pool.collateralToken)))
    same(what("escrowedQuote"), pool.escrowedQuote, decimal(escrowed))
    same(what("availableQuote"), pool.availableQuote, decimal(available))
    same(what("quoteSurplus"), pool.quoteSurplus, decimal(quoteSurplus[0]))
    same(what("quoteSurplusClaimable"), pool.quoteSurplusClaimable, decimal(quoteSurplus[1]))
    same(what("quoteSurplusLotRemaining"), pool.quoteSurplusLotRemaining, decimal(quoteSurplus[2]))
    same(what("collateralSurplus"), pool.collateralSurplus, decimal(collateralSurplus[0]))
    same(what("collateralSurplusClaimable"), pool.collateralSurplusClaimable, decimal(collateralSurplus[1]))
    same(what("collateralSurplusLotRemaining"), pool.collateralSurplusLotRemaining, decimal(collateralSurplus[2]))
  }

  for (const bucket of await all("Bucket", `id pool { id } bucketIndex updatedAtBlockNumber bucketPrice deposit collateral lpb exchangeRate`, at)) {
    const block = Number(bucket.updatedAtBlockNumber)
    if (block === 0) {
      unread += 1
      continue
    }
    const what = (name) => `Bucket ${bucket.bucketIndex} of ${bucket.pool.id} ${name} at block ${block}`
    const [price, , , , exchangeRate] = await chain.call(infoOf(bucket.pool.id), "bucketInfo", [bucket.pool.id, bucket.bucketIndex], block)
    // the pool's own view of the bucket, not the reader's
    const [lp, collateral, deposit] = await chain.call(poolAt(bucket.pool.id), "bucketInfo", [bucket.bucketIndex], block)
    same(what("bucketPrice"), bucket.bucketPrice, decimal(price))
    same(what("deposit"), bucket.deposit, decimal(deposit))
    same(what("collateral"), bucket.collateral, decimal(collateral))
    same(what("lpb"), bucket.lpb, decimal(lp))
    same(what("exchangeRate"), bucket.exchangeRate, decimal(exchangeRate))
  }

  for (const lend of await all(
    "Lend",
    `id pool { id } bucketIndex lender updatedAtBlockNumber lpb lpbValueInQuote depositTime marked liveLpb fundedValueInQuote`,
    at
  )) {
    const block = Number(lend.updatedAtBlockNumber)
    const what = (name) => `Lend of ${lend.lender} in bucket ${lend.bucketIndex} of ${lend.pool.id} ${name} at block ${block}`
    const [lp, marked, liveLp, liveWorth, fundedWorth] = await chain.call(
      infoOf(lend.pool.id),
      "lenderPosition",
      [lend.pool.id, lend.bucketIndex, lend.lender],
      block
    )
    const [poolLp, depositTime] = await chain.call(poolAt(lend.pool.id), "lenderInfo", [lend.bucketIndex, lend.lender], block)
    same(what("lpb"), lend.lpb, decimal(poolLp))
    same(what("lpb, by the reader"), lend.lpb, decimal(lp))
    same(what("marked"), lend.marked, marked)
    same(what("liveLpb"), lend.liveLpb, decimal(liveLp))
    same(what("lpbValueInQuote"), lend.lpbValueInQuote, decimal(liveWorth + fundedWorth))
    same(what("fundedValueInQuote"), lend.fundedValueInQuote, decimal(fundedWorth))
    same(what("depositTime"), lend.depositTime, depositTime)
  }

  for (const loan of await all("Loan", `id pool { id } loanId status updatedAtBlockNumber t0debt collateralPledged t0Tp thresholdPrice`, at)) {
    const block = Number(loan.updatedAtBlockNumber)
    if (block === 0) {
      unread += 1
      continue
    }
    const what = (name) => `Loan ${loan.loanId} of ${loan.pool.id} ${name} at block ${block}`
    const [, t0Debt, collateral, t0Tp] = await chain.call(poolAt(loan.pool.id), "loanDetails", [loan.loanId], block)
    same(what("t0debt"), loan.t0debt, decimal(t0Debt))
    same(what("collateralPledged"), loan.collateralPledged, decimal(collateral))
    same(what("t0Tp"), loan.t0Tp, decimal(t0Tp))
    // t0Tp at the pool's inflator: a product of two 18-decimal numbers, of which a BigDecimal keeps 34 digits
    const [, inflator] = await chain.call(infoOf(loan.pool.id), "poolLoansInfo", [loan.pool.id], block)
    const product = t0Tp * inflator * 10n ** 4n
    const difference = scaled(loan.thresholdPrice) - product
    refreshed += 1
    if ((difference < 0n ? -difference : difference) * 10n ** 30n > product) {
      // written out in full: the exact product has more digits than `decimal` allows a BigDecimal
      const digits = product.toString().padStart(41, "0")
      failures.push(`${what("thresholdPrice")}: ${loan.thresholdPrice}, expected ${digits.slice(0, -40)}.${digits.slice(-40)}`)
    }
  }

  for (const lend of await all(
    "PositionLend",
    `id pool { id } bucketIndex updatedAtBlockNumber lpb lpbValueInQuote depositTime position { tokenId positionManager { id } }`,
    at
  )) {
    const block = Number(lend.updatedAtBlockNumber)
    const manager = { address: lend.position.positionManager.id, iface: MANAGER }
    const what = (name) => `PositionLend of token ${lend.position.tokenId} in bucket ${lend.bucketIndex} ${name} at block ${block}`
    const [lp, depositTime] = await chain.call(manager, "getPositionInfo", [lend.position.tokenId, lend.bucketIndex], block)
    const [, deposit, collateral, , exchangeRate] = await chain.call(infoOf(lend.pool.id), "bucketInfo", [lend.pool.id, lend.bucketIndex], block)
    same(what("lpb"), lend.lpb, decimal(lp))
    same(what("depositTime"), lend.depositTime, depositTime)
    // LP at the bucket's exchange rate, rounded down; nothing for a bucket that holds nothing
    const worth = deposit === 0n && collateral === 0n ? 0n : (lp * exchangeRate) / WAD
    same(what("lpbValueInQuote"), lend.lpbValueInQuote, decimal(worth))
  }

  const refreshedFailures = failures.length - finalFailures
  console.log(
    `${refreshed - refreshedFailures} of ${refreshed} refreshed fields agree with the chain at the block they were read in` +
      (unread === 0 ? "" : ` (${unread} entities have not been read from the contracts yet)`)
  )

  /******************************************/
  /*** Hostile tokens and arguments, local ***/
  /******************************************/

  const hostileFile = path.join(OUT, "hostile.json")
  if (!configFile && fs.existsSync(hostileFile)) {
    const hostile = JSON.parse(fs.readFileSync(hostileFile, "utf8"))
    if (meta.block.number < hostile.headBlock) {
      throw new Error(`the subgraph is at block ${meta.block.number}; the hostile transactions end at ${hostile.headBlock}`)
    }
    const before = failures.length
    await run(hostile.checks, `block: { number: ${hostile.headBlock} }`)
    console.log(
      `${hostile.checks.length - (failures.length - before)} of ${hostile.checks.length} checks hold after the hostile tokens and arguments, at block ${hostile.headBlock}`
    )
  }

  for (const failure of failures) console.error(failure)
  if (failures.length !== 0) process.exit(1)
}

main().catch((error) => {
  console.error(`reconcile: ${error.message}`)
  process.exit(1)
})
