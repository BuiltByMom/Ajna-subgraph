import { afterEach, assert, beforeEach, clearStore, describe, test } from "matchstick-as/assembly/index"
import { Address, BigInt } from "@graphprotocol/graph-ts"

import {
  handleAddCollateral,
  handleAddQuoteToken,
  handleApproveLPTransferors,
  handleDecreaseLPAllowance,
  handleFlashloan,
  handleIncreaseLPAllowance,
  handleInterestUpdateFailure,
  handleMoveQuoteToken,
  handleRemoveCollateral,
  handleRemoveQuoteToken,
  handleRevokeLPAllowance,
  handleRevokeLPTransferors,
  handleTransferLP,
  handleUpdateInterestRate
} from "../src/mappings/erc-20-pool"
import { handlePoolCreated } from "../src/mappings/erc-20-pool-factory"
import { Deployment, allDeployments } from "../src/utils/deployments"
import { getBucketId } from "../src/utils/pool/bucket"
import { getLendId } from "../src/utils/pool/lend"
import { getAllowanceId, getAllowanceListId } from "../src/utils/pool/lp-allowances"
import { getTransferorListId } from "../src/utils/pool/lp-transferors"
import { THIRTY_DAYS, blockTimestamp, eventEntityId, testAddress, wad } from "./utils/common"
import { createPool, createPoolCreatedEvent } from "./utils/erc-20-pool-factory-utils"
import {
  createAddCollateralEvent,
  createAddQuoteTokenEvent,
  createApproveLPTransferorsEvent,
  createDecreaseLPAllowanceEvent,
  createFlashloanEvent,
  createIncreaseLPAllowanceEvent,
  createInterestUpdateFailureEvent,
  createMoveQuoteTokenEvent,
  createRemoveCollateralEvent,
  createRemoveQuoteTokenEvent,
  createRevokeLPAllowanceEvent,
  createRevokeLPTransferorsEvent,
  createTransferLPEvent,
  createUpdateInterestRateEvent
} from "./utils/erc-20-pool-utils"
import {
  BucketState,
  LenderState,
  PoolSnapshot,
  mockBucketInfo,
  mockLender,
  mockLoanTerm,
  mockPoolSnapshot,
  mockPoolSnapshotReverts,
  mockTokenInfo,
  unmarkedLender
} from "./utils/mock-contract-calls"

// These tests run against whichever config `yarn configure` last rendered. Tests of one pool use
// its first deployment; the test of several factories covers every deployment in it. CI runs
// them with tests/fixtures/two-factories.json.
//
// Handlers read contract state once per block, so each step that changes mocked state uses a
// new block number.

const POOL = testAddress(0x1000)
const COLLATERAL = testAddress(0x7000)
const QUOTE = testAddress(0x7001)
const LENDER = testAddress(0x8001)
const OTHER_LENDER = testAddress(0x8002)
const CREATED_AT = 100
const INDEX = 2550
const OTHER_INDEX = 2600

const FIVE_PERCENT = BigInt.fromString("50000000000000000")

function deployment(): Deployment {
  return allDeployments()[0]
}

function bucketId(pool: Address, index: i32): string {
  return getBucketId(pool, index).toHexString()
}

function lendId(pool: Address, index: i32, lender: Address): string {
  return getLendId(getBucketId(pool, index), lender).toHexString()
}

function allowanceId(owner: Address, spender: Address, index: i32): string {
  return getAllowanceId(getAllowanceListId(POOL, owner, spender), BigInt.fromI32(index)).toHexString()
}

function mockPool(snapshot: PoolSnapshot): void {
  mockPoolSnapshot(deployment().poolInfoUtilsMulticall, POOL, snapshot)
}

// a bucket priced at 100 holding only quote
function quoteBucket(deposit: BigInt, lp: BigInt): BucketState {
  const bucket = new BucketState()
  bucket.price = wad(100)
  bucket.deposit = deposit
  bucket.lp = lp
  return bucket
}

function mockBucket(index: i32, bucket: BucketState): void {
  mockBucketInfo(deployment().poolInfoUtils, POOL, index, bucket)
}

function mockLenderIn(index: i32, lender: Address, state: LenderState): void {
  mockLender(deployment().poolInfoUtils, POOL, index, lender, state)
}

// LENDER deposits `amount` quote into the bucket at INDEX, alone, at an exchange rate of 1
function depositQuote(amount: BigInt, blockNumber: i32): void {
  const snapshot = new PoolSnapshot()
  snapshot.poolSize = amount
  snapshot.quoteTokenBalance = amount
  snapshot.availableQuote = amount
  mockPool(snapshot)
  mockBucket(INDEX, quoteBucket(amount, amount))
  mockLenderIn(INDEX, LENDER, unmarkedLender(amount, amount, blockTimestamp(blockNumber)))

  handleAddQuoteToken(createAddQuoteTokenEvent(POOL, blockNumber, 0, LENDER, INDEX, amount, amount))
}

