// What the chain says the subgraph's entities must hold once every event of a scenario has been
// handled. It is worked out from the chain alone: its logs, and the contracts' own state at the
// last block. Nothing here comes from the mappings, so a difference is a fault in one or the other.
//
// Only what does not depend on when an entity was last refreshed is checked: which entities
// exist, how many events were recorded, and the fields that change only through events naming
// the entity, which must therefore equal the chain's final state exactly. Fields that drift
// between events, such as a bucket's deposit, are left to integration/reconcile.js, which reads
// the chain at the block each entity says it was refreshed in.
//
// Each check is one of
//   { kind: "count",  entity, count }
//   { kind: "field",  entity, id, field, value }
//   { kind: "absent", entity, id }
// with ids and values written as a graph-node returns them.
const { interfaceOf } = require("./chain")

const POOL = interfaceOf("ERC20Pool")
const FACTORY = interfaceOf("ERC20PoolFactory")
const MANAGER = interfaceOf("PositionManager")
const INFO = interfaceOf("PoolInfoUtils")
const TOKEN = interfaceOf("tokens/ERC20")

const ZERO_ADDRESS = "0x" + "00".repeat(20)
const LAST_BUCKET = 7388n

// the entity that records each event; the five LP rights events have none
const EVENT_ENTITY = {
  PoolCreated: "PoolCreated",
  AddCollateral: "AddCollateral",
  AddQuoteToken: "AddQuoteToken",
  MoveQuoteToken: "MoveQuoteToken",
  RemoveCollateral: "RemoveCollateral",
  RemoveQuoteToken: "RemoveQuoteToken",
  MarkQuoteForWithdrawal: "MarkQuoteForWithdrawal",
  ExitQueueFunded: "ExitQueueFunded",
  TransferLP: "TransferLP",
  DrawDebt: "DrawDebt",
  RepayDebt: "RepayDebt",
  MoveLoan: "MoveLoan",
  ImproveLoan: "ImproveLoan",
  LoanClosed: "LoanClosed",
  LoanCalled: "LoanCalled",
  SetBorrowerDelegates: "SetBorrowerDelegates",
  KickQuoteSurplusAuction: "SurplusAuctionKick",
  KickCollateralSurplusAuction: "SurplusAuctionKick",
  TakeQuoteSurplus: "SurplusAuctionTake",
  TakeCollateralSurplus: "SurplusAuctionTake",
  Flashloan: "Flashloan",
  UpdateInterestRate: "UpdateInterestRate",
  InterestUpdateFailure: "InterestUpdateFailure",
  Mint: "Mint",
  Burn: "Burn",
  MemorializePosition: "MemorializePosition",
  RedeemPosition: "RedeemPosition",
  MoveLiquidity: "MoveLiquidity",
  Transfer: "Transfer",
  Approval: "Approval",
  ApprovalForAll: "ApprovalForAll"
}

const utf8 = (text) => Buffer.from(text, "utf8").toString("hex")

// An integer of `decimals` decimals as graph-ts and graph-node print the BigDecimal: 1500000000000000000 is "1.5"
function decimal(value, decimals = 18) {
  const digits = value.toString().padStart(decimals + 1, "0")
  const whole = digits.slice(0, digits.length - decimals)
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "")
  const text = fraction === "" ? whole : `${whole}.${fraction}`
  if (text.replace(".", "").replace(/^0+/, "").length > 34) {
    throw new Error(`${text} has more digits than a BigDecimal keeps`)
  }
  return text
}

// the id of the entity that records an event: its transaction hash, then its log index as four
// bytes, lowest first
function eventId(event) {
  const index = event.logIndex.toString(16).padStart(8, "0")
  return event.transactionHash + index.match(/../g).reverse().join("")
}

