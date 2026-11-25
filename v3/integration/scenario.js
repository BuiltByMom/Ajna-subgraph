#!/usr/bin/env node
// Deploys the Ajna v3 contracts to a fresh development chain and drives them through everything
// the subgraph indexes, so that a graph-node pointed at the chain has every kind of event to
// handle, in the orders and block arrangements that matter to the mappings.
//
//   node integration/scenario.js <ajna-v3 checkout>
//
// The checkout must hold built artifacts (forge_out) for the contracts and for the two test
// helpers used here, Tokens.sol and FlashloanBorrower.sol: scripts/local-chain.sh builds them.
// RPC_URL names the node (default http://127.0.0.1:8545), which must be at block 0 and have
// unlocked accounts, as anvil has. NETWORK is the network name written to the config (default anvil).
//
// It writes, to integration/.out/:
//   local.json     the subgraph config for the chain: `yarn configure integration/.out/local.json`
//   scenario.json  what was deployed and done, for integration/reconcile.js
//
// and fails if any event the subgraph has a handler for was not emitted.
const fs = require("fs")
const path = require("path")

const { ROOT, Chain, artifact, errorNames, interfaceOf, loadAbi, wad } = require("./chain")

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545"
const NETWORK = process.env.NETWORK || "anvil"
const OUT = path.join(__dirname, ".out")

const MAX = (1n << 256n) - 1n
const NO_EXPIRY = 1n << 200n
const ANY_BUCKET = 7388n // the pool takes the last index to mean "the loan's own bucket"
const MINUTES = 60
const HOURS = 60 * MINUTES
const DAYS = 24 * HOURS
const FIVE_PERCENT = wad("0.05")

// four buckets, priced at about 1.32, 1, 0.80 and 0.63 quote per collateral
const I1 = 4100n
const I2 = 4156n
const I3 = 4200n
const I4 = 4250n

const POOL = interfaceOf("ERC20Pool")
const FACTORY = interfaceOf("ERC20PoolFactory")
const MANAGER = interfaceOf("PositionManager")
const INFO = interfaceOf("PoolInfoUtils")

function log(message) {
  console.log(message)
}

