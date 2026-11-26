import { afterEach, assert, beforeEach, clearStore, describe, test } from "matchstick-as/assembly/index"
import { Address, BigInt } from "@graphprotocol/graph-ts"

import {
  handleAddCollateral,
  handleAddQuoteToken,
  handleDrawDebt,
  handleExitQueueFunded,
  handleLoanCalled,
  handleLoanClosed,
  handleMarkQuoteForWithdrawal,
  handleRemoveCollateral,
  handleRemoveQuoteToken,
  handleRepayDebt
} from "../src/mappings/erc-20-pool"
import { Deployment, allDeployments } from "../src/utils/deployments"
import { getBucketId } from "../src/utils/pool/bucket"
import { getLendId } from "../src/utils/pool/lend"
import { getLoanEntityId } from "../src/utils/pool/loan"
import { THIRTY_DAYS, blockTimestamp, eventEntityId, loanId, testAddress, wad, wadOf } from "./utils/common"
import { createPool } from "./utils/erc-20-pool-factory-utils"
import {
  createAddCollateralEvent,
  createAddQuoteTokenEvent,
  createDrawDebtEvent,
  createExitQueueFundedEvent,
  createLoanCalledEvent,
  createLoanClosedEvent,
  createMarkQuoteForWithdrawalEvent,
  createRemoveCollateralEvent,
  createRemoveQuoteTokenEvent,
  createRepayDebtEvent
} from "./utils/erc-20-pool-utils"
import {
  BucketState,
  LenderState,
  LoanState,
  PoolSnapshot,
  markedLender,
  mockBucketInfo,
  mockDeletedLoan,
  mockLender,
  mockLoan,
  mockPoolSnapshot,
  unmarkedLender
} from "./utils/mock-contract-calls"

// These tests run against whichever config `yarn configure` last rendered, using its first
// deployment. CI runs them with tests/fixtures/two-factories.json.
//
// Handlers read contract state once per block, so each step that changes mocked state uses a
// new block number. Events placed in the same block belong to one transaction, and are given
// the log order the pool emits them in.

const POOL = testAddress(0x1000)
const COLLATERAL = testAddress(0x7000)
const QUOTE = testAddress(0x7001)
const LENDER = testAddress(0x8001)
const OTHER_LENDER = testAddress(0x8002)
const BORROWER = testAddress(0xb001)
const CREATED_AT = 100
const INDEX = 2550

function deployment(): Deployment {
  return allDeployments()[0]
}

function bucketId(): string {
  return getBucketId(POOL, INDEX).toHexString()
}

// a lender's Lend and their ExitQueuePlace share this id
function lendId(lender: Address): string {
  return getLendId(getBucketId(POOL, INDEX), lender).toHexString()
}

// the pool holding the given deposit and exit escrow
function mockPool(poolSize: BigInt, escrowedQuote: BigInt): void {
  const snapshot = new PoolSnapshot()
  snapshot.poolSize = poolSize
  snapshot.escrowedQuote = escrowedQuote
  mockPoolSnapshot(deployment().poolInfoUtilsMulticall, POOL, snapshot)
}

// the bucket at INDEX, priced at 100, at an exchange rate of 1
function mockBucket(deposit: BigInt, lp: BigInt, collateral: BigInt, t0debt: BigInt): void {
  const bucket = new BucketState()
  bucket.price = wad(100)
  bucket.deposit = deposit
  bucket.lp = lp
  bucket.collateral = collateral
  bucket.t0debt = t0debt
  mockBucketInfo(deployment().poolInfoUtils, POOL, INDEX, bucket)
}

function mockLenderState(lender: Address, state: LenderState): void {
  mockLender(deployment().poolInfoUtils, POOL, INDEX, lender, state)
}

// LENDER deposits 1000 quote into the bucket in block 101
function deposit1000(): void {
  mockPool(wad(1000), wad(0))
  mockBucket(wad(1000), wad(1000), wad(0), wad(0))
  mockLenderState(LENDER, unmarkedLender(wad(1000), wad(1000), blockTimestamp(101)))
  handleAddQuoteToken(createAddQuoteTokenEvent(POOL, 101, 0, LENDER, INDEX, wad(1000), wad(1000)))
}

// In block 102 LENDER marks their 1000 LP, and the bucket's idle quote funds all of it at once.
// The pool emits ExitQueueFunded before the mark that created the place.
function markAndFund1000(): void {
  mockPool(wad(0), wad(1000))
  mockBucket(wad(0), wad(0), wad(0), wad(0))
  mockLenderState(LENDER, markedLender(wad(1000), wad(0), wad(0), wad(1000), blockTimestamp(101)))
  handleExitQueueFunded(createExitQueueFundedEvent(POOL, 102, 0, INDEX, wad(1000), wad(1000), wad(0), wad(1000)))
  handleMarkQuoteForWithdrawal(createMarkQuoteForWithdrawalEvent(POOL, 102, 1, LENDER, INDEX, wad(1000), wad(0)))
}