async function expectations(chain, scenario, events, alias) {
  const head = scenario.headBlock
  const checks = []
  const field = (entity, id, name, value) => checks.push({ kind: "field", entity, id, field: name, value: String(value) })
  const absent = (entity, id) => checks.push({ kind: "absent", entity, id })
  const count = (entity, total) => checks.push({ kind: "count", entity, count: total })
  const read = (address, iface, fn, args = []) => chain.call({ address, iface }, fn, args, head)

  // ids, as the mappings build them
  const bucketId = (pool, index) => pool + utf8(`#${index}`)
  const lendId = (pool, index, lender) => bucketId(pool, index) + utf8("|") + alias(lender).slice(2)
  const loanEntityId = (pool, loanId) => pool + utf8("|") + loanId.slice(2)
  const positionId = (manager, tokenId) => alias(manager) + utf8(`|${tokenId}`)

  /******************************/
  /*** What the events mention ***/
  /******************************/

  const eventCounts = {}
  const pools = {}
  const managers = {}
  const tokens = {} // address -> number of pools using it
  const pairKey = (...parts) => parts.join("|")

  for (const event of events) {
    const { name, args } = event

    // a mint's and a burn's Transfer are recorded as Mint and Burn only
    const unrecorded =
      event.kind === "manager" && name === "Transfer" && (args.from === ZERO_ADDRESS || args.to === ZERO_ADDRESS)
    if (EVENT_ENTITY[name] && !unrecorded) eventCounts[EVENT_ENTITY[name]] = (eventCounts[EVENT_ENTITY[name]] || 0) + 1

    if (event.kind === "factory") {
      pools[args.pool_.toLowerCase()] = {
        deployment: event.deployment,
        collateral: args.collateral_.toLowerCase(),
        quote: args.quote_.toLowerCase(),
        buckets: new Set(),
        lends: new Map(),
        loans: new Map(),
        allowances: new Map(),
        transferors: new Map(),
        delegates: new Map(),
        marks: new Map(),
        kicks: { Quote: 0, Collateral: 0 },
        failures: 0,
        flashloaned: {}
      }
      for (const token of [args.collateral_, args.quote_]) tokens[token.toLowerCase()] = (tokens[token.toLowerCase()] || 0) + 1
      continue
    }

    if (event.kind === "manager") {
      const manager = (managers[event.address] = managers[event.address] || { deployment: event.deployment, tokens: new Map() })
      if (name === "Mint") manager.tokens.set(args.tokenId.toString(), { pool: args.pool.toLowerCase(), indexes: new Set() })
      const position = args.tokenId === undefined ? undefined : manager.tokens.get(args.tokenId.toString())
      if (position !== undefined) {
        for (const index of args.indexes || []) position.indexes.add(index)
        if (name === "MoveLiquidity") position.indexes.add(args.fromIndex).add(args.toIndex)
      }
      continue
    }

    const pool = pools[event.address]
    const lend = (index, lender) => pool.lends.set(pairKey(index, lender.toLowerCase()), { index, lender: lender.toLowerCase() })
    const loan = (loanId) => {
      if (!pool.loans.has(loanId)) pool.loans.set(loanId, {})
      return pool.loans.get(loanId)
    }
    const allowance = (owner, spender, index) =>
      pool.allowances.set(pairKey(owner, spender, index), { owner: owner.toLowerCase(), spender: spender.toLowerCase(), index })

    if (name === "AddQuoteToken" || name === "RemoveQuoteToken" || name === "MarkQuoteForWithdrawal") {
      pool.buckets.add(args.index)
      lend(args.index, args.lender)
      if (name === "MarkQuoteForWithdrawal") pool.marks.set(pairKey(args.index, args.lender), { index: args.index, lender: args.lender })
    } else if (name === "AddCollateral") {
      pool.buckets.add(args.index)
      lend(args.index, args.actor)
    } else if (name === "RemoveCollateral") {
      pool.buckets.add(args.index)
      lend(args.index, args.claimer)
    } else if (name === "MoveQuoteToken") {
      pool.buckets.add(args.from).add(args.to)
      lend(args.from, args.lender)
      lend(args.to, args.lender)
    } else if (name === "ExitQueueFunded") {
      pool.buckets.add(args.index)
    } else if (name === "TransferLP") {
      for (const index of args.indexes) {
        lend(index, args.owner)
        lend(index, args.newOwner)
        allowance(args.owner, args.newOwner, index)
      }
    } else if (name === "DrawDebt" || name === "RepayDebt") {
      pool.buckets.add(args.bucketIndex)
      loan(args.loanId)
    } else if (name === "MoveLoan") {
      pool.buckets.add(args.fromBucketIndex).add(args.toBucketIndex)
      loan(args.fromLoanId)
      // a loan the pool has not named before was opened by this move
      if (!pool.loans.has(args.toLoanId)) loan(args.toLoanId).movedFrom = args.fromLoanId
    } else if (name === "LoanCalled") {
      loan(args.loanId).call = eventId(event)
    } else if (name === "SetBorrowerDelegates") {
      for (const delegate of args.delegates) {
        pool.delegates.set(pairKey(args.borrower, delegate), { borrower: args.borrower.toLowerCase(), delegate: delegate.toLowerCase() })
      }
    } else if (name === "ApproveLPTransferors" || name === "RevokeLPTransferors") {
      const lender = args.lender.toLowerCase()
      if (!pool.transferors.has(lender)) pool.transferors.set(lender, [])
      for (const transferor of args.transferors) {
        if (!pool.transferors.get(lender).includes(transferor.toLowerCase())) pool.transferors.get(lender).push(transferor.toLowerCase())
      }
    } else if (name === "IncreaseLPAllowance" || name === "DecreaseLPAllowance" || name === "RevokeLPAllowance") {
      for (const index of args.indexes) allowance(args.owner, args.spender, index)
    } else if (name === "KickQuoteSurplusAuction") {
      pool.kicks.Quote += 1
    } else if (name === "KickCollateralSurplusAuction") {
      pool.kicks.Collateral += 1
    } else if (name === "Flashloan") {
      const token = args.token.toLowerCase()
      pool.flashloaned[token] = (pool.flashloaned[token] || 0n) + args.amount
    } else if (name === "InterestUpdateFailure") {
      pool.failures += 1
    }
  }

  for (const entity of [...new Set(Object.values(EVENT_ENTITY))].sort()) count(entity, eventCounts[entity] || 0)

  /*****************************/
  /*** Factories and tokens  ***/
  /*****************************/

  count("PoolFactory", scenario.deployments.length)
  for (const [i, deployment] of scenario.deployments.entries()) {
    const factory = deployment.factory.address
    const [loanTerm] = await read(factory, FACTORY, "loanTerm")
    const [deployed] = await read(factory, FACTORY, "getNumberOfDeployedPools")
    field("PoolFactory", alias(factory), "loanTerm", loanTerm)
    field("PoolFactory", alias(factory), "poolCount", deployed)
    const indexed = Object.values(pools).filter((pool) => pool.deployment === i).length
    if (BigInt(indexed) !== deployed) throw new Error(`factory ${factory} deployed ${deployed} pools but emitted ${indexed} PoolCreated`)
  }

  count("Token", Object.keys(tokens).length)
  const decimalsOf = {}
  for (const [token, poolCount] of Object.entries(tokens)) {
    const [name] = await read(token, TOKEN, "name")
    const [symbol] = await read(token, TOKEN, "symbol")
    const [decimals] = await read(token, TOKEN, "decimals")
    decimalsOf[token] = Number(decimals)
    field("Token", token, "name", name)
    field("Token", token, "symbol", symbol)
    field("Token", token, "decimals", Number(decimals))
    field("Token", token, "poolCount", poolCount)
  }

  /*************/
  /*** Pools ***/
  /*************/

  count("Pool", Object.keys(pools).length)
  let lendCount = 0
  let placeCount = 0
  let allowanceCount = 0
  let delegateCount = 0
  let transferorListCount = 0
  let loanCount = 0
  let auctionCount = 0

  for (const [address, pool] of Object.entries(pools)) {
    const deployment = scenario.deployments[pool.deployment]
    const [loanTerm] = await read(deployment.factory.address, FACTORY, "loanTerm")
    field("Pool", address, "factory", alias(deployment.factory.address))
    field("Pool", address, "loanTerm", loanTerm)
    field("Pool", address, "collateralToken", pool.collateral)
    field("Pool", address, "quoteToken", pool.quote)

    // totals the subgraph adds up from events, against the pool's own
    field("Pool", address, "pledgedCollateral", decimal((await read(address, POOL, "pledgedCollateral"))[0]))
    field("Pool", address, "lenderCollateral", decimal((await read(address, POOL, "lenderCollateral"))[0]))
    field("Pool", address, "t0debt", decimal((await read(address, POOL, "totalT0Debt"))[0]))
    field("Pool", address, "interestUpdateFailures", pool.failures)
    field("Pool", address, "quoteTokenFlashloaned", decimal(pool.flashloaned[pool.quote] || 0n, decimalsOf[pool.quote]))
    field("Pool", address, "collateralFlashloaned", decimal(pool.flashloaned[pool.collateral] || 0n, decimalsOf[pool.collateral]))

    // surplus auctions: the pool keeps its latest lot of each kind, and what its takes have burned in all
    let burned = 0n
    for (const [kind, getter] of [["Quote", "quoteSurplusInfo"], ["Collateral", "collateralSurplusInfo"]]) {
      const [unclaimed, kicked, lastKickedSurplus, ajnaBurned] = await read(address, POOL, getter)
      burned += ajnaBurned
      auctionCount += pool.kicks[kind]
      if ((kicked !== 0n) !== (pool.kicks[kind] !== 0)) throw new Error(`pool ${address}: ${kind} kicks and the pool's kick time disagree`)
      if (kicked === 0n) continue
      const auctionId = address + utf8(`|${kind}|${kicked}`)
      field("Pool", address, kind === "Quote" ? "quoteSurplusAuction" : "collateralSurplusAuction", auctionId)
      field("SurplusAuction", auctionId, "kind", kind)
      field("SurplusAuction", auctionId, "kickTime", kicked)
      field("SurplusAuction", auctionId, "lot", decimal(lastKickedSurplus))
      field("SurplusAuction", auctionId, "lotRemaining", decimal(unclaimed))
    }
    field("Pool", address, "totalAjnaBurned", decimal(burned))

    // buckets: debt, and the exit queue, which follows events alone
    const [info] = [{ address: deployment.poolInfoUtils, iface: INFO }]
    for (const index of pool.buckets) {
      const id = bucketId(address, index)
      const [, , , queueHead, queueTail, escrowQuote, escrowCollateral] = await read(address, POOL, "lenderExit", [index, ZERO_ADDRESS])
      field("Bucket", id, "bucketIndex", index)
      field("Bucket", id, "bucketPrice", decimal((await chain.call(info, "indexToPrice", [index], head))[0]))
      field("Bucket", id, "t0debt", decimal((await read(address, POOL, "bucketT0Debt", [index]))[0]))
      field("Bucket", id, "queueHead", decimal(queueHead))
      field("Bucket", id, "queueTail", decimal(queueTail))
      field("Bucket", id, "escrowQuote", decimal(escrowQuote))
      field("Bucket", id, "escrowCollateral", decimal(escrowCollateral))
    }

    // lends: one for each lender with LP in a bucket, and none for a lender who has left it
    for (const { index, lender } of pool.lends.values()) {
      const id = lendId(address, index, lender)
      const [lp, depositTime] = await read(address, POOL, "lenderInfo", [index, lender])
      if (lp === 0n) {
        absent("Lend", id)
        continue
      }
      lendCount += 1
      const [marked] = await read(address, POOL, "lenderExit", [index, lender])
      field("Lend", id, "lender", alias(lender))
      field("Lend", id, "bucketIndex", index)
      field("Lend", id, "lpb", decimal(lp))
      field("Lend", id, "depositTime", depositTime)
      field("Lend", id, "marked", marked)
    }

    // exit queue places: one for each lender who is still marked
    for (const { index, lender } of pool.marks.values()) {
      const id = lendId(address, index, lender)
      const [marked, queueStart] = await read(address, POOL, "lenderExit", [index, lender])
      if (!marked) {
        absent("ExitQueuePlace", id)
        continue
      }
      placeCount += 1
      const [lp] = await read(address, POOL, "lenderInfo", [index, lender])
      field("ExitQueuePlace", id, "queueStartWad", queueStart)
      field("ExitQueuePlace", id, "lpbWad", lp)
    }

    // loans: every loan the pool has named is kept, in the state the pool holds it in
    let withDebt = 0
    for (const [loanId, noted] of pool.loans) {
      loanCount += 1
      const id = loanEntityId(address, loanId)
      const [, t0Debt, collateral, t0Tp, bucketIndex, expiry, inflatorAtDraw] = await read(address, POOL, "loanDetails", [loanId])
      const status = t0Debt !== 0n ? "Active" : collateral !== 0n ? "DebtFree" : "Closed"
      if (t0Debt !== 0n) withDebt += 1
      field("Loan", id, "loanId", loanId)
      field("Loan", id, "borrower", loanId.slice(0, 42))
      field("Loan", id, "counter", BigInt("0x" + loanId.slice(42)))
      field("Loan", id, "status", status)
      field("Loan", id, "t0debt", decimal(t0Debt))
      field("Loan", id, "collateralPledged", decimal(collateral))
      field("Loan", id, "t0Tp", decimal(t0Tp))
      if (status !== "Closed") {
        field("Loan", id, "bucketIndex", bucketIndex)
        field("Loan", id, "expiry", expiry)
        field("Loan", id, "inflatorAtDraw", decimal(inflatorAtDraw))
      }
      if (noted.movedFrom) field("Loan", id, "movedFrom", loanEntityId(address, noted.movedFrom))
      if (noted.call) field("Loan", id, "call", noted.call)
    }
    field("Pool", address, "loansCount", withDebt)

    // borrower delegates, LP transferors and LP allowances: those the pool still holds
    for (const { borrower, delegate } of pool.delegates.values()) {
      const id = address + utf8("|") + borrower.slice(2) + utf8("|") + delegate.slice(2)
      const [approved] = await read(address, POOL, "approvedBorrowerDelegates", [borrower, delegate])
      if (approved) {
        delegateCount += 1
        field("BorrowerDelegate", id, "delegate", delegate)
      } else {
        absent("BorrowerDelegate", id)
      }
    }
    for (const [lender, candidates] of pool.transferors) {
      const id = address + utf8("|") + lender.slice(2)
      const approved = []
      for (const transferor of candidates) {
        if ((await read(address, POOL, "approvedTransferors", [lender, transferor]))[0]) approved.push(alias(transferor))
      }
      if (approved.length === 0) {
        absent("LPTransferorList", id)
      } else {
        transferorListCount += 1
        field("LPTransferorList", id, "transferors", `[${approved.join(", ")}]`)
      }
    }
    for (const { owner, spender, index } of pool.allowances.values()) {
      const listId = address + utf8("|") + alias(owner).slice(2) + utf8("|") + alias(spender).slice(2)
      const id = listId + utf8(`|${index}`)
      const [amount] = await read(address, POOL, "lpAllowance", [index, spender, owner])
      // the pool accepts an allowance at an index that is no bucket, which the subgraph does not store
      if (amount === 0n || index > LAST_BUCKET) {
        absent("LPAllowance", id)
      } else {
        allowanceCount += 1
        field("LPAllowance", id, "amountWad", amount)
        field("LPAllowance", id, "index", index)
      }
    }
  }

  count("Lend", lendCount)
  count("ExitQueuePlace", placeCount)
  count("Loan", loanCount)
  count("BorrowerDelegate", delegateCount)
  count("LPTransferorList", transferorListCount)
  count("LPAllowance", allowanceCount)
  count("SurplusAuction", auctionCount)

  /*****************/
  /*** Positions ***/
  /*****************/

  count("PositionManager", Object.keys(managers).length)
  let positionCount = 0
  let positionLendCount = 0
  for (const [address, manager] of Object.entries(managers)) {
    let live = 0
    for (const [tokenId, position] of manager.tokens) {
      const id = positionId(address, tokenId)
      const [pool] = await read(address, MANAGER, "poolKey", [tokenId])
      const burned = pool === ZERO_ADDRESS
      if (burned) {
        absent("Position", id)
      } else {
        live += 1
        const [owner] = await read(address, MANAGER, "ownerOf", [tokenId])
        field("Position", id, "positionManager", alias(address))
        field("Position", id, "tokenId", tokenId)
        field("Position", id, "pool", pool.toLowerCase())
        field("Position", id, "owner", alias(owner))
      }
      for (const index of position.indexes) {
        const lendEntityId = id + utf8(`|${index}`)
        const [lp, depositTime] = await read(address, MANAGER, "getPositionInfo", [tokenId, index])
        if (lp === 0n) {
          absent("PositionLend", lendEntityId)
        } else {
          positionLendCount += 1
          field("PositionLend", lendEntityId, "position", id)
          field("PositionLend", lendEntityId, "bucketIndex", index)
          field("PositionLend", lendEntityId, "lpb", decimal(lp))
          field("PositionLend", lendEntityId, "depositTime", depositTime)
        }
      }
    }
    positionCount += live
    field("PositionManager", alias(address), "factory", alias(scenario.deployments[manager.deployment].factory.address))
    field("PositionManager", alias(address), "positionCount", live)
  }
  count("Position", positionCount)
  count("PositionLend", positionLendCount)

  return checks
}

module.exports = { decimal, expectations }