describe("ERC20Pool lender events", () => {
  beforeEach(() => {
    createPool(deployment(), POOL, COLLATERAL, QUOTE, new PoolSnapshot(), CREATED_AT)
  })

  afterEach(() => {
    clearStore()
  })

  test("AddQuoteToken records the deposit and refreshes the pool, bucket and lend", () => {
    const snapshot = new PoolSnapshot()
    snapshot.poolSize = wad(1000)
    snapshot.debt = wad(510)
    snapshot.t0debt = wad(500)
    snapshot.inflator = BigInt.fromString("1020000000000000000") // 1.02
    snapshot.borrowRate = FIVE_PERCENT
    snapshot.rateAtTarget = BigInt.fromString("40000000000000000") // 0.04
    snapshot.utilization = BigInt.fromString("500000000000000000") // 0.5
    snapshot.quoteTokenBalance = wad(520)
    snapshot.collateralBalance = wad(7)
    snapshot.escrowedQuote = wad(3)
    snapshot.availableQuote = wad(510)
    snapshot.quoteSurplus = wad(11)
    snapshot.quoteSurplusClaimable = wad(10)
    snapshot.quoteSurplusLotRemaining = wad(7)
    snapshot.collateralSurplus = wad(2)
    snapshot.collateralSurplusClaimable = wad(1)
    snapshot.collateralSurplusLotRemaining = wad(4)
    mockPool(snapshot)

    // the bucket already held deposit from others, at an exchange rate of 1.25
    const bucket = new BucketState()
    bucket.price = BigInt.fromString("100500000000000000000") // 100.5
    bucket.deposit = wad(1000)
    bucket.lp = wad(800)
    bucket.exchangeRate = BigInt.fromString("1250000000000000000")
    bucket.t0debt = wad(300)
    mockBucket(INDEX, bucket)
    mockLenderIn(INDEX, LENDER, unmarkedLender(wad(400), wad(500), blockTimestamp(101)))

    const event = createAddQuoteTokenEvent(POOL, 101, 3, LENDER, INDEX, wad(500), wad(400))
    handleAddQuoteToken(event)

    const eventId = eventEntityId(event)
    assert.fieldEquals("AddQuoteToken", eventId, "pool", POOL.toHexString())
    assert.fieldEquals("AddQuoteToken", eventId, "bucket", bucketId(POOL, INDEX))
    assert.fieldEquals("AddQuoteToken", eventId, "lender", LENDER.toHexString())
    assert.fieldEquals("AddQuoteToken", eventId, "index", "2550")
    assert.fieldEquals("AddQuoteToken", eventId, "amount", "500")
    assert.fieldEquals("AddQuoteToken", eventId, "lpAwarded", "400")
    assert.fieldEquals("AddQuoteToken", eventId, "blockNumber", "101")
    assert.fieldEquals("AddQuoteToken", eventId, "blockTimestamp", blockTimestamp(101).toString())

    const poolId = POOL.toHexString()
    assert.fieldEquals("Pool", poolId, "poolSize", "1000")
    assert.fieldEquals("Pool", poolId, "debt", "510")
    assert.fieldEquals("Pool", poolId, "t0debt", "500")
    assert.fieldEquals("Pool", poolId, "inflator", "1.02")
    assert.fieldEquals("Pool", poolId, "borrowRate", "0.05")
    assert.fieldEquals("Pool", poolId, "rateAtTarget", "0.04")
    assert.fieldEquals("Pool", poolId, "utilization", "0.5")
    // 0.05 * 0.96 * 0.5
    assert.fieldEquals("Pool", poolId, "lendRate", "0.024")
    assert.fieldEquals("Pool", poolId, "quoteTokenBalance", "520")
    assert.fieldEquals("Pool", poolId, "collateralBalance", "7")
    assert.fieldEquals("Pool", poolId, "escrowedQuote", "3")
    assert.fieldEquals("Pool", poolId, "availableQuote", "510")
    assert.fieldEquals("Pool", poolId, "quoteSurplus", "11")
    assert.fieldEquals("Pool", poolId, "quoteSurplusClaimable", "10")
    assert.fieldEquals("Pool", poolId, "quoteSurplusLotRemaining", "7")
    assert.fieldEquals("Pool", poolId, "collateralSurplus", "2")
    assert.fieldEquals("Pool", poolId, "collateralSurplusClaimable", "1")
    assert.fieldEquals("Pool", poolId, "collateralSurplusLotRemaining", "4")
    assert.fieldEquals("Pool", poolId, "txCount", "1")
    assert.fieldEquals("Pool", poolId, "updatedAtBlockNumber", "101")
    assert.fieldEquals("Pool", poolId, "updatedAtTimestamp", blockTimestamp(101).toString())

    const id = bucketId(POOL, INDEX)
    assert.fieldEquals("Bucket", id, "pool", poolId)
    assert.fieldEquals("Bucket", id, "poolAddress", poolId)
    assert.fieldEquals("Bucket", id, "bucketIndex", "2550")
    assert.fieldEquals("Bucket", id, "bucketPrice", "100.5")
    assert.fieldEquals("Bucket", id, "deposit", "1000")
    assert.fieldEquals("Bucket", id, "collateral", "0")
    assert.fieldEquals("Bucket", id, "lpb", "800")
    assert.fieldEquals("Bucket", id, "exchangeRate", "1.25")
    assert.fieldEquals("Bucket", id, "t0debt", "300")
    assert.fieldEquals("Bucket", id, "updatedAtBlockNumber", "101")

    const lend = lendId(POOL, INDEX, LENDER)
    assert.fieldEquals("Lend", lend, "pool", poolId)
    assert.fieldEquals("Lend", lend, "poolAddress", poolId)
    assert.fieldEquals("Lend", lend, "bucket", id)
    assert.fieldEquals("Lend", lend, "bucketIndex", "2550")
    assert.fieldEquals("Lend", lend, "lender", LENDER.toHexString())
    assert.fieldEquals("Lend", lend, "account", LENDER.toHexString())
    assert.fieldEquals("Lend", lend, "lpb", "400")
    assert.fieldEquals("Lend", lend, "lpbValueInQuote", "500")
    assert.fieldEquals("Lend", lend, "depositTime", blockTimestamp(101).toString())
    assert.fieldEquals("Lend", lend, "updatedAtBlockNumber", "101")

    assert.fieldEquals("Account", LENDER.toHexString(), "txCount", "1")
    assert.fieldEquals("Token", QUOTE.toHexString(), "txCount", "1")
    assert.fieldEquals("Token", COLLATERAL.toHexString(), "txCount", "1")
  })

  test("AddCollateral records the collateral and the LP it earned", () => {
    // 2 collateral at a price of 100 earns 200 LP in an empty bucket
    const bucket = new BucketState()
    bucket.price = wad(100)
    bucket.collateral = wad(2)
    bucket.lp = wad(200)
    mockBucket(INDEX, bucket)
    mockLenderIn(INDEX, LENDER, unmarkedLender(wad(200), wad(200), blockTimestamp(101)))
    const snapshot = new PoolSnapshot()
    snapshot.collateralBalance = wad(2)
    mockPool(snapshot)

    const event = createAddCollateralEvent(POOL, 101, 0, LENDER, INDEX, wad(2), wad(200))
    handleAddCollateral(event)

    const eventId = eventEntityId(event)
    assert.fieldEquals("AddCollateral", eventId, "pool", POOL.toHexString())
    assert.fieldEquals("AddCollateral", eventId, "bucket", bucketId(POOL, INDEX))
    assert.fieldEquals("AddCollateral", eventId, "actor", LENDER.toHexString())
    assert.fieldEquals("AddCollateral", eventId, "index", "2550")
    assert.fieldEquals("AddCollateral", eventId, "amount", "2")
    assert.fieldEquals("AddCollateral", eventId, "lpAwarded", "200")

    assert.fieldEquals("Bucket", bucketId(POOL, INDEX), "collateral", "2")
    assert.fieldEquals("Bucket", bucketId(POOL, INDEX), "deposit", "0")
    assert.fieldEquals("Bucket", bucketId(POOL, INDEX), "lpb", "200")
    assert.fieldEquals("Lend", lendId(POOL, INDEX, LENDER), "lpb", "200")
    assert.fieldEquals("Lend", lendId(POOL, INDEX, LENDER), "lpbValueInQuote", "200")
    assert.fieldEquals("Pool", POOL.toHexString(), "collateralBalance", "2")
    // collateral in a bucket is owed to lenders, not pledged by borrowers
    assert.fieldEquals("Pool", POOL.toHexString(), "lenderCollateral", "2")
    assert.fieldEquals("Pool", POOL.toHexString(), "pledgedCollateral", "0")
    assert.fieldEquals("Pool", POOL.toHexString(), "txCount", "1")
    assert.fieldEquals("Account", LENDER.toHexString(), "txCount", "1")
  })

  test("RemoveQuoteToken reduces the lend, and removes it once no LP is left", () => {
    depositQuote(wad(1000), 101)

    // a partial withdrawal
    mockBucket(INDEX, quoteBucket(wad(600), wad(600)))
    mockLenderIn(INDEX, LENDER, unmarkedLender(wad(600), wad(600), blockTimestamp(101)))
    const partial = createRemoveQuoteTokenEvent(POOL, 102, 0, LENDER, INDEX, wad(400), wad(400))
    handleRemoveQuoteToken(partial)

    assert.fieldEquals("RemoveQuoteToken", eventEntityId(partial), "pool", POOL.toHexString())
    assert.fieldEquals("RemoveQuoteToken", eventEntityId(partial), "bucket", bucketId(POOL, INDEX))
    assert.fieldEquals("RemoveQuoteToken", eventEntityId(partial), "lender", LENDER.toHexString())
    assert.fieldEquals("RemoveQuoteToken", eventEntityId(partial), "index", "2550")
    assert.fieldEquals("RemoveQuoteToken", eventEntityId(partial), "amount", "400")
    assert.fieldEquals("RemoveQuoteToken", eventEntityId(partial), "lpRedeemed", "400")
    assert.fieldEquals("Lend", lendId(POOL, INDEX, LENDER), "lpb", "600")
    assert.fieldEquals("Lend", lendId(POOL, INDEX, LENDER), "lpbValueInQuote", "600")
    // a withdrawal does not move the deposit time
    assert.fieldEquals("Lend", lendId(POOL, INDEX, LENDER), "depositTime", blockTimestamp(101).toString())
    assert.fieldEquals("Bucket", bucketId(POOL, INDEX), "deposit", "600")

    // the rest
    mockBucket(INDEX, quoteBucket(wad(0), wad(0)))
    mockLenderIn(INDEX, LENDER, new LenderState())
    handleRemoveQuoteToken(createRemoveQuoteTokenEvent(POOL, 103, 0, LENDER, INDEX, wad(600), wad(600)))

    assert.notInStore("Lend", lendId(POOL, INDEX, LENDER))
    assert.entityCount("Lend", 0)
    assert.entityCount("RemoveQuoteToken", 2)
    assert.fieldEquals("Bucket", bucketId(POOL, INDEX), "deposit", "0")
    assert.fieldEquals("Bucket", bucketId(POOL, INDEX), "lpb", "0")
    assert.fieldEquals("Account", LENDER.toHexString(), "txCount", "3")
    assert.fieldEquals("Pool", POOL.toHexString(), "txCount", "3")
  })

  test("a marked lender's claims reduce the lend by the LP redeemed, even when no quote is paid", () => {
    depositQuote(wad(1000), 101)

    // the lender marked their LP and the exit queue funded 600 of it, which left the bucket
    mockBucket(INDEX, quoteBucket(wad(400), wad(400)))

    // a claim of 250 quote from escrow
    const afterClaim = new LenderState()
    afterClaim.lp = wad(750)
    afterClaim.marked = true
    afterClaim.liveLp = wad(400)
    afterClaim.liveWorth = wad(400)
    afterClaim.fundedWorth = wad(350)
    afterClaim.depositTime = blockTimestamp(101)
    mockLenderIn(INDEX, LENDER, afterClaim)
    handleRemoveQuoteToken(createRemoveQuoteTokenEvent(POOL, 102, 0, LENDER, INDEX, wad(250), wad(250)))

    assert.fieldEquals("Lend", lendId(POOL, INDEX, LENDER), "lpb", "750")
    // 400 still in the bucket plus 350 funded and waiting in escrow
    assert.fieldEquals("Lend", lendId(POOL, INDEX, LENDER), "lpbValueInQuote", "750")
    // the claim came out of escrow, not out of the bucket
    assert.fieldEquals("Bucket", bucketId(POOL, INDEX), "lpb", "400")

    // a claim that clears funded LP too small to be paid: LP is redeemed for no quote
    const afterDustClaim = new LenderState()
    afterDustClaim.lp = wad(400)
    afterDustClaim.marked = true
    afterDustClaim.liveLp = wad(400)
    afterDustClaim.liveWorth = wad(400)
    afterDustClaim.depositTime = blockTimestamp(101)
    mockLenderIn(INDEX, LENDER, afterDustClaim)
    const dustClaim = createRemoveQuoteTokenEvent(POOL, 103, 0, LENDER, INDEX, wad(0), wad(350))
    handleRemoveQuoteToken(dustClaim)

    assert.fieldEquals("RemoveQuoteToken", eventEntityId(dustClaim), "amount", "0")
    assert.fieldEquals("RemoveQuoteToken", eventEntityId(dustClaim), "lpRedeemed", "350")
    assert.fieldEquals("Lend", lendId(POOL, INDEX, LENDER), "lpb", "400")
    assert.fieldEquals("Lend", lendId(POOL, INDEX, LENDER), "lpbValueInQuote", "400")
  })

  test("RemoveCollateral records the collateral removed and refreshes the lend", () => {
    const bucket = new BucketState()
    bucket.price = wad(100)
    bucket.collateral = wad(2)
    bucket.lp = wad(200)
    mockBucket(INDEX, bucket)
    mockLenderIn(INDEX, LENDER, unmarkedLender(wad(200), wad(200), blockTimestamp(101)))
    handleAddCollateral(createAddCollateralEvent(POOL, 101, 0, LENDER, INDEX, wad(2), wad(200)))

    bucket.collateral = wad(1)
    bucket.lp = wad(100)
    mockBucket(INDEX, bucket)
    mockLenderIn(INDEX, LENDER, unmarkedLender(wad(100), wad(100), blockTimestamp(101)))
    const event = createRemoveCollateralEvent(POOL, 102, 0, LENDER, INDEX, wad(1), wad(100))
    handleRemoveCollateral(event)

    const eventId = eventEntityId(event)
    assert.fieldEquals("RemoveCollateral", eventId, "pool", POOL.toHexString())
    assert.fieldEquals("RemoveCollateral", eventId, "bucket", bucketId(POOL, INDEX))
    assert.fieldEquals("RemoveCollateral", eventId, "claimer", LENDER.toHexString())
    assert.fieldEquals("RemoveCollateral", eventId, "index", "2550")
    assert.fieldEquals("RemoveCollateral", eventId, "amount", "1")
    assert.fieldEquals("RemoveCollateral", eventId, "lpRedeemed", "100")
    assert.fieldEquals("Bucket", bucketId(POOL, INDEX), "collateral", "1")
    assert.fieldEquals("Pool", POOL.toHexString(), "lenderCollateral", "1")
    assert.fieldEquals("Lend", lendId(POOL, INDEX, LENDER), "lpb", "100")
    assert.fieldEquals("Account", LENDER.toHexString(), "txCount", "2")
  })

  test("MoveQuoteToken refreshes both buckets and moves the lend", () => {
    depositQuote(wad(1000), 101)

    // everything moves to another bucket, where the exchange rate is 1.25
    mockBucket(INDEX, quoteBucket(wad(0), wad(0)))
    mockLenderIn(INDEX, LENDER, new LenderState())
    const toBucket = quoteBucket(wad(1000), wad(800))
    toBucket.exchangeRate = BigInt.fromString("1250000000000000000")
    mockBucket(OTHER_INDEX, toBucket)
    // the pool keeps the later of the two deposit times
    mockLenderIn(OTHER_INDEX, LENDER, unmarkedLender(wad(800), wad(1000), blockTimestamp(101)))

    const event = createMoveQuoteTokenEvent(POOL, 102, 0, LENDER, INDEX, OTHER_INDEX, wad(1000), wad(1000), wad(800))
    handleMoveQuoteToken(event)

    const eventId = eventEntityId(event)
    assert.fieldEquals("MoveQuoteToken", eventId, "pool", POOL.toHexString())
    assert.fieldEquals("MoveQuoteToken", eventId, "lender", LENDER.toHexString())
    assert.fieldEquals("MoveQuoteToken", eventId, "from", bucketId(POOL, INDEX))
    assert.fieldEquals("MoveQuoteToken", eventId, "to", bucketId(POOL, OTHER_INDEX))
    assert.fieldEquals("MoveQuoteToken", eventId, "amount", "1000")
    assert.fieldEquals("MoveQuoteToken", eventId, "lpRedeemedFrom", "1000")
    assert.fieldEquals("MoveQuoteToken", eventId, "lpAwardedTo", "800")

    assert.fieldEquals("Bucket", bucketId(POOL, INDEX), "deposit", "0")
    assert.fieldEquals("Bucket", bucketId(POOL, OTHER_INDEX), "deposit", "1000")
    assert.fieldEquals("Bucket", bucketId(POOL, OTHER_INDEX), "lpb", "800")
    assert.fieldEquals("Bucket", bucketId(POOL, OTHER_INDEX), "exchangeRate", "1.25")

    assert.notInStore("Lend", lendId(POOL, INDEX, LENDER))
    assert.fieldEquals("Lend", lendId(POOL, OTHER_INDEX, LENDER), "lpb", "800")
    assert.fieldEquals("Lend", lendId(POOL, OTHER_INDEX, LENDER), "lpbValueInQuote", "1000")
    assert.fieldEquals("Lend", lendId(POOL, OTHER_INDEX, LENDER), "bucketIndex", "2600")
    assert.fieldEquals("Lend", lendId(POOL, OTHER_INDEX, LENDER), "depositTime", blockTimestamp(101).toString())

    // one move is one action
    assert.fieldEquals("Pool", POOL.toHexString(), "txCount", "2")
    assert.fieldEquals("Account", LENDER.toHexString(), "txCount", "2")
  })

  test("records every event of one kind in a transaction", () => {
    const snapshot = new PoolSnapshot()
    snapshot.poolSize = wad(300)
    mockPool(snapshot)
    mockBucket(INDEX, quoteBucket(wad(100), wad(100)))
    mockBucket(OTHER_INDEX, quoteBucket(wad(200), wad(200)))
    mockLenderIn(INDEX, LENDER, unmarkedLender(wad(100), wad(100), blockTimestamp(101)))
    mockLenderIn(OTHER_INDEX, LENDER, unmarkedLender(wad(200), wad(200), blockTimestamp(101)))

    // two deposits made through one multicall: same transaction, consecutive logs
    const first = createAddQuoteTokenEvent(POOL, 101, 0, LENDER, INDEX, wad(100), wad(100))
    const second = createAddQuoteTokenEvent(POOL, 101, 1, LENDER, OTHER_INDEX, wad(200), wad(200))
    assert.bytesEquals(first.transaction.hash, second.transaction.hash)
    handleAddQuoteToken(first)
    handleAddQuoteToken(second)

    assert.entityCount("AddQuoteToken", 2)
    assert.fieldEquals("AddQuoteToken", eventEntityId(first), "amount", "100")
    assert.fieldEquals("AddQuoteToken", eventEntityId(second), "amount", "200")
    assert.entityCount("Lend", 2)
    assert.fieldEquals("Pool", POOL.toHexString(), "txCount", "2")
  })

  test("reads the pool and a bucket once per block", () => {
    depositQuote(wad(1000), 101)

    // Chain state cannot differ within a block. Changing the mocks here only shows whether a
    // second event in block 101 reads again.
    const later = new PoolSnapshot()
    later.poolSize = wad(5000)
    mockPool(later)
    mockBucket(INDEX, quoteBucket(wad(5000), wad(5000)))
    mockLenderIn(INDEX, OTHER_LENDER, unmarkedLender(wad(4000), wad(4000), blockTimestamp(101)))
    handleAddQuoteToken(createAddQuoteTokenEvent(POOL, 101, 1, OTHER_LENDER, INDEX, wad(4000), wad(4000)))

    assert.fieldEquals("Pool", POOL.toHexString(), "poolSize", "1000")
    assert.fieldEquals("Bucket", bucketId(POOL, INDEX), "deposit", "1000")
    // the second lender's own position had not been read in this block
    assert.fieldEquals("Lend", lendId(POOL, INDEX, OTHER_LENDER), "lpb", "4000")
    assert.fieldEquals("Pool", POOL.toHexString(), "txCount", "2")

    // an event in the next block reads again
    mockLenderIn(INDEX, OTHER_LENDER, unmarkedLender(wad(4001), wad(4001), blockTimestamp(102)))
    handleAddQuoteToken(createAddQuoteTokenEvent(POOL, 102, 0, OTHER_LENDER, INDEX, wad(1), wad(1)))

    assert.fieldEquals("Pool", POOL.toHexString(), "poolSize", "5000")
    assert.fieldEquals("Pool", POOL.toHexString(), "updatedAtBlockNumber", "102")
    assert.fieldEquals("Bucket", bucketId(POOL, INDEX), "deposit", "5000")
    assert.fieldEquals("Bucket", bucketId(POOL, INDEX), "updatedAtBlockNumber", "102")
  })

  test("keeps the pool's last state when the readers revert, and catches up at the next event", () => {
    depositQuote(wad(1000), 101)

    mockPoolSnapshotReverts(deployment().poolInfoUtilsMulticall, POOL)
    mockBucket(INDEX, quoteBucket(wad(1500), wad(1500)))
    mockLenderIn(INDEX, LENDER, unmarkedLender(wad(1500), wad(1500), blockTimestamp(102)))
    handleAddQuoteToken(createAddQuoteTokenEvent(POOL, 102, 0, LENDER, INDEX, wad(500), wad(500)))

    // the pool is as it was at block 101, and says so
    assert.fieldEquals("Pool", POOL.toHexString(), "poolSize", "1000")
    assert.fieldEquals("Pool", POOL.toHexString(), "updatedAtBlockNumber", "101")
    // everything else about the event was still recorded
    assert.fieldEquals("Pool", POOL.toHexString(), "txCount", "2")
    assert.entityCount("AddQuoteToken", 2)
    assert.fieldEquals("Bucket", bucketId(POOL, INDEX), "deposit", "1500")
    assert.fieldEquals("Lend", lendId(POOL, INDEX, LENDER), "lpb", "1500")

    const recovered = new PoolSnapshot()
    recovered.poolSize = wad(1600)
    mockPool(recovered)
    mockBucket(INDEX, quoteBucket(wad(1600), wad(1600)))
    mockLenderIn(INDEX, LENDER, unmarkedLender(wad(1600), wad(1600), blockTimestamp(103)))
    handleAddQuoteToken(createAddQuoteTokenEvent(POOL, 103, 0, LENDER, INDEX, wad(100), wad(100)))

    assert.fieldEquals("Pool", POOL.toHexString(), "poolSize", "1600")
    assert.fieldEquals("Pool", POOL.toHexString(), "updatedAtBlockNumber", "103")
  })

  test("reads each pool through the readers of its own factory", () => {
    const deployments = allDeployments()

    // one pool per configured factory, each with a different deposit behind its factory's readers
    for (let i = 0; i < deployments.length; i++) {
      const pool = testAddress(0x2000 + i)
      const deposit = wad(1000 * (i + 1))
      createPool(deployments[i], pool, COLLATERAL, QUOTE, new PoolSnapshot(), CREATED_AT)

      const snapshot = new PoolSnapshot()
      snapshot.poolSize = deposit
      mockPoolSnapshot(deployments[i].poolInfoUtilsMulticall, pool, snapshot)
      const bucket = new BucketState()
      bucket.deposit = deposit
      bucket.lp = deposit
      mockBucketInfo(deployments[i].poolInfoUtils, pool, INDEX, bucket)
      mockLender(
        deployments[i].poolInfoUtils,
        pool,
        INDEX,
        LENDER,
        unmarkedLender(deposit, deposit, blockTimestamp(101))
      )

      handleAddQuoteToken(createAddQuoteTokenEvent(pool, 101, i, LENDER, INDEX, deposit, deposit))
    }

    for (let i = 0; i < deployments.length; i++) {
      const pool = testAddress(0x2000 + i)
      const deposit = (1000 * (i + 1)).toString()
      assert.fieldEquals("Pool", pool.toHexString(), "factory", deployments[i].factory.toHexString())
      assert.fieldEquals("Pool", pool.toHexString(), "poolSize", deposit)
      assert.fieldEquals("Bucket", bucketId(pool, INDEX), "deposit", deposit)
      assert.fieldEquals("Lend", lendId(pool, INDEX, LENDER), "lpb", deposit)
    }
    // the lender acted once in each pool
    assert.fieldEquals("Account", LENDER.toHexString(), "txCount", deployments.length.toString())
  })
})

