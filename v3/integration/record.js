#!/usr/bin/env node
// Records the chain that integration/scenario.js built into a Matchstick test, so that the real
// sequence of events runs through the mappings wherever the tests run, with no chain needed.
//
//   node integration/record.js
//
// It reads integration/.out/scenario.json and the node at RPC_URL (default: the one the scenario
// used), and writes tests/recorded/local-chain.test.ts:
//
//   - every event the factories, pools and PositionManagers emitted, in order, with its real
//     block, timestamp, transaction hash and log index
//   - every contract read a handler can make, mocked with what the chain returned at the end of
//     the event's block: the state a handler's read sees on a graph-node. A read that reverted,
//     or whose contract had no code yet, is mocked as reverting.
//   - what the chain says the entities must hold once every event is handled: integration/expected.js
//
// The deployments' addresses are replaced by those of tests/fixtures/two-factories.json, the
// config the tests run under in CI. Everything is mocked, so an address is only a label.
const fs = require("fs")
const path = require("path")

const { ROOT, Chain, interfaceOf, loadAbi, plain } = require("./chain")
const { decodedEvents } = require("./events")
const { expectations } = require("./expected")

const OUT = path.join(__dirname, ".out")
const FIXTURE = "tests/fixtures/two-factories.json"
const TARGET = path.join(ROOT, "tests", "recorded", "local-chain.test.ts")

/***********/
/*** ABI ***/
/***********/

// the type as it appears in a signature, with a tuple written out
function typeOf(param) {
  if (param.type.startsWith("tuple")) {
    return "(" + param.components.map(typeOf).join(",") + ")" + param.type.slice("tuple".length)
  }
  return param.type
}

const READS = {}
function read(key, abi, fn) {
  const entry = loadAbi(abi).find((candidate) => candidate.type === "function" && candidate.name === fn)
  if (!entry) throw new Error(`${abi} has no function ${fn}`)
  READS[key] = {
    key,
    fn,
    entry,
    iface: interfaceOf(abi),
    signature: `${fn}(${entry.inputs.map(typeOf).join(",")}):(${entry.outputs.map(typeOf).join(",")})`,
    constant: `SIG_${key.replace(/[A-Z]/g, (letter) => "_" + letter).toUpperCase()}`
  }
}
// every read the mappings make
read("loanTerm", "ERC20PoolFactory", "loanTerm")
read("name", "tokens/ERC20", "name")
read("symbol", "tokens/ERC20", "symbol")
read("decimals", "tokens/ERC20", "decimals")
read("totalT0Debt", "ERC20Pool", "totalT0Debt")
read("poolDetailsMulticall", "PoolInfoUtilsMulticall", "poolDetailsMulticall")
read("poolBalanceDetails", "PoolInfoUtilsMulticall", "poolBalanceDetails")
read("bucketInfo", "PoolInfoUtils", "bucketInfo")
read("bucketT0Debt", "ERC20Pool", "bucketT0Debt")
read("lenderPosition", "PoolInfoUtils", "lenderPosition")
read("lenderInfo", "ERC20Pool", "lenderInfo")
read("loanDetails", "ERC20Pool", "loanDetails")
read("getPositionInfo", "PositionManager", "getPositionInfo")

const BINDINGS = {
  factory: "../../generated/ERC20PoolFactory/ERC20PoolFactory",
  pool: "../../generated/templates/ERC20Pool/ERC20Pool",
  manager: "../../generated/PositionManager/PositionManager"
}
const MAPPINGS = {
  factory: "../../src/mappings/erc-20-pool-factory",
  pool: "../../src/mappings/erc-20-pool",
  manager: "../../src/mappings/position-manager"
}