describe("ERC20Pool exit queue", () => {
  beforeEach(() => {
    createPool(deployment(), POOL, COLLATERAL, QUOTE, new PoolSnapshot(), CREATED_AT)
  })

  afterEach(() => {
    clearStore()
  })

  test("MarkQuoteForWithdrawal gives each lender a place at the back of the queue", () => {
    deposit1000()
    mockBucket(wad(1500), wad(1500), wad(0), wad(1500))
    mockLenderState(OTHER_LENDER, unmarkedLender(wad(500), wad(500), blockTimestamp(101)))
    handleAddQuoteToken(createAddQuoteTokenEvent(POOL, 101, 1, OTHER_LENDER, INDEX, wad(500), wad(500)))

    // all of the bucket's deposit is lent out, so nothing funds the marks
    mockLenderState(LENDER, markedLender(wad(1000), wad(1000), wad(1000), wad(0), blockTimestamp(101)))
    const mark = createMarkQuoteForWithdrawalEvent(POOL, 102, 0, LENDER, INDEX, wad(1000), wad(0))
    handleMarkQuoteForWithdrawal(mark)

    const place = lendId(LENDER)
    assert.fieldEquals("ExitQueuePlace", place, "pool", POOL.toHexString())
    assert.fieldEquals("ExitQueuePlace", place, "bucket", bucketId())
    assert.fieldEquals("ExitQueuePlace", place, "bucketIndex", "2550")
    assert.fieldEquals("ExitQueuePlace", place, "lender", LENDER.toHexString())
    assert.fieldEquals("ExitQueuePlace", place, "account", LENDER.toHexString())
    assert.fieldEquals("ExitQueuePlace", place, "queueStart", "0")
    assert.fieldEquals("ExitQueuePlace", place, "lpb", "1000")
    assert.fieldEquals("ExitQueuePlace", place, "queueStartWad", "0")
    assert.fieldEquals("ExitQueuePlace", place, "lpbWad", wad(1000).toString())
    assert.fieldEquals("ExitQueuePlace", place, "markedAtBlockNumber", "102")
    assert.fieldEquals("ExitQueuePlace", place, "markedAtTimestamp", blockTimestamp(102).toString())

    const eventId = eventEntityId(mark)
    assert.fieldEquals("MarkQuoteForWithdrawal", eventId, "pool", POOL.toHexString())
    assert.fieldEquals("MarkQuoteForWithdrawal", eventId, "bucket", bucketId())
    assert.fieldEquals("MarkQuoteForWithdrawal", eventId, "lender", LENDER.toHexString())
    assert.fieldEquals("MarkQuoteForWithdrawal", eventId, "index", "2550")
    assert.fieldEquals("MarkQuoteForWithdrawal", eventId, "lp", "1000")
    assert.fieldEquals("MarkQuoteForWithdrawal", eventId, "queueStart", "0")

    assert.fieldEquals("Bucket", bucketId(), "queueHead", "0")
    assert.fieldEquals("Bucket", bucketId(), "queueTail", "1000")
    assert.fieldEquals("Bucket", bucketId(), "escrowQuote", "0")
    // marked LP that is not funded is still in the bucket
    assert.fieldEquals("Bucket", bucketId(), "lpb", "1500")
    assert.fieldEquals("Lend", lendId(LENDER), "marked", "true")
    assert.fieldEquals("Lend", lendId(LENDER), "lpb", "1000")
    assert.fieldEquals("Lend", lendId(LENDER), "liveLpb", "1000")
    assert.fieldEquals("Lend", lendId(LENDER), "fundedValueInQuote", "0")
    // marking is an action of the lender's
    assert.fieldEquals("Account", LENDER.toHexString(), "txCount", "2")
    assert.fieldEquals("Pool", POOL.toHexString(), "txCount", "3")

    // the second lender's place starts where the first one ends
    mockLenderState(OTHER_LENDER, markedLender(wad(500), wad(500), wad(500), wad(0), blockTimestamp(101)))
    handleMarkQuoteForWithdrawal(createMarkQuoteForWithdrawalEvent(POOL, 103, 0, OTHER_LENDER, INDEX, wad(500), wad(1000)))

    assert.entityCount("ExitQueuePlace", 2)
    assert.fieldEquals("ExitQueuePlace", lendId(OTHER_LENDER), "queueStart", "1000")
    assert.fieldEquals("ExitQueuePlace", lendId(OTHER_LENDER), "lpb", "500")
    assert.fieldEquals("ExitQueuePlace", place, "queueStart", "0")
    assert.fieldEquals("Bucket", bucketId(), "queueTail", "1500")
    assert.fieldEquals("Bucket", bucketId(), "queueHead", "0")
  })

  test("a mark funded at once: ExitQueueFunded, then MarkQuoteForWithdrawal", () => {
    deposit1000()

    mockPool(wad(0), wad(1000))
    mockBucket(wad(0), wad(0), wad(0), wad(0))
    mockLenderState(LENDER, markedLender(wad(1000), wad(0), wad(0), wad(1000), blockTimestamp(101)))
    const funded = createExitQueueFundedEvent(POOL, 102, 0, INDEX, wad(1000), wad(1000), wad(0), wad(1000))
    handleExitQueueFunded(funded)

    // the funding refreshes the pool and the bucket itself, without waiting for the mark's event
    assert.fieldEquals("Pool", POOL.toHexString(), "escrowedQuote", "1000")
    assert.fieldEquals("Pool", POOL.toHexString(), "updatedAtBlockNumber", "102")
    assert.fieldEquals("Bucket", bucketId(), "deposit", "0")
    assert.fieldEquals("Bucket", bucketId(), "queueHead", "1000")
    // the mark that extends the queue to cover this LP has not been handled yet
    assert.fieldEquals("Bucket", bucketId(), "queueTail", "0")

    handleMarkQuoteForWithdrawal(createMarkQuoteForWithdrawalEvent(POOL, 102, 1, LENDER, INDEX, wad(1000), wad(0)))

    const eventId = eventEntityId(funded)
    assert.fieldEquals("ExitQueueFunded", eventId, "pool", POOL.toHexString())
    assert.fieldEquals("ExitQueueFunded", eventId, "bucket", bucketId())
    assert.fieldEquals("ExitQueueFunded", eventId, "index", "2550")
    assert.fieldEquals("ExitQueueFunded", eventId, "lp", "1000")
    assert.fieldEquals("ExitQueueFunded", eventId, "quote", "1000")
    assert.fieldEquals("ExitQueueFunded", eventId, "collateral", "0")
    assert.fieldEquals("ExitQueueFunded", eventId, "queueHead", "1000")
    assert.fieldEquals("ExitQueueFunded", eventId, "isGiveUp", "false")

    // the funded LP and the quote that paid for it have left the bucket
    assert.fieldEquals("Bucket", bucketId(), "queueHead", "1000")
    assert.fieldEquals("Bucket", bucketId(), "queueTail", "1000")
    assert.fieldEquals("Bucket", bucketId(), "escrowQuote", "1000")
    assert.fieldEquals("Bucket", bucketId(), "escrowCollateral", "0")
    assert.fieldEquals("Bucket", bucketId(), "deposit", "0")
    assert.fieldEquals("Bucket", bucketId(), "lpb", "0")
    assert.fieldEquals("Pool", POOL.toHexString(), "poolSize", "0")
    assert.fieldEquals("Pool", POOL.toHexString(), "escrowedQuote", "1000")

    // the lender still holds the LP, now worth what it was funded at
    assert.fieldEquals("ExitQueuePlace", lendId(LENDER), "queueStart", "0")
    assert.fieldEquals("ExitQueuePlace", lendId(LENDER), "lpb", "1000")
    assert.fieldEquals("Lend", lendId(LENDER), "lpb", "1000")
    assert.fieldEquals("Lend", lendId(LENDER), "liveLpb", "0")
    assert.fieldEquals("Lend", lendId(LENDER), "fundedValueInQuote", "1000")
    assert.fieldEquals("Lend", lendId(LENDER), "lpbValueInQuote", "1000")
    assert.fieldEquals("Lend", lendId(LENDER), "marked", "true")

    // the deposit and the mark; the funding is part of the mark
    assert.fieldEquals("Pool", POOL.toHexString(), "txCount", "2")
  })

  test("claims come off the front of the place, and the last one ends it", () => {
    deposit1000()
    markAndFund1000()

    // 400 of the escrowed quote is claimed
    mockPool(wad(0), wad(600))
    mockLenderState(LENDER, markedLender(wad(600), wad(0), wad(0), wad(600), blockTimestamp(101)))
    const first = createRemoveQuoteTokenEvent(POOL, 103, 0, LENDER, INDEX, wad(400), wad(400))
    handleRemoveQuoteToken(first)

    assert.fieldEquals("RemoveQuoteToken", eventEntityId(first), "isExitClaim", "true")
    assert.fieldEquals("RemoveQuoteToken", eventEntityId(first), "amount", "400")
    assert.fieldEquals("ExitQueuePlace", lendId(LENDER), "queueStart", "400")
    assert.fieldEquals("ExitQueuePlace", lendId(LENDER), "lpb", "600")
    assert.fieldEquals("ExitQueuePlace", lendId(LENDER), "queueStartWad", wad(400).toString())
    assert.fieldEquals("ExitQueuePlace", lendId(LENDER), "lpbWad", wad(600).toString())
    assert.fieldEquals("Bucket", bucketId(), "escrowQuote", "600")
    // a claim moves neither end of the queue, and takes nothing from the bucket
    assert.fieldEquals("Bucket", bucketId(), "queueHead", "1000")
    assert.fieldEquals("Bucket", bucketId(), "queueTail", "1000")
    assert.fieldEquals("Bucket", bucketId(), "lpb", "0")
    assert.fieldEquals("Lend", lendId(LENDER), "lpb", "600")
    assert.fieldEquals("Lend", lendId(LENDER), "fundedValueInQuote", "600")
    assert.fieldEquals("Pool", POOL.toHexString(), "escrowedQuote", "600")

    // the rest is claimed, which ends the place and unmarks the lender
    mockPool(wad(0), wad(0))
    mockLenderState(LENDER, new LenderState())
    const last = createRemoveQuoteTokenEvent(POOL, 104, 0, LENDER, INDEX, wad(600), wad(600))
    handleRemoveQuoteToken(last)

    assert.fieldEquals("RemoveQuoteToken", eventEntityId(last), "isExitClaim", "true")
    assert.notInStore("ExitQueuePlace", lendId(LENDER))
    assert.notInStore("Lend", lendId(LENDER))
    assert.fieldEquals("Bucket", bucketId(), "escrowQuote", "0")

    // the lender can deposit again, and what they then withdraw is not a claim
    mockPool(wad(50), wad(0))
    mockBucket(wad(50), wad(50), wad(0), wad(0))
    mockLenderState(LENDER, unmarkedLender(wad(50), wad(50), blockTimestamp(105)))
    handleAddQuoteToken(createAddQuoteTokenEvent(POOL, 105, 0, LENDER, INDEX, wad(50), wad(50)))
    mockBucket(wad(20), wad(20), wad(0), wad(0))
    mockLenderState(LENDER, unmarkedLender(wad(20), wad(20), blockTimestamp(105)))
    const withdrawal = createRemoveQuoteTokenEvent(POOL, 106, 0, LENDER, INDEX, wad(30), wad(30))
    handleRemoveQuoteToken(withdrawal)

    assert.fieldEquals("RemoveQuoteToken", eventEntityId(withdrawal), "isExitClaim", "false")
    assert.entityCount("ExitQueuePlace", 0)
    assert.fieldEquals("Bucket", bucketId(), "escrowQuote", "0")
    assert.fieldEquals("Lend", lendId(LENDER), "marked", "false")
  })

  test("one funding can cover a whole place and part of the next, and each lender claims their own part", () => {
    deposit1000()
    mockBucket(wad(1500), wad(1500), wad(0), wad(1500))
    mockLenderState(OTHER_LENDER, unmarkedLender(wad(500), wad(500), blockTimestamp(101)))
    handleAddQuoteToken(createAddQuoteTokenEvent(POOL, 101, 1, OTHER_LENDER, INDEX, wad(500), wad(500)))
    // both mark while the bucket's deposit is lent out: LENDER's place is 0 to 1000, the other's 1000 to 1500
    mockLenderState(LENDER, markedLender(wad(1000), wad(1000), wad(1000), wad(0), blockTimestamp(101)))
    handleMarkQuoteForWithdrawal(createMarkQuoteForWithdrawalEvent(POOL, 102, 0, LENDER, INDEX, wad(1000), wad(0)))
    mockLenderState(OTHER_LENDER, markedLender(wad(500), wad(500), wad(500), wad(0), blockTimestamp(101)))
    handleMarkQuoteForWithdrawal(createMarkQuoteForWithdrawalEvent(POOL, 102, 1, OTHER_LENDER, INDEX, wad(500), wad(1000)))

    // A deposit of 1200 by a third lender funds 1200 LP of the queue: all of the first place and
    // 200 of the second. The head stops inside the second place.
    const third = testAddress(0x8003)
    mockPool(wad(1500), wad(1200))
    mockBucket(wad(1500), wad(1500), wad(0), wad(1500))
    mockLenderState(third, unmarkedLender(wad(1200), wad(1200), blockTimestamp(103)))
    handleExitQueueFunded(createExitQueueFundedEvent(POOL, 103, 0, INDEX, wad(1200), wad(1200), wad(0), wad(1200)))
    handleAddQuoteToken(createAddQuoteTokenEvent(POOL, 103, 1, third, INDEX, wad(1200), wad(1200)))

    assert.fieldEquals("Bucket", bucketId(), "queueHead", "1200")
    assert.fieldEquals("Bucket", bucketId(), "queueTail", "1500")
    assert.fieldEquals("Bucket", bucketId(), "escrowQuote", "1200")
    // the funding names neither lender, so their places are unchanged: the head tells what is funded
    assert.fieldEquals("ExitQueuePlace", lendId(LENDER), "queueStart", "0")
    assert.fieldEquals("ExitQueuePlace", lendId(LENDER), "lpb", "1000")
    assert.fieldEquals("ExitQueuePlace", lendId(OTHER_LENDER), "queueStart", "1000")
    assert.fieldEquals("ExitQueuePlace", lendId(OTHER_LENDER), "lpb", "500")

    // The second lender claims the 200 that is funded. They now hold 300 LP still in the bucket
    // and nothing funded.
    mockPool(wad(1500), wad(1000))
    mockLenderState(OTHER_LENDER, markedLender(wad(300), wad(300), wad(300), wad(0), blockTimestamp(101)))
    const partClaim = createRemoveQuoteTokenEvent(POOL, 104, 0, OTHER_LENDER, INDEX, wad(200), wad(200))
    handleRemoveQuoteToken(partClaim)

    assert.fieldEquals("RemoveQuoteToken", eventEntityId(partClaim), "isExitClaim", "true")
    // the place now starts at the head: none of what is left of it is funded
    assert.fieldEquals("ExitQueuePlace", lendId(OTHER_LENDER), "queueStart", "1200")
    assert.fieldEquals("ExitQueuePlace", lendId(OTHER_LENDER), "lpb", "300")
    assert.fieldEquals("Bucket", bucketId(), "escrowQuote", "1000")
    assert.fieldEquals("Lend", lendId(OTHER_LENDER), "lpb", "300")
    assert.fieldEquals("Lend", lendId(OTHER_LENDER), "liveLpb", "300")
    assert.fieldEquals("Lend", lendId(OTHER_LENDER), "fundedValueInQuote", "0")
    assert.fieldEquals("Lend", lendId(OTHER_LENDER), "marked", "true")

    // the first lender's place is untouched by the other's claim
    assert.fieldEquals("ExitQueuePlace", lendId(LENDER), "queueStart", "0")
    assert.fieldEquals("ExitQueuePlace", lendId(LENDER), "lpb", "1000")
  })

  test("a lend with LP both in the bucket and funded is worth the two parts together", () => {
    deposit1000()
    // The lender marks 1000 LP and the bucket's 600 idle quote funds part of it at once. Since
    // then the 400 LP still in the bucket has earned interest and is worth 420.
    mockPool(wad(420), wad(600))
    mockBucket(wad(420), wad(400), wad(0), wad(400))
    mockLenderState(LENDER, markedLender(wad(1000), wad(400), wad(420), wad(600), blockTimestamp(101)))
    handleExitQueueFunded(createExitQueueFundedEvent(POOL, 102, 0, INDEX, wad(600), wad(600), wad(0), wad(600)))
    handleMarkQuoteForWithdrawal(createMarkQuoteForWithdrawalEvent(POOL, 102, 1, LENDER, INDEX, wad(1000), wad(0)))

    assert.fieldEquals("Lend", lendId(LENDER), "lpb", "1000")
    assert.fieldEquals("Lend", lendId(LENDER), "liveLpb", "400")
    assert.fieldEquals("Lend", lendId(LENDER), "fundedValueInQuote", "600")
    // 420 for the LP in the bucket plus 600 funded
    assert.fieldEquals("Lend", lendId(LENDER), "lpbValueInQuote", "1020")
    // the head is inside the place: 600 of its 1000 LP is funded
    assert.fieldEquals("Bucket", bucketId(), "queueHead", "600")
    assert.fieldEquals("Bucket", bucketId(), "queueTail", "1000")
    assert.fieldEquals("Bucket", bucketId(), "lpb", "400")
    assert.fieldEquals("ExitQueuePlace", lendId(LENDER), "lpb", "1000")
  })

  test("a place larger than a BigDecimal can hold exactly still ends with its last claim", () => {
    // 1e16 LP and a few wei: more significant digits than a BigDecimal keeps
    const half = BigInt.fromString("5000000000000000000000000000000003")
    const whole = half.times(BigInt.fromI32(2))
    mockPool(whole, wad(0))
    mockBucket(whole, whole, wad(0), wad(0))
    mockLenderState(LENDER, unmarkedLender(whole, whole, blockTimestamp(101)))
    handleAddQuoteToken(createAddQuoteTokenEvent(POOL, 101, 0, LENDER, INDEX, whole, whole))

    mockPool(wad(0), whole)
    mockBucket(wad(0), wad(0), wad(0), wad(0))
    mockLenderState(LENDER, markedLender(whole, wad(0), wad(0), whole, blockTimestamp(101)))
    handleExitQueueFunded(createExitQueueFundedEvent(POOL, 102, 0, INDEX, whole, whole, wad(0), whole))
    handleMarkQuoteForWithdrawal(createMarkQuoteForWithdrawalEvent(POOL, 102, 1, LENDER, INDEX, whole, wad(0)))

    mockLenderState(LENDER, markedLender(half, wad(0), wad(0), half, blockTimestamp(101)))
    handleRemoveQuoteToken(createRemoveQuoteTokenEvent(POOL, 103, 0, LENDER, INDEX, half, half))
    assert.fieldEquals("ExitQueuePlace", lendId(LENDER), "lpbWad", half.toString())
    assert.fieldEquals("ExitQueuePlace", lendId(LENDER), "queueStartWad", half.toString())

    mockLenderState(LENDER, new LenderState())
    handleRemoveQuoteToken(createRemoveQuoteTokenEvent(POOL, 104, 0, LENDER, INDEX, half, half))
    assert.notInStore("ExitQueuePlace", lendId(LENDER))

    // so a later deposit and withdrawal by the same lender is not taken for a claim
    mockBucket(wad(50), wad(50), wad(0), wad(0))
    mockLenderState(LENDER, unmarkedLender(wad(50), wad(50), blockTimestamp(105)))
    handleAddQuoteToken(createAddQuoteTokenEvent(POOL, 105, 0, LENDER, INDEX, wad(50), wad(50)))
    mockBucket(wad(0), wad(0), wad(0), wad(0))
    mockLenderState(LENDER, new LenderState())
    const withdrawal = createRemoveQuoteTokenEvent(POOL, 106, 0, LENDER, INDEX, wad(50), wad(50))
    handleRemoveQuoteToken(withdrawal)
    assert.fieldEquals("RemoveQuoteToken", eventEntityId(withdrawal), "isExitClaim", "false")
  })

  test("LP too small to pay out is given up by the queue, or cleared by a claim that pays nothing", () => {
    deposit1000()

    // The mark is funded with 999 whole quote for 999.4 LP; the last 0.6 LP is worth less than
    // one quote token unit, so the queue gives it up: a second event with nothing escrowed.
    mockPool(wad(1), wad(999))
    mockBucket(wad(1), wad(0), wad(0), wad(0))
    mockLenderState(LENDER, markedLender(wad(1000), wad(0), wad(0), wad(999), blockTimestamp(101)))
    const funded = createExitQueueFundedEvent(POOL, 102, 0, INDEX, wadOf("999.4"), wad(999), wad(0), wadOf("999.4"))
    handleExitQueueFunded(funded)
    const givenUp = createExitQueueFundedEvent(POOL, 102, 1, INDEX, wadOf("0.6"), wad(0), wad(0), wad(1000))
    handleExitQueueFunded(givenUp)
    handleMarkQuoteForWithdrawal(createMarkQuoteForWithdrawalEvent(POOL, 102, 2, LENDER, INDEX, wad(1000), wad(0)))

    assert.fieldEquals("ExitQueueFunded", eventEntityId(funded), "isGiveUp", "false")
    assert.fieldEquals("ExitQueueFunded", eventEntityId(givenUp), "isGiveUp", "true")
    assert.fieldEquals("ExitQueueFunded", eventEntityId(givenUp), "lp", "0.6")
    assert.fieldEquals("ExitQueueFunded", eventEntityId(givenUp), "queueHead", "1000")
    assert.fieldEquals("Bucket", bucketId(), "queueHead", "1000")
    assert.fieldEquals("Bucket", bucketId(), "escrowQuote", "999")

    // the lender claims the 999 quote, which redeems the LP that covers it
    mockPool(wad(1), wad(0))
    mockLenderState(LENDER, markedLender(wadOf("0.6"), wad(0), wad(0), wad(0), blockTimestamp(101)))
    handleRemoveQuoteToken(createRemoveQuoteTokenEvent(POOL, 103, 0, LENDER, INDEX, wad(999), wadOf("999.4")))

    assert.fieldEquals("ExitQueuePlace", lendId(LENDER), "queueStart", "999.4")
    assert.fieldEquals("ExitQueuePlace", lendId(LENDER), "lpb", "0.6")
    assert.fieldEquals("Bucket", bucketId(), "escrowQuote", "0")

    // a further claim pays nothing and clears the given-up LP, which ends the place
    mockLenderState(LENDER, new LenderState())
    const clearing = createRemoveQuoteTokenEvent(POOL, 104, 0, LENDER, INDEX, wad(0), wadOf("0.6"))
    handleRemoveQuoteToken(clearing)

    assert.fieldEquals("RemoveQuoteToken", eventEntityId(clearing), "isExitClaim", "true")
    assert.fieldEquals("RemoveQuoteToken", eventEntityId(clearing), "amount", "0")
    assert.fieldEquals("RemoveQuoteToken", eventEntityId(clearing), "lpRedeemed", "0.6")
    assert.notInStore("ExitQueuePlace", lendId(LENDER))
    assert.notInStore("Lend", lendId(LENDER))
    assert.fieldEquals("Bucket", bucketId(), "escrowQuote", "0")
  })

  test("collateral funds the queue, and is claimed with RemoveCollateral", () => {
    deposit1000()
    // the bucket's deposit is lent out, so the mark waits
    mockBucket(wad(1000), wad(1000), wad(0), wad(1000))
    mockLenderState(LENDER, markedLender(wad(1000), wad(1000), wad(1000), wad(0), blockTimestamp(101)))
    handleMarkQuoteForWithdrawal(createMarkQuoteForWithdrawalEvent(POOL, 102, 0, LENDER, INDEX, wad(1000), wad(0)))

    // Another lender adds 10 collateral, worth 1000 at the bucket price. It funds the marked LP
    // and goes to escrow; the pool emits ExitQueueFunded before AddCollateral.
    mockBucket(wad(1000), wad(1000), wad(0), wad(1000))
    mockLenderState(OTHER_LENDER, unmarkedLender(wad(1000), wad(1000), blockTimestamp(103)))
    const funded = createExitQueueFundedEvent(POOL, 103, 0, INDEX, wad(1000), wad(0), wad(10), wad(1000))
    handleExitQueueFunded(funded)
    handleAddCollateral(createAddCollateralEvent(POOL, 103, 1, OTHER_LENDER, INDEX, wad(10), wad(1000)))

    assert.fieldEquals("ExitQueueFunded", eventEntityId(funded), "quote", "0")
    assert.fieldEquals("ExitQueueFunded", eventEntityId(funded), "collateral", "10")
    assert.fieldEquals("ExitQueueFunded", eventEntityId(funded), "isGiveUp", "false")
    assert.fieldEquals("Bucket", bucketId(), "queueHead", "1000")
    assert.fieldEquals("Bucket", bucketId(), "escrowCollateral", "10")
    assert.fieldEquals("Bucket", bucketId(), "escrowQuote", "0")
    // collateral in escrow is still owed to lenders
    assert.fieldEquals("Pool", POOL.toHexString(), "lenderCollateral", "10")

    // the marked lender claims the collateral
    mockLenderState(LENDER, new LenderState())
    const claim = createRemoveCollateralEvent(POOL, 104, 0, LENDER, INDEX, wad(10), wad(1000))
    handleRemoveCollateral(claim)

    assert.fieldEquals("RemoveCollateral", eventEntityId(claim), "isExitClaim", "true")
    assert.fieldEquals("RemoveCollateral", eventEntityId(claim), "amount", "10")
    assert.notInStore("ExitQueuePlace", lendId(LENDER))
    assert.fieldEquals("Bucket", bucketId(), "escrowCollateral", "0")
    assert.fieldEquals("Pool", POOL.toHexString(), "lenderCollateral", "0")
    // the other lender is not marked, and still has their LP
    assert.fieldEquals("Lend", lendId(OTHER_LENDER), "lpb", "1000")
    assert.fieldEquals("Lend", lendId(OTHER_LENDER), "marked", "false")
  })

  test("a mark and a full claim in one block: the removal is still a claim", () => {
    deposit1000()

    // By the end of block 102 the lender has no LP and is no longer marked, which is what every
    // read in the block returns.
    mockPool(wad(0), wad(0))
    mockBucket(wad(0), wad(0), wad(0), wad(0))
    mockLenderState(LENDER, new LenderState())
    handleExitQueueFunded(createExitQueueFundedEvent(POOL, 102, 0, INDEX, wad(1000), wad(1000), wad(0), wad(1000)))
    const mark = createMarkQuoteForWithdrawalEvent(POOL, 102, 1, LENDER, INDEX, wad(1000), wad(0))
    handleMarkQuoteForWithdrawal(mark)
    const claim = createRemoveQuoteTokenEvent(POOL, 102, 2, LENDER, INDEX, wad(1000), wad(1000))
    handleRemoveQuoteToken(claim)

    assert.fieldEquals("RemoveQuoteToken", eventEntityId(claim), "isExitClaim", "true")
    assert.fieldEquals("MarkQuoteForWithdrawal", eventEntityId(mark), "lp", "1000")
    assert.notInStore("ExitQueuePlace", lendId(LENDER))
    assert.notInStore("Lend", lendId(LENDER))
    // the escrow filled and emptied within the block
    assert.fieldEquals("Bucket", bucketId(), "escrowQuote", "0")
    assert.fieldEquals("Bucket", bucketId(), "queueHead", "1000")
    assert.fieldEquals("Bucket", bucketId(), "queueTail", "1000")
  })

  test("a withdrawal before a mark in the same block is not a claim", () => {
    deposit1000()

    // by the end of block 102 the lender is marked, but they were not when they withdrew
    mockPool(wad(600), wad(0))
    mockBucket(wad(600), wad(600), wad(0), wad(600))
    mockLenderState(LENDER, markedLender(wad(600), wad(600), wad(600), wad(0), blockTimestamp(101)))
    const withdrawal = createRemoveQuoteTokenEvent(POOL, 102, 0, LENDER, INDEX, wad(400), wad(400))
    handleRemoveQuoteToken(withdrawal)
    handleMarkQuoteForWithdrawal(createMarkQuoteForWithdrawalEvent(POOL, 102, 1, LENDER, INDEX, wad(600), wad(0)))

    assert.fieldEquals("RemoveQuoteToken", eventEntityId(withdrawal), "isExitClaim", "false")
    assert.fieldEquals("ExitQueuePlace", lendId(LENDER), "queueStart", "0")
    assert.fieldEquals("ExitQueuePlace", lendId(LENDER), "lpb", "600")
    assert.fieldEquals("Bucket", bucketId(), "escrowQuote", "0")
    assert.fieldEquals("Bucket", bucketId(), "queueTail", "600")
    assert.fieldEquals("Lend", lendId(LENDER), "marked", "true")
  })

  test("repayDebt funds the queue: ExitQueueFunded, LoanClosed, then RepayDebt", () => {
    deposit1000()
    const loan = loanId(BORROWER, 1)
    const live = new LoanState()
    live.t0Debt = wad(1000)
    live.collateral = wad(20)
    live.t0Tp = wadOf("52.5")
    live.bucketIndex = INDEX
    live.expiry = blockTimestamp(102).plus(THIRTY_DAYS)
    mockBucket(wad(1000), wad(1000), wad(0), wad(1000))
    mockLoan(POOL, loan, BORROWER, live)
    handleDrawDebt(createDrawDebtEvent(POOL, 102, 0, BORROWER, loan, INDEX, wad(1000), wad(20)))
    mockLenderState(LENDER, markedLender(wad(1000), wad(1000), wad(1000), wad(0), blockTimestamp(101)))
    handleMarkQuoteForWithdrawal(createMarkQuoteForWithdrawalEvent(POOL, 103, 0, LENDER, INDEX, wad(1000), wad(0)))

    // the repayment brings 1000 quote to the bucket, which goes straight to escrow for the marked LP
    mockPool(wad(0), wad(1000))
    mockBucket(wad(0), wad(0), wad(0), wad(0))
    mockDeletedLoan(POOL, loan)
    handleExitQueueFunded(createExitQueueFundedEvent(POOL, 104, 0, INDEX, wad(1000), wad(1000), wad(0), wad(1000)))
    handleLoanClosed(createLoanClosedEvent(POOL, 104, 1, BORROWER, loan, true))
    handleRepayDebt(createRepayDebtEvent(POOL, 104, 2, BORROWER, loan, INDEX, wad(1000), wad(20)))

    assert.fieldEquals("Bucket", bucketId(), "queueHead", "1000")
    assert.fieldEquals("Bucket", bucketId(), "escrowQuote", "1000")
    assert.fieldEquals("Bucket", bucketId(), "deposit", "0")
    assert.fieldEquals("Bucket", bucketId(), "lpb", "0")
    assert.fieldEquals("Bucket", bucketId(), "t0debt", "0")
    assert.fieldEquals("Pool", POOL.toHexString(), "escrowedQuote", "1000")
    assert.fieldEquals("Loan", getLoanEntityId(POOL, loan).toHexString(), "status", "Closed")
    assert.entityCount("ExitQueueFunded", 1)

    // The funding names no lender, so the Lend is as it was last read. The place and the
    // queue's head show that all of it is now funded.
    assert.fieldEquals("Lend", lendId(LENDER), "updatedAtBlockNumber", "103")
    assert.fieldEquals("Lend", lendId(LENDER), "liveLpb", "1000")
    assert.fieldEquals("ExitQueuePlace", lendId(LENDER), "queueStart", "0")
    assert.fieldEquals("ExitQueuePlace", lendId(LENDER), "lpb", "1000")
    // deposit, draw, mark and repayment
    assert.fieldEquals("Pool", POOL.toHexString(), "txCount", "4")
  })

  test("callLoan funds the queue with collateral: LoanClosed, ExitQueueFunded, then LoanCalled", () => {
    deposit1000()
    const loan = loanId(BORROWER, 1)
    const live = new LoanState()
    live.t0Debt = wad(1000)
    live.collateral = wad(20)
    live.t0Tp = wadOf("52.5")
    live.bucketIndex = INDEX
    live.expiry = blockTimestamp(102).plus(THIRTY_DAYS)
    mockBucket(wad(1000), wad(1000), wad(0), wad(1000))
    mockLoan(POOL, loan, BORROWER, live)
    handleDrawDebt(createDrawDebtEvent(POOL, 102, 0, BORROWER, loan, INDEX, wad(1000), wad(20)))
    mockLenderState(LENDER, markedLender(wad(1000), wad(1000), wad(1000), wad(0), blockTimestamp(101)))
    handleMarkQuoteForWithdrawal(createMarkQuoteForWithdrawalEvent(POOL, 103, 0, LENDER, INDEX, wad(1000), wad(0)))

    // The call gives the bucket 10 collateral for the lenders' claim. It funds the marked LP
    // and moves to escrow, so none of it stays in the bucket.
    mockPool(wad(0), wad(0))
    mockBucket(wad(0), wad(0), wad(0), wad(0))
    const remainder = new LoanState()
    remainder.collateral = wad(9)
    remainder.bucketIndex = INDEX
    remainder.expiry = live.expiry
    mockLoan(POOL, loan, BORROWER, remainder)
    handleLoanClosed(createLoanClosedEvent(POOL, 104, 0, BORROWER, loan, false))
    handleExitQueueFunded(createExitQueueFundedEvent(POOL, 104, 1, INDEX, wad(1000), wad(0), wad(10), wad(1000)))
    handleLoanCalled(
      createLoanCalledEvent(POOL, 104, 2, loan, testAddress(0xb002), wad(1000), wad(10), wadOf("0.5"), wadOf("0.5"))
    )

    assert.fieldEquals("Bucket", bucketId(), "queueHead", "1000")
    assert.fieldEquals("Bucket", bucketId(), "escrowCollateral", "10")
    assert.fieldEquals("Bucket", bucketId(), "escrowQuote", "0")
    assert.fieldEquals("Bucket", bucketId(), "collateral", "0")
    assert.fieldEquals("Pool", POOL.toHexString(), "lenderCollateral", "10")
    assert.fieldEquals("Pool", POOL.toHexString(), "pledgedCollateral", "9")
    assert.fieldEquals("Loan", getLoanEntityId(POOL, loan).toHexString(), "status", "DebtFree")
    assert.fieldEquals("ExitQueuePlace", lendId(LENDER), "lpb", "1000")
  })
})