describe("ERC20Pool LP events", () => {
  beforeEach(() => {
    createPool(deployment(), POOL, COLLATERAL, QUOTE, new PoolSnapshot(), CREATED_AT)
  })

  afterEach(() => {
    clearStore()
  })

  test("TransferLP moves the lend to the new owner and clears the allowance it used", () => {
    depositQuote(wad(1000), 101)
    handleIncreaseLPAllowance(
      createIncreaseLPAllowanceEvent(POOL, 102, 0, LENDER, OTHER_LENDER, [INDEX, OTHER_INDEX], [wad(1000), wad(5)])
    )
    assert.entityCount("LPAllowance", 2)

    // The transfer names two buckets. The owner has LP only in the first, and the event reports
    // just the total.
    mockBucket(INDEX, quoteBucket(wad(1000), wad(1000)))
    mockBucket(OTHER_INDEX, quoteBucket(wad(0), wad(0)))
    mockLenderIn(INDEX, LENDER, new LenderState())
    mockLenderIn(INDEX, OTHER_LENDER, unmarkedLender(wad(1000), wad(1000), blockTimestamp(101)))
    mockLenderIn(OTHER_INDEX, LENDER, new LenderState())
    mockLenderIn(OTHER_INDEX, OTHER_LENDER, new LenderState())

    const event = createTransferLPEvent(POOL, 103, 0, LENDER, OTHER_LENDER, [INDEX, OTHER_INDEX], wad(1000))
    handleTransferLP(event)

    const eventId = eventEntityId(event)
    assert.fieldEquals("TransferLP", eventId, "pool", POOL.toHexString())
    assert.fieldEquals("TransferLP", eventId, "owner", LENDER.toHexString())
    assert.fieldEquals("TransferLP", eventId, "newOwner", OTHER_LENDER.toHexString())
    assert.fieldEquals("TransferLP", eventId, "indexes", "[2550, 2600]")
    assert.fieldEquals("TransferLP", eventId, "lp", "1000")

    assert.notInStore("Lend", lendId(POOL, INDEX, LENDER))
    assert.fieldEquals("Lend", lendId(POOL, INDEX, OTHER_LENDER), "lpb", "1000")
    assert.fieldEquals("Lend", lendId(POOL, INDEX, OTHER_LENDER), "lpbValueInQuote", "1000")
    assert.fieldEquals("Lend", lendId(POOL, INDEX, OTHER_LENDER), "account", OTHER_LENDER.toHexString())
    assert.fieldEquals("Lend", lendId(POOL, INDEX, OTHER_LENDER), "depositTime", blockTimestamp(101).toString())
    // nobody holds LP in the second bucket
    assert.entityCount("Lend", 1)

    // the new owner has an account, though receiving LP is not an action of theirs
    assert.fieldEquals("Account", OTHER_LENDER.toHexString(), "txCount", "0")

    // the pool deleted both allowances, including the one in the bucket with nothing to transfer
    assert.notInStore("LPAllowance", allowanceId(LENDER, OTHER_LENDER, INDEX))
    assert.notInStore("LPAllowance", allowanceId(LENDER, OTHER_LENDER, OTHER_INDEX))
    assert.entityCount("LPAllowance", 0)
  })

  test("LP allowances follow increases, decreases and revocations", () => {
    const listId = getAllowanceListId(POOL, LENDER, OTHER_LENDER).toHexString()

    handleIncreaseLPAllowance(
      createIncreaseLPAllowanceEvent(POOL, 101, 0, LENDER, OTHER_LENDER, [INDEX, OTHER_INDEX], [wad(100), wad(50)])
    )
    assert.fieldEquals("LPAllowanceList", listId, "pool", POOL.toHexString())
    assert.fieldEquals("LPAllowanceList", listId, "lender", LENDER.toHexString())
    assert.fieldEquals("LPAllowanceList", listId, "spender", OTHER_LENDER.toHexString())
    assert.fieldEquals("LPAllowance", allowanceId(LENDER, OTHER_LENDER, INDEX), "allowanceList", listId)
    assert.fieldEquals("LPAllowance", allowanceId(LENDER, OTHER_LENDER, INDEX), "index", "2550")
    assert.fieldEquals("LPAllowance", allowanceId(LENDER, OTHER_LENDER, INDEX), "amount", "100")
    assert.fieldEquals("LPAllowance", allowanceId(LENDER, OTHER_LENDER, OTHER_INDEX), "amount", "50")

    // a further increase adds to the allowance
    handleIncreaseLPAllowance(createIncreaseLPAllowanceEvent(POOL, 102, 0, LENDER, OTHER_LENDER, [INDEX], [wad(25)]))
    assert.fieldEquals("LPAllowance", allowanceId(LENDER, OTHER_LENDER, INDEX), "amount", "125")

    // a decrease takes away from one, and removes the other when it takes all of it
    handleDecreaseLPAllowance(
      createDecreaseLPAllowanceEvent(POOL, 103, 0, LENDER, OTHER_LENDER, [INDEX, OTHER_INDEX], [wad(5), wad(50)])
    )
    assert.fieldEquals("LPAllowance", allowanceId(LENDER, OTHER_LENDER, INDEX), "amount", "120")
    assert.notInStore("LPAllowance", allowanceId(LENDER, OTHER_LENDER, OTHER_INDEX))

    // a revocation removes what is left, and ignores a bucket with no allowance
    handleRevokeLPAllowance(createRevokeLPAllowanceEvent(POOL, 104, 0, LENDER, OTHER_LENDER, [INDEX, OTHER_INDEX]))
    assert.entityCount("LPAllowance", 0)

    assert.fieldEquals("Pool", POOL.toHexString(), "txCount", "4")
  })

  test("keeps the allowances of different spenders and lenders apart", () => {
    const thirdParty = testAddress(0x8003)
    handleIncreaseLPAllowance(createIncreaseLPAllowanceEvent(POOL, 101, 0, LENDER, OTHER_LENDER, [INDEX], [wad(1)]))
    handleIncreaseLPAllowance(createIncreaseLPAllowanceEvent(POOL, 101, 1, LENDER, thirdParty, [INDEX], [wad(2)]))
    handleIncreaseLPAllowance(createIncreaseLPAllowanceEvent(POOL, 101, 2, OTHER_LENDER, LENDER, [INDEX], [wad(3)]))

    assert.entityCount("LPAllowanceList", 3)
    assert.fieldEquals("LPAllowance", allowanceId(LENDER, OTHER_LENDER, INDEX), "amount", "1")
    assert.fieldEquals("LPAllowance", allowanceId(LENDER, thirdParty, INDEX), "amount", "2")
    assert.fieldEquals("LPAllowance", allowanceId(OTHER_LENDER, LENDER, INDEX), "amount", "3")
  })

  test("an allowance change that leaves nothing allowed stores no allowance", () => {
    // an increase by zero, then a decrease and a revocation in buckets with no allowance
    handleIncreaseLPAllowance(createIncreaseLPAllowanceEvent(POOL, 101, 0, LENDER, OTHER_LENDER, [INDEX], [wad(0)]))
    handleDecreaseLPAllowance(createDecreaseLPAllowanceEvent(POOL, 101, 1, LENDER, OTHER_LENDER, [INDEX], [wad(1)]))
    handleRevokeLPAllowance(createRevokeLPAllowanceEvent(POOL, 101, 2, LENDER, OTHER_LENDER, [INDEX]))

    assert.entityCount("LPAllowance", 0)
  })

  test("revoking transferors a lender never approved stores no list", () => {
    handleRevokeLPTransferors(createRevokeLPTransferorsEvent(POOL, 101, 0, LENDER, [testAddress(0x9001)]))

    assert.entityCount("LPTransferorList", 0)
  })

  test("LP transferors follow approvals and revocations", () => {
    const listId = getTransferorListId(POOL, LENDER).toHexString()
    const first = testAddress(0x9001)
    const second = testAddress(0x9002)

    handleApproveLPTransferors(createApproveLPTransferorsEvent(POOL, 101, 0, LENDER, [first, second]))
    assert.fieldEquals("LPTransferorList", listId, "pool", POOL.toHexString())
    assert.fieldEquals("LPTransferorList", listId, "lender", LENDER.toHexString())
    assert.fieldEquals(
      "LPTransferorList",
      listId,
      "transferors",
      "[" + first.toHexString() + ", " + second.toHexString() + "]"
    )

    // approving a transferor again does not list it twice
    handleApproveLPTransferors(createApproveLPTransferorsEvent(POOL, 102, 0, LENDER, [first]))
    assert.fieldEquals(
      "LPTransferorList",
      listId,
      "transferors",
      "[" + first.toHexString() + ", " + second.toHexString() + "]"
    )

    handleRevokeLPTransferors(createRevokeLPTransferorsEvent(POOL, 103, 0, LENDER, [first]))
    assert.fieldEquals("LPTransferorList", listId, "transferors", "[" + second.toHexString() + "]")

    // the list goes when its last transferor is revoked
    handleRevokeLPTransferors(createRevokeLPTransferorsEvent(POOL, 104, 0, LENDER, [second]))
    assert.notInStore("LPTransferorList", listId)

    assert.fieldEquals("Pool", POOL.toHexString(), "txCount", "4")
  })
})