async function main() {
  const scenario = JSON.parse(fs.readFileSync(path.join(OUT, "scenario.json"), "utf8"))
  const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, FIXTURE), "utf8"))
  const chain = new Chain(process.env.RPC_URL || scenario.rpcUrl)

  if (scenario.deployments.length !== fixture.deployments.length) {
    throw new Error(`${FIXTURE} must list as many deployments as the scenario made`)
  }

  // the scenario's deployments, under the fixture's addresses
  const aliases = {}
  scenario.deployments.forEach((deployment, i) => {
    const stand = fixture.deployments[i]
    aliases[deployment.factory.address] = stand.factory.address
    aliases[deployment.positionManager.address] = stand.positionManager.address
    aliases[deployment.poolInfoUtils] = stand.poolInfoUtils
    aliases[deployment.poolInfoUtilsMulticall] = stand.poolInfoUtilsMulticall
  })
  const alias = (address) => aliases[address.toLowerCase()] || address.toLowerCase()

  // Names for what the scenario named, so that the recording reads as the scenario does: a
  // constant for each account, pool, token, deployed contract and loan.
  const constants = new Map()
  const name = (value, constant) => constants.set(value.toLowerCase(), constant)
  for (const [account, address] of Object.entries(scenario.accounts)) name(address, account)
  for (const [pool, address] of Object.entries(scenario.pools)) name(address, pool)
  for (const [token, address] of Object.entries(scenario.tokens)) name(address, `${token}Token`)
  scenario.deployments.forEach((deployment, i) => {
    name(alias(deployment.factory.address), `factory${i + 1}`)
    name(alias(deployment.positionManager.address), `manager${i + 1}`)
    name(alias(deployment.poolInfoUtils), `info${i + 1}`)
    name(alias(deployment.poolInfoUtilsMulticall), `multicall${i + 1}`)
  })
  for (const [loan, loanId] of Object.entries(scenario.loans)) {
    name(loanId, `${loan}Loan`)
  }
  // the constant for an address or loan id, or the value itself in quotes
  const quoted = (value) => constants.get(value.toLowerCase()) || `"${value.toLowerCase()}"`
  const address = (value) => quoted(alias(value))

  // a value as the AssemblyScript that builds it
  function expression(param, value) {
    const type = param.type
    if (type === "address") return `A(${address(value)})`
    if (type === "bool") return `L(${value})`
    if (type === "string") return `S(${JSON.stringify(value)})`
    if (/^u?int\d*$/.test(type)) return `U("${value}")`
    if (/^bytes\d+$/.test(type)) return `F(${quoted(value)})`
    if (/^u?int\d*\[\]$/.test(type)) return `UA([${value.map((item) => `"${item}"`).join(", ")}])`
    if (type === "address[]") return `AA([${value.map((item) => address(item)).join(", ")}])`
    if (type === "tuple") return `T([${param.components.map((part, i) => expression(part, value[i])).join(", ")}])`
    throw new Error(`no expression for a value of type ${type}`)
  }

  /*****************************/
  /*** What the chain emitted ***/
  /*****************************/

  const events = await decodedEvents(chain, scenario)

  // what the mappings can read, as it becomes known from the events
  const known = {
    factories: scenario.deployments.map((deployment) => deployment.factory.address),
    tokens: new Set(),
    pools: {}, // address -> { deployment, buckets, lends, loans }
    positions: {} // manager -> token id -> { pool, indexes }
  }
  // the lenders whose position in a bucket an event's handler reads, with the buckets' parameters
  const LEND_PARAMS = {
    AddQuoteToken: { lenders: ["lender"], buckets: ["index"] },
    MoveQuoteToken: { lenders: ["lender"], buckets: ["from", "to"] },
    RemoveQuoteToken: { lenders: ["lender"], buckets: ["index"] },
    AddCollateral: { lenders: ["actor"], buckets: ["index"] },
    RemoveCollateral: { lenders: ["claimer"], buckets: ["index"] },
    MarkQuoteForWithdrawal: { lenders: ["lender"], buckets: ["index"] },
    TransferLP: { lenders: ["owner", "newOwner"], buckets: ["indexes"] }
  }
  const BUCKET_PARAMS = ["index", "from", "to", "bucketIndex", "fromBucketIndex", "toBucketIndex"]
  const LOAN_PARAMS = ["loanId", "fromLoanId", "toLoanId"]
  // the LP allowance events take any number as an index, and no handler reads a bucket for them
  const NO_BUCKETS = ["IncreaseLPAllowance", "DecreaseLPAllowance", "RevokeLPAllowance"]

  function learn(event) {
    const { name, args } = event
    if (event.kind === "factory") {
      known.pools[args.pool_.toLowerCase()] = {
        deployment: event.deployment,
        buckets: new Set(),
        lends: new Map(),
        loans: new Set()
      }
      known.tokens.add(args.collateral_.toLowerCase())
      known.tokens.add(args.quote_.toLowerCase())
    } else if (event.kind === "pool") {
      const pool = known.pools[event.address]
      if (!NO_BUCKETS.includes(name)) {
        for (const param of BUCKET_PARAMS) if (args[param] !== undefined) pool.buckets.add(args[param].toString())
        if (args.indexes !== undefined) for (const index of args.indexes) pool.buckets.add(index.toString())
      }
      const reads = LEND_PARAMS[name]
      if (reads !== undefined) {
        for (const lenderParam of reads.lenders) {
          for (const index of reads.buckets.flatMap((bucketParam) => args[bucketParam])) {
            const lender = args[lenderParam].toLowerCase()
            pool.lends.set(`${index}|${lender}`, { index: index.toString(), lender })
          }
        }
      }
      for (const param of LOAN_PARAMS) if (args[param] !== undefined) pool.loans.add(args[param])
    } else {
      const positions = (known.positions[event.address] = known.positions[event.address] || {})
      if (name === "Mint") positions[args.tokenId.toString()] = { pool: args.pool.toLowerCase(), indexes: new Set() }
      const position = args.tokenId !== undefined ? positions[args.tokenId.toString()] : undefined
      if (position !== undefined) {
        const indexes = []
        if (args.indexes !== undefined) indexes.push(...args.indexes)
        if (args.fromIndex !== undefined) indexes.push(args.fromIndex, args.toIndex)
        for (const index of indexes) {
          position.indexes.add(index.toString())
          known.pools[position.pool].buckets.add(index.toString())
        }
      }
    }
  }

  // Every read the handlers of a block's events could make, given what is known so far. A pool is
  // only read by its own events, and its buckets also by the events of a position that holds LP
  // in it, so the rest is left as it was last mocked.
  function probes(blockEvents) {
    const list = []
    const add = (key, target, args) => list.push({ read: READS[key], target, args })
    for (const factory of known.factories) add("loanTerm", factory, [])
    for (const token of known.tokens) for (const key of ["name", "symbol", "decimals"]) add(key, token, [])

    const pools = new Set()
    const bucketsOnly = new Set()
    const managers = new Set()
    for (const event of blockEvents) {
      if (event.kind === "factory") pools.add(event.args.pool_.toLowerCase())
      if (event.kind === "pool") pools.add(event.address)
      if (event.kind === "manager") {
        managers.add(event.address)
        const position =
          event.args.tokenId === undefined ? undefined : known.positions[event.address][event.args.tokenId.toString()]
        if (position !== undefined) bucketsOnly.add(position.pool)
      }
    }

    for (const [address, pool] of Object.entries(known.pools)) {
      const deployment = scenario.deployments[pool.deployment]
      if (pools.has(address) || bucketsOnly.has(address)) {
        for (const index of pool.buckets) {
          add("bucketInfo", deployment.poolInfoUtils, [address, index])
          add("bucketT0Debt", address, [index])
        }
      }
      if (!pools.has(address)) continue
      add("totalT0Debt", address, [])
      add("poolDetailsMulticall", deployment.poolInfoUtilsMulticall, [address])
      add("poolBalanceDetails", deployment.poolInfoUtilsMulticall, [address])
      for (const { index, lender } of pool.lends.values()) {
        add("lenderPosition", deployment.poolInfoUtils, [address, index, lender])
        add("lenderInfo", address, [index, lender])
      }
      for (const loanId of pool.loans) add("loanDetails", address, [loanId])
    }
    for (const manager of managers) {
      for (const [tokenId, position] of Object.entries(known.positions[manager] || {})) {
        for (const index of position.indexes) add("getPositionInfo", manager, [tokenId, index])
      }
    }
    return list
  }

  /*******************************/
  /*** Blocks: mocks and events ***/
  /*******************************/

  const byBlock = new Map()
  for (const event of events) {
    if (!byBlock.has(event.block)) byBlock.set(event.block, [])
    byBlock.get(event.block).push(event)
  }

  const blockFunctions = []
  const usedEvents = { factory: new Set(), pool: new Set(), manager: new Set() }
  const lastMocked = new Map() // mock -> the value it last returned
  let mockCount = 0
  let eventCount = 0

  for (const [block, blockEvents] of byBlock) {
    const lines = []

    // the events first: they say what there is to read in this block
    for (const event of blockEvents) learn(event)

    // what every read returns at the end of this block, mocked where it changed
    const wanted = probes(blockEvents)
    const answers = await chain.batch(
      wanted.map((probe) => ({
        method: "eth_call",
        params: [
          { to: probe.target, data: probe.read.iface.encodeFunctionData(probe.read.fn, probe.args) },
          "0x" + block.toString(16)
        ]
      }))
    )
    wanted.forEach((probe, i) => {
      const { read, target, args } = probe
      const argsCode = "[" + read.entry.inputs.map((input, k) => expression(input, args[k])).join(", ") + "]"
      const call = `${address(target)}, "${read.fn}", ${read.constant}, ${argsCode}`

      let outcome = "reverts"
      const answer = answers[i]
      // no code at the address answers with nothing, which a graph-node treats as a revert
      if (!answer.error && answer.result !== "0x") {
        const values = plain(read.iface.decodeFunctionResult(read.fn, answer.result))
        outcome = "[" + read.entry.outputs.map((output, k) => expression(output, values[k])).join(", ") + "]"
      }
      if (lastMocked.get(call) === outcome) return
      lastMocked.set(call, outcome)
      mockCount += 1
      lines.push(outcome === "reverts" ? `  reverts(${call})` : `  returns(${call}, ${outcome})`)
    })

    const timestamp = await chain.timestamp(block)
    for (const event of blockEvents) {
      usedEvents[event.kind].add(event.name)
      eventCount += 1
      const params = event.inputs.map((input) => `P("${input.name}", ${expression(input, event.args[input.name])})`)
      const className = event.kind === "manager" ? `Position${event.name}` : event.name
      lines.push(`  {`)
      lines.push(`    const e = changetype<${className}>(newMockEvent())`)
      lines.push(
        `    place(e, ${address(event.address)}, ${block}, "${timestamp}", "${event.transactionHash}", ` +
          `${event.logIndex}, [${params.join(", ")}])`
      )
      lines.push(`    handle${event.name}(e)`)
      lines.push(`  }`)
    }

    blockFunctions.push({ block, lines })
  }

  /********************/
  /*** Expectations ***/
  /********************/

  const checks = await expectations(chain, scenario, events, alias)
  const expected = checks.map((check) => {
    if (check.kind === "count") return `assert.entityCount("${check.entity}", ${check.count})`
    if (check.kind === "absent") return `assert.notInStore("${check.entity}", "${check.id}")`
    return `assert.fieldEquals("${check.entity}", "${check.id}", "${check.field}", ${JSON.stringify(check.value)})`
  })

  /*****************/
  /*** The test  ***/
  /*****************/

  const out = []
  out.push(`// GENERATED by integration/record.js from a chain built by integration/scenario.js.`)
  out.push(`// Do not edit: run scripts/local-chain.sh to build the chain again and record it.`)
  out.push(`//`)
  out.push(`// ${eventCount} events in ${blockFunctions.length} blocks, ${mockCount} contract reads mocked with what the chain returned at`)
  out.push(`// the end of each block, and ${expected.length} checks of the entities against the chain's final state.`)
  out.push(`// Contracts: ajna-v3 ${JSON.parse(fs.readFileSync(path.join(ROOT, "abis", "ajna-v3.lock.json"), "utf8")).commit}.`)
  out.push(`import { assert, clearStore, describe, log, newMockEvent, test } from "matchstick-as/assembly/index"`)
  out.push(``)
  for (const kind of ["factory", "pool", "manager"]) {
    const names = [...usedEvents[kind]].sort()
    // the manager's Transfer and Approval would read as the token events they are named after
    const imported = names.map((name) => (kind === "manager" ? `${name} as Position${name}` : name))
    out.push(`import { ${imported.join(", ")} } from "${BINDINGS[kind]}"`)
    out.push(`import { ${names.map((name) => `handle${name}`).join(", ")} } from "${MAPPINGS[kind]}"`)
  }
  out.push(`import { allDeployments } from "../../src/utils/deployments"`)
  out.push(`import { A, AA, F, L, P, S, T, U, UA, place, returns, reverts } from "../utils/replay"`)
  out.push(``)
  for (const read of Object.values(READS)) out.push(`const ${read.constant} = "${read.signature}"`)
  out.push(``)
  out.push(`// what the scenario deployed and who acted in it`)
  for (const [value, constant] of constants) out.push(`const ${constant} = "${value}"`)
  out.push(``)
  out.push(`// The recording stands on the deployments of ${FIXTURE}.`)
  out.push(`function configured(): boolean {`)
  out.push(`  const deployments = allDeployments()`)
  out.push(`  if (deployments.length != ${fixture.deployments.length}) return false`)
  fixture.deployments.forEach((deployment, i) => {
    out.push(`  if (deployments[${i}].factory.toHexString() != "${deployment.factory.address.toLowerCase()}") return false`)
  })
  out.push(`  return true`)
  out.push(`}`)
  for (const { block, lines } of blockFunctions) {
    out.push(``)
    out.push(`function block${block}(): void {`)
    out.push(...lines)
    out.push(`}`)
  }
  out.push(``)
  out.push(`function expectations(): void {`)
  out.push(...expected.map((line) => `  ${line}`))
  out.push(`}`)
  out.push(``)
  out.push(`describe("a recorded chain", () => {`)
  out.push(`  test("every event of the local scenario is handled, and the entities match the chain", () => {`)
  out.push(`    if (!configured()) {`)
  out.push(`      log.warning("skipped: the recording needs the deployments of ${FIXTURE}", [])`)
  out.push(`      return`)
  out.push(`    }`)
  for (const { block } of blockFunctions) out.push(`    block${block}()`)
  out.push(`    expectations()`)
  out.push(`    clearStore()`)
  out.push(`  })`)
  out.push(`})`)
  out.push(``)

  fs.mkdirSync(path.dirname(TARGET), { recursive: true })
  fs.writeFileSync(TARGET, out.join("\n"))
  console.log(
    `recorded ${eventCount} events in ${blockFunctions.length} blocks, ${mockCount} mocked reads and ` +
      `${expected.length} checks to ${path.relative(ROOT, TARGET)}`
  )
}

main().catch((error) => {
  console.error(`record: ${error.message}`)
  process.exit(1)
})