async function main() {
  const checkoutArg = process.argv[2]
  if (!checkoutArg) throw new Error("usage: scenario.js <ajna-v3 checkout>")
  const checkout = path.resolve(checkoutArg)

  const chain = new Chain(RPC_URL, errorNames(["ERC20Pool", "ERC20PoolFactory", "PositionManager"]))
  if ((await chain.blockNumber()) !== 0) {
    throw new Error(`${RPC_URL} is not a fresh chain: restart it, so that addresses and blocks come out the same`)
  }
  // with a fixed genesis time (scripts/local-chain.sh), every run then produces the same chain
  await chain.useFixedClock()
  const accounts = (await chain.rpc("eth_accounts")).map((account) => account.toLowerCase())
  const [deployer, lenderA, lenderB, borrowerA, borrowerB, keeper, delegate, positionOwner, positionBuyer, other] =
    accounts

  /***************/
  /*** Helpers ***/
  /***************/

  const pool = (address) => ({ address, iface: POOL })
  const send = (from, contract, fn, args) => chain.send(from, contract, fn, args)

  // mints `units` whole tokens to an account and lets `spender` take any amount of them
  const decimalsOf = {}
  async function fund(account, token, units, spender) {
    await send(deployer, token, "mint", [account, BigInt(units) * 10n ** BigInt(decimalsOf[token.address])])
    await send(account, token, "approve", [spender, MAX])
  }

  let info // PoolInfoUtils of the first deployment: its price function is the same for every pool
  // Collateral that covers `debt` quote at `factor` times the 1.05 the pool requires, in a bucket,
  // rounded up to the collateral token's precision. All three are WADs.
  async function collateralFor(debt, index, factor, collateralDecimals) {
    const [price] = await chain.call(info, "indexToPrice", [index])
    const scale = 10n ** BigInt(18 - collateralDecimals)
    const needed = (debt * wad("1.05") * factor) / (price * wad(1)) + wad(1) / 1_000_000n
    return (needed / scale + 1n) * scale
  }

  const loanDetails = async (poolAddress, loanId) => {
    const [, t0Debt, collateral, , bucketIndex, expiry] = await chain.call(pool(poolAddress), "loanDetails", [loanId])
    return { t0Debt, collateral, bucketIndex, expiry }
  }

  /*******************/
  /*** Deployments ***/
  /*******************/

  log("deploying tokens and contracts")
  const Token = artifact(checkout, "Tokens.sol", "Token")
  const TokenWithNDecimals = artifact(checkout, "Tokens.sol", "TokenWithNDecimals")
  async function deployToken(name, symbol, decimals) {
    const token = await chain.deploy(deployer, TokenWithNDecimals, [name, symbol, decimals])
    decimalsOf[token.address] = decimals
    return token
  }
  const ajna = await chain.deploy(deployer, Token, ["Ajna", "AJNA"])
  decimalsOf[ajna.address] = 18
  const coll = await deployToken("Wrapped Collateral", "WCOL", 18)
  const quote = await deployToken("Quote Dollar", "QUSD", 6)
  const coll8 = await deployToken("Eight Decimal Collateral", "COL8", 8)
  const quote18 = await deployToken("Eighteen Decimal Quote", "Q18", 18)

  const libraries = {}
  for (const name of ["BorrowerActions", "CallerActions", "LPActions", "LenderActions", "PoolCommons", "SurplusActions"]) {
    libraries[name] = (await chain.deploy(deployer, artifact(checkout, `${name}.sol`, name))).address
  }
  libraries.PositionNFTSVG = (
    await chain.deploy(deployer, artifact(checkout, "PositionNFTSVG.sol", "PositionNFTSVG"))
  ).address

  const built = {
    factory: artifact(checkout, "ERC20PoolFactory.sol", "ERC20PoolFactory"),
    info: artifact(checkout, "PoolInfoUtils.sol", "PoolInfoUtils"),
    multicall: artifact(checkout, "PoolInfoUtilsMulticall.sol", "PoolInfoUtilsMulticall"),
    manager: artifact(checkout, "PositionManager.sol", "PositionManager")
  }

  // The 30-day deployment, in the order the README asks for: the readers before the factory.
  const d30 = { description: "30-day loan term" }
  d30.info = await chain.deploy(deployer, built.info, [], libraries)
  d30.multicall = await chain.deploy(deployer, built.multicall, [d30.info.address])
  d30.factory = await chain.deploy(deployer, built.factory, [ajna.address, 30 * DAYS], libraries)
  d30.manager = await chain.deploy(deployer, built.manager, [d30.factory.address], libraries)
  info = { address: d30.info.address, iface: INFO }

  async function deployPool(deployment, collateralToken, quoteToken, rateAtTarget = FIVE_PERCENT) {
    const args = [collateralToken.address, quoteToken.address, rateAtTarget]
    const { returned } = await send(deployer, { address: deployment.factory.address, iface: FACTORY }, "deployPool", args)
    return returned[0].toLowerCase()
  }
  const P1 = await deployPool(d30, coll, quote) // 18-decimal collateral, 6-decimal quote
  // 8-decimal collateral and 18-decimal quote, at the highest rate a pool can start with, which
  // the last stage relies on
  const P2 = await deployPool(d30, coll8, quote18, wad(2))

  // The 7-day deployment the other way round, as on Sepolia: its factory first. A pool is created
  // and deposited into before the readers exist, so the subgraph has to index a deposit whose
  // bucket and lend it cannot read yet.
  const d7 = { description: "7-day loan term, readers deployed after the first deposit" }
  d7.factory = await chain.deploy(deployer, built.factory, [ajna.address, 7 * DAYS], libraries)
  const P3 = await deployPool(d7, coll, quote) // the same pair as P1, under another factory
  await fund(lenderA, quote, 1_000_000, P3)
  await send(lenderA, pool(P3), "addQuoteToken", [wad(1000), I2, NO_EXPIRY])
  const unreadableBlock = await chain.blockNumber()
  d7.info = await chain.deploy(deployer, built.info, [], libraries)
  d7.multicall = await chain.deploy(deployer, built.multicall, [d7.info.address])
  d7.manager = await chain.deploy(deployer, built.manager, [d7.factory.address], libraries)

  const manager30 = { address: d30.manager.address, iface: MANAGER }
  const manager7 = { address: d7.manager.address, iface: MANAGER }

  /****************************/
  /*** P1: lenders and loans ***/
  /****************************/

  log("P1: deposits")
  for (const lender of [lenderA, lenderB, positionOwner, other]) await fund(lender, quote, 1_000_000, P1)
  await send(lenderA, pool(P1), "addQuoteToken", [wad(10_000), I2, NO_EXPIRY])
  await send(lenderB, pool(P1), "addQuoteToken", [wad(5000), I2, NO_EXPIRY])
  await send(lenderA, pool(P1), "addQuoteToken", [wad(8000), I1, NO_EXPIRY])
  await send(lenderB, pool(P1), "addQuoteToken", [wad(3000), I3, NO_EXPIRY])
  await send(positionOwner, pool(P1), "addQuoteToken", [wad(2000), I1, NO_EXPIRY])
  await send(positionOwner, pool(P1), "addQuoteToken", [wad(500), I3, NO_EXPIRY])
  await send(positionOwner, pool(P1), "addQuoteToken", [wad(1000), I4, NO_EXPIRY])

  // collateral lent directly into a bucket, and part of it taken back
  await fund(lenderA, coll, 1_000_000, P1)
  await send(lenderA, pool(P1), "addCollateral", [wad(2), I3, NO_EXPIRY])
  await send(lenderA, pool(P1), "removeCollateral", [wad(1), I3])

  // P2 and P3 get deposits now, so that they have matured by the time they are borrowed
  await fund(lenderA, quote18, 1_000_000, P2)
  await send(lenderA, pool(P2), "addQuoteToken", [wad(5000), I2, NO_EXPIRY])

  // a deposit can fund loans from the second ten-minute epoch after it
  await chain.advance(30 * MINUTES)

  await send(lenderA, pool(P1), "moveQuoteToken", [wad(2000), I1, I2, NO_EXPIRY])
  // P3 again, now that its readers exist: the bucket and lend it could not read catch up
  await send(lenderA, pool(P3), "addQuoteToken", [wad(250), I2, NO_EXPIRY])

  log("P1: loans")
  for (const borrower of [borrowerA, borrowerB, delegate, other]) {
    await fund(borrower, coll, 1_000_000, P1)
    await fund(borrower, quote, 1_000_000, P1)
  }
  const draw = async (from, borrower, poolAddress, amount, index, pledge, closing = "0x" + "00".repeat(32)) => {
    const { returned } = await send(from, pool(poolAddress), "drawDebt", [borrower, amount, index, pledge, closing])
    return returned[1]
  }
  const loans = {}
  // roomy: half as much collateral again as the pool requires
  loans.roomy = await draw(borrowerA, borrowerA, P1, wad(6000), I2, await collateralFor(wad(6000), I2, wad("1.5"), 18))
  // tight: only just collateralized
  loans.tight = await draw(borrowerB, borrowerB, P1, wad(4000), I2, await collateralFor(wad(4000), I2, wad(1), 18))
  const repaidPledge = await collateralFor(wad(1000), I1, wad("1.5"), 18)
  loans.repaid = await draw(borrowerA, borrowerA, P1, wad(1000), I1, repaidPledge)
  loans.improved = await draw(borrowerB, borrowerB, P1, wad(2000), I3, await collateralFor(wad(2000), I3, wad("1.2"), 18))

  // a delegate borrows against the borrower's name, with its own collateral
  await send(borrowerA, pool(P1), "setBorrowerDelegates", [[delegate, other], true])
  await send(borrowerA, pool(P1), "setBorrowerDelegates", [[other], false])
  loans.moved = await draw(delegate, borrowerA, P1, wad(500), I2, await collateralFor(wad(500), I2, wad("1.5"), 18))

  // anyone can add collateral to a loan
  await send(other, pool(P1), "drawDebt", [borrowerA, 0n, ANY_BUCKET, wad("0.25"), loans.roomy])

  log("P1: exit queue")
  // an ordinary withdrawal, while the bucket has quote that is not lent out
  await send(lenderB, pool(P1), "removeQuoteToken", [wad(1000), I2])
  // Lender A asks to leave the bucket. Only the quote that is not lent out can pay for their LP
  // at once; the rest of their place waits on the queue.
  await send(lenderA, pool(P1), "markQuoteForWithdrawal", [I2])
  // a repayment into the bucket funds more of the place before the borrower's own event
  await send(borrowerB, pool(P1), "repayDebt", [borrowerB, wad(1000), 0n, borrowerB, ANY_BUCKET, loans.tight])

  log("P1: repay, redraw, move, improve")
  // repaid in full with half of its collateral pulled: the loan stays, debt-free
  await send(borrowerA, pool(P1), "repayDebt", [borrowerA, MAX, repaidPledge / 2n, borrowerA, ANY_BUCKET, loans.repaid])
  // a new loan that takes over the debt-free loan's collateral, which closes it
  loans.redrawn = await draw(borrowerA, borrowerA, P1, wad(500), I1, 0n, loans.repaid)
  // the borrower moves a whole loan to another bucket: a new loan, and the old one is closed
  {
    const args = [borrowerA, loans.moved, "0x" + "00".repeat(32), I1, MAX, MAX]
    loans.movedTo = (await send(borrowerA, pool(P1), "moveLoan", args)).returned[0]
  }
  // collateral alone moved between two of the borrower's loans
  await send(borrowerA, pool(P1), "moveLoan", [borrowerA, loans.roomy, loans.redrawn, ANY_BUCKET, 0n, wad("0.1")])
  // anyone can move a loan to a bucket with a higher price
  loans.improvedTo = (await send(keeper, pool(P1), "improveLoan", [loans.improved, I1])).returned[0]

  /******************************/
  /*** P1: LP rights, flashloan ***/
  /******************************/

  log("P1: LP allowances, transferors and transfers")
  await send(lenderB, pool(P1), "approveLPTransferors", [[delegate, keeper]])
  await send(lenderB, pool(P1), "revokeLPTransferors", [[delegate]])
  await send(lenderB, pool(P1), "increaseLPAllowance", [other, [I3], [wad(100)]])
  await send(lenderB, pool(P1), "decreaseLPAllowance", [other, [I3], [wad(40)]])
  await send(lenderB, pool(P1), "revokeLPAllowance", [other, [I3]])
  // the pool takes any number as an index here: one that is no bucket, and too large for an Int
  await send(lenderB, pool(P1), "increaseLPAllowance", [other, [1n << 40n, I3], [wad(1), wad(7)]])
  // a transfer naming a bucket where the owner holds LP and one where they hold none
  await send(lenderB, pool(P1), "increaseLPAllowance", [other, [I3, I4], [wad(1000), wad(5)]])
  await send(other, pool(P1), "transferLP", [lenderB, other, [I3, I4]])
  // a transfer that moves nothing at all
  await send(lenderB, pool(P1), "increaseLPAllowance", [other, [I4], [wad(5)]])
  await send(other, pool(P1), "transferLP", [lenderB, other, [I4]])
  // an allowance that is still standing at the end
  await send(lenderB, pool(P1), "increaseLPAllowance", [keeper, [I3], [wad("12.5")]])

  log("P1: flashloan")
  // the borrower contract approves the pool to take the loan back, in its callback
  const FlashloanBorrower = artifact(checkout, "FlashloanBorrower.sol", "FlashloanBorrower")
  const approvePool = quote.iface.encodeFunctionData("approve", [P1, MAX.toString()])
  const flashBorrower = await chain.deploy(deployer, FlashloanBorrower, [quote.address, approvePool])
  await send(keeper, pool(P1), "flashLoan", [flashBorrower.address, quote.address, 250_000_000n, "0x"])

  /*****************/
  /*** Positions ***/
  /*****************/

  log("positions")
  const positions = {}
  // The owner lets the manager take their LP in four buckets. They hold none in the last.
  await send(positionOwner, pool(P1), "increaseLPAllowance", [manager30.address, [I1, I3, I4, I2], [MAX, MAX, MAX, MAX]])
  await send(positionOwner, pool(P1), "approveLPTransferors", [[manager30.address]])
  positions.kept = (await send(positionOwner, manager30, "mint", [P1, positionOwner])).returned[0]
  await send(positionOwner, manager30, "memorializePositions", [P1, positions.kept, [I1, I3, I4, I2]])

  // debt drawn from the bucket the position has to itself, so that most of its quote there is lent out
  loans.fromPosition = await draw(borrowerB, borrowerB, P1, wad(800), I4, await collateralFor(wad(800), I4, wad("1.3"), 18))
  // a move that can only take the part that is not lent out, and leaves LP behind
  await send(positionOwner, manager30, "moveLiquidity", [P1, positions.kept, I4, I1, NO_EXPIRY])
  // a move that takes everything
  await send(positionOwner, manager30, "moveLiquidity", [P1, positions.kept, I3, I1, NO_EXPIRY])

  // approvals, then a sale: the buyer takes the NFT and redeems one of its buckets
  await send(positionOwner, manager30, "approve", [positionBuyer, positions.kept])
  await send(positionOwner, manager30, "setApprovalForAll", [delegate, true])
  await send(positionOwner, manager30, "setApprovalForAll", [delegate, false])
  await send(positionBuyer, manager30, "transferFrom", [positionOwner, positionBuyer, positions.kept])
  await send(positionBuyer, pool(P1), "approveLPTransferors", [[manager30.address]])
  await send(positionBuyer, manager30, "redeemPositions", [P1, positions.kept, [I1]])

  // a second position, filled, emptied and burned in separate blocks
  await send(positionOwner, pool(P1), "addQuoteToken", [wad(300), I3, NO_EXPIRY])
  await send(positionOwner, pool(P1), "increaseLPAllowance", [manager30.address, [I3], [MAX]])
  positions.burned = (await send(positionOwner, manager30, "mint", [P1, positionOwner])).returned[0]
  await send(positionOwner, manager30, "memorializePositions", [P1, positions.burned, [I3]])
  await send(positionOwner, manager30, "redeemPositions", [P1, positions.burned, [I3]])
  await send(positionOwner, manager30, "burn", [P1, positions.burned])

  // A third whose whole life is one transaction. Every read the subgraph makes for it returns
  // the state at the end of the block, when it no longer exists.
  await send(positionOwner, pool(P1), "increaseLPAllowance", [manager30.address, [I3], [MAX]])
  positions.oneBlock = positions.burned + 1n
  await send(positionOwner, manager30, "multicall", [
    [
      MANAGER.encodeFunctionData("mint", [P1, positionOwner]),
      MANAGER.encodeFunctionData("memorializePositions", [P1, positions.oneBlock.toString(), [I3.toString()]]),
      MANAGER.encodeFunctionData("redeemPositions", [P1, positions.oneBlock.toString(), [I3.toString()]]),
      MANAGER.encodeFunctionData("burn", [P1, positions.oneBlock.toString()])
    ]
  ])

  // the other manager numbers its own tokens from 1 too
  await send(lenderA, pool(P3), "increaseLPAllowance", [manager7.address, [I2], [MAX]])
  positions.otherManager = (await send(lenderA, manager7, "mint", [P3, lenderA])).returned[0]
  await send(lenderA, manager7, "memorializePositions", [P3, positions.otherManager, [I2]])

  /*****************************************/
  /*** Several events in one block or tx ***/
  /*****************************************/

  log("same-block cases")
  // A deposit withdrawn again in the same transaction: the lender holds nothing at the end of it.
  await fund(other, quote18, 1_000_000, P2)
  await send(other, pool(P2), "multicall", [
    [
      POOL.encodeFunctionData("addQuoteToken", [wad(500).toString(), I2.toString(), NO_EXPIRY.toString()]),
      POOL.encodeFunctionData("removeQuoteToken", [MAX.toString(), I2.toString()])
    ]
  ])
  // A loan drawn, repaid and emptied in one transaction: the pool has deleted it by the end.
  await fund(borrowerB, coll8, 1_000_000, P2)
  await fund(borrowerB, quote18, 1_000_000, P2)
  {
    const pledge = await collateralFor(wad(100), I2, wad("1.5"), 8)
    const [counter] = await chain.call(pool(P2), "nextLoanId")
    loans.oneBlock = "0x" + borrowerB.slice(2) + counter.toString(16).padStart(24, "0")
    const drawArgs = [borrowerB, wad(100).toString(), I2.toString(), pledge.toString(), "0x" + "00".repeat(32)]
    const repayArgs = [borrowerB, MAX.toString(), pledge.toString(), borrowerB, ANY_BUCKET.toString(), loans.oneBlock]
    await send(borrowerB, pool(P2), "multicall", [
      [POOL.encodeFunctionData("drawDebt", drawArgs), POOL.encodeFunctionData("repayDebt", repayArgs)]
    ])
  }
  // three accounts act on one pool in the same block
  const sharedBlock = await chain.inOneBlock(async () => {
    await send(lenderB, pool(P1), "addQuoteToken", [wad(200), I3, NO_EXPIRY])
    await send(other, pool(P1), "addCollateral", [wad("0.5"), I3, NO_EXPIRY])
    await send(borrowerA, pool(P1), "repayDebt", [borrowerA, wad(100), 0n, borrowerA, ANY_BUCKET, loans.roomy])
  })

  // a loan in the 8-decimal pool that is left open
  loans.eightDecimals = await draw(borrowerB, borrowerB, P2, wad(300), I2, await collateralFor(wad(300), I2, wad("1.4"), 8))

  /*********************************************/
  /*** Expiry: loan calls, claims, auctions  ***/
  /*********************************************/

  log("loan calls and exit claims")
  await chain.advance(31 * DAYS)
  await fund(keeper, ajna, 1_000_000_000, P1)
  // the tight loan: its collateral goes to the bucket's lenders, and funds the place on the queue
  await send(keeper, pool(P1), "callLoan", [loans.tight])
  // the roomy loan: lenders, caller and surplus are paid, and the borrower keeps the rest
  await send(keeper, pool(P1), "callLoan", [loans.roomy])
  {
    const left = (await loanDetails(P1, loans.roomy)).collateral
    if (left === 0n) throw new Error("the roomy loan was expected to keep collateral after its call")
    // the borrower takes back what the call left, which deletes the loan
    await send(borrowerA, pool(P1), "repayDebt", [borrowerA, 0n, left, borrowerA, ANY_BUCKET, loans.roomy])
  }
  // the marked lender claims what the queue set aside for them: collateral, then quote
  await send(lenderA, pool(P1), "removeCollateral", [MAX, I2])
  await send(lenderA, pool(P1), "removeQuoteToken", [MAX, I2])

  log("surplus auctions")
  // The pool's share of interest becomes quote surplus when the debt it accrued on is repaid. A
  // called loan pays its share in collateral instead, so a loan is repaid here, a month's
  // interest later, to give the quote auction something to sell.
  await send(borrowerB, pool(P1), "repayDebt", [borrowerB, MAX, 0n, borrowerB, ANY_BUCKET, loans.improvedTo])
  // both kinds kicked in one transaction
  await send(keeper, pool(P1), "multicall", [
    [POOL.encodeFunctionData("kickQuoteSurplusAuction", []), POOL.encodeFunctionData("kickCollateralSurplusAuction", [])]
  ])
  // the price of a whole lot starts at a billion AJNA and halves every hour
  await chain.advance(44 * HOURS)
  // a budget for about half of the quote lot buys part of it, and the rest is left for the next auction
  {
    const [, , lotRemaining, price] = await chain.call(info, "poolQuoteSurplusInfo", [P1])
    await send(keeper, pool(P1), "takeQuoteSurplus", [(lotRemaining * price) / wad(2), NO_EXPIRY])
  }
  await send(keeper, pool(P1), "takeCollateralSurplus", [MAX, NO_EXPIRY])
  // a kind can be kicked again five days after its last kick; the unsold quote rolls over
  await chain.advance(6 * DAYS)
  await send(other, pool(P1), "kickQuoteSurplusAuction", [])
  await chain.advance(46 * HOURS)
  await send(keeper, pool(P1), "takeQuoteSurplus", [MAX, NO_EXPIRY])

  // A lender who marks and does not claim: the quote that is not lent out funds their whole
  // place at once, and they stay on the queue, funded, until they come for it.
  await send(positionBuyer, pool(P1), "markQuoteForWithdrawal", [I1])

  /********************************/
  /*** A pool that cannot accrue ***/
  /********************************/

  log("interest update failure")
  // Far enough ahead that P2's interest no longer fits its arithmetic: the exponent of its rate
  // times the years elapsed overflows. The pool carries on without accruing and says so; the
  // readers, which project interest, can revert for it.
  await chain.advance(4000 * 365 * DAYS)
  await send(keeper, pool(P2), "updateInterest", [])
  await send(lenderA, pool(P2), "addQuoteToken", [wad(50), I3, NO_EXPIRY])

  /***************/
  /*** Outputs ***/
  /***************/

  const head = await chain.blockNumber()
  const deployments = [d30, d7].map((deployment) => ({
    description: deployment.description,
    factory: { address: deployment.factory.address, startBlock: deployment.factory.block },
    positionManager: { address: deployment.manager.address, startBlock: deployment.manager.block },
    poolInfoUtils: deployment.info.address,
    poolInfoUtilsMulticall: deployment.multicall.address
  }))

  // every event the subgraph has a handler for must have been emitted
  const sources = [
    { abi: "ERC20PoolFactory", addresses: [d30.factory.address, d7.factory.address] },
    { abi: "ERC20Pool", addresses: [P1, P2, P3] },
    { abi: "PositionManager", addresses: [d30.manager.address, d7.manager.address] }
  ]
  const counts = {}
  const missing = []
  for (const source of sources) {
    const iface = interfaceOf(source.abi)
    const names = {}
    for (const entry of loadAbi(source.abi)) {
      if (entry.type !== "event") continue
      names[iface.getEventTopic(entry.name)] = entry.name
      counts[`${source.abi}.${entry.name}`] = 0
    }
    for (const entry of await chain.logs(source.addresses, 0, head)) {
      counts[`${source.abi}.${names[entry.topics[0]]}`] += 1
    }
  }
  for (const [name, count] of Object.entries(counts)) {
    if (count === 0) missing.push(name)
  }

  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, "local.json"), JSON.stringify({ network: NETWORK, deployments }, null, 2) + "\n")
  const summary = {
    rpcUrl: RPC_URL,
    network: NETWORK,
    headBlock: head,
    deployments,
    tokens: { ajna: ajna.address, coll: coll.address, quote: quote.address, coll8: coll8.address, quote18: quote18.address },
    pools: { P1, P2, P3 },
    accounts: { deployer, lenderA, lenderB, borrowerA, borrowerB, keeper, delegate, positionOwner, positionBuyer, other },
    buckets: [I1, I2, I3, I4].map(Number),
    loans,
    positions: Object.fromEntries(Object.entries(positions).map(([name, tokenId]) => [name, tokenId.toString()])),
    blocks: { depositBeforeReaders: unreadableBlock, threeAccountsInOneBlock: sharedBlock },
    events: counts
  }
  fs.writeFileSync(path.join(OUT, "scenario.json"), JSON.stringify(summary, null, 2) + "\n")

  log(`\n${head} blocks, ${Object.values(counts).reduce((sum, count) => sum + count, 0)} events:`)
  for (const [name, count] of Object.entries(counts)) log(`  ${String(count).padStart(3)}  ${name}`)
  if (missing.length !== 0) {
    throw new Error(`the scenario did not emit: ${missing.join(", ")}`)
  }
  log(`\nwrote ${path.relative(ROOT, path.join(OUT, "local.json"))} and scenario.json`)
}

main().catch((error) => {
  console.error(`scenario: ${error.message}`)
  process.exit(1)
})