describe("ERC20Pool pool events", () => {
  beforeEach(() => {
    createPool(deployment(), POOL, COLLATERAL, QUOTE, new PoolSnapshot(), CREATED_AT)
  })

  afterEach(() => {
    clearStore()
  })

  test("Flashloan converts the amount from the token's decimals and adds it to the pool's total", () => {
    // a second pool whose quote token has 6 decimals
    const pool = testAddress(0x1001)
    const usd = testAddress(0x7002)
    const receiver = testAddress(0x9003)
    mockLoanTerm(deployment().factory, THIRTY_DAYS)
    mockTokenInfo(usd, "Six Decimal Dollar", "USD6", 6)
    mockPoolSnapshot(deployment().poolInfoUtilsMulticall, pool, new PoolSnapshot())
    handlePoolCreated(createPoolCreatedEvent(deployment().factory, pool, COLLATERAL, usd, CREATED_AT, 1))

    // 2.5 of the quote token, then 3 of the 18-decimal collateral token
    const quoteLoan = createFlashloanEvent(pool, 101, 0, receiver, usd, BigInt.fromI32(2500000))
    handleFlashloan(quoteLoan)
    const collateralLoan = createFlashloanEvent(pool, 101, 1, receiver, COLLATERAL, wad(3))
    handleFlashloan(collateralLoan)

    assert.fieldEquals("Flashloan", eventEntityId(quoteLoan), "pool", pool.toHexString())
    assert.fieldEquals("Flashloan", eventEntityId(quoteLoan), "token", usd.toHexString())
    assert.fieldEquals("Flashloan", eventEntityId(quoteLoan), "borrower", receiver.toHexString())
    assert.fieldEquals("Flashloan", eventEntityId(quoteLoan), "amount", "2.5")
    assert.fieldEquals("Flashloan", eventEntityId(quoteLoan), "blockNumber", "101")
    assert.fieldEquals("Flashloan", eventEntityId(collateralLoan), "token", COLLATERAL.toHexString())
    assert.fieldEquals("Flashloan", eventEntityId(collateralLoan), "amount", "3")

    assert.fieldEquals("Pool", pool.toHexString(), "quoteTokenFlashloaned", "2.5")
    assert.fieldEquals("Pool", pool.toHexString(), "collateralFlashloaned", "3")
    assert.fieldEquals("Pool", pool.toHexString(), "txCount", "2")
    assert.fieldEquals("Token", usd.toHexString(), "txCount", "2")

    // a further loan adds to the total
    handleFlashloan(createFlashloanEvent(pool, 102, 0, receiver, usd, BigInt.fromI32(500000)))
    assert.fieldEquals("Pool", pool.toHexString(), "quoteTokenFlashloaned", "3")
  })

  test("UpdateInterestRate records the change and refreshes the pool", () => {
    const snapshot = new PoolSnapshot()
    snapshot.borrowRate = BigInt.fromString("55000000000000000") // 0.055
    snapshot.utilization = BigInt.fromString("500000000000000000") // 0.5
    mockPool(snapshot)

    const event = createUpdateInterestRateEvent(POOL, 101, 2, FIVE_PERCENT, snapshot.borrowRate)
    handleUpdateInterestRate(event)

    const eventId = eventEntityId(event)
    assert.fieldEquals("UpdateInterestRate", eventId, "pool", POOL.toHexString())
    assert.fieldEquals("UpdateInterestRate", eventId, "oldBorrowRate", "0.05")
    assert.fieldEquals("UpdateInterestRate", eventId, "newBorrowRate", "0.055")
    assert.fieldEquals("UpdateInterestRate", eventId, "blockNumber", "101")

    assert.fieldEquals("Pool", POOL.toHexString(), "borrowRate", "0.055")
    // 0.055 * 0.96 * 0.5
    assert.fieldEquals("Pool", POOL.toHexString(), "lendRate", "0.0264")
    assert.fieldEquals("Pool", POOL.toHexString(), "updatedAtBlockNumber", "101")
    // the rate changed as part of some other action
    assert.fieldEquals("Pool", POOL.toHexString(), "txCount", "0")
  })

  test("UpdateInterestRate still sets the borrow rate when the pool cannot be read", () => {
    mockPoolSnapshotReverts(deployment().poolInfoUtilsMulticall, POOL)

    handleUpdateInterestRate(
      createUpdateInterestRateEvent(POOL, 101, 0, FIVE_PERCENT, BigInt.fromString("60000000000000000"))
    )

    assert.fieldEquals("Pool", POOL.toHexString(), "borrowRate", "0.06")
    assert.fieldEquals("Pool", POOL.toHexString(), "updatedAtBlockNumber", "100")
  })

  test("InterestUpdateFailure is counted and recorded, whether or not the pool can be read", () => {
    mockPoolSnapshotReverts(deployment().poolInfoUtilsMulticall, POOL)
    const first = createInterestUpdateFailureEvent(POOL, 101, 0)
    handleInterestUpdateFailure(first)

    assert.fieldEquals("InterestUpdateFailure", eventEntityId(first), "pool", POOL.toHexString())
    assert.fieldEquals("InterestUpdateFailure", eventEntityId(first), "blockNumber", "101")
    assert.fieldEquals("Pool", POOL.toHexString(), "interestUpdateFailures", "1")
    assert.fieldEquals("Pool", POOL.toHexString(), "updatedAtBlockNumber", "100")

    const snapshot = new PoolSnapshot()
    snapshot.poolSize = wad(10)
    mockPool(snapshot)
    handleInterestUpdateFailure(createInterestUpdateFailureEvent(POOL, 102, 0))

    assert.entityCount("InterestUpdateFailure", 2)
    assert.fieldEquals("Pool", POOL.toHexString(), "interestUpdateFailures", "2")
    assert.fieldEquals("Pool", POOL.toHexString(), "poolSize", "10")
    assert.fieldEquals("Pool", POOL.toHexString(), "txCount", "0")
  })
})
