import { afterEach, assert, beforeEach, clearStore, describe, test } from "matchstick-as/assembly/index"
import { Address, BigInt, Bytes } from "@graphprotocol/graph-ts"

import {
  handleDrawDebt,
  handleImproveLoan,
  handleLoanCalled,
  handleLoanClosed,
  handleMoveLoan,
  handleRepayDebt,
  handleSetBorrowerDelegates
} from "../src/mappings/erc-20-pool"
import { Loan } from "../generated/schema"
import { Deployment, allDeployments } from "../src/utils/deployments"
import { getBorrowerDelegateId } from "../src/utils/pool/borrower-delegates"
import { getBucketId } from "../src/utils/pool/bucket"
import { getLoanEntityId, loanBorrower, loanCounter } from "../src/utils/pool/loan"
import { THIRTY_DAYS, blockTimestamp, eventEntityId, loanId, testAddress, wad, wadOf } from "./utils/common"
import { createPool } from "./utils/erc-20-pool-factory-utils"
import {
  createDrawDebtEvent,
  createImproveLoanEvent,
  createLoanCalledEvent,
  createLoanClosedEvent,
  createMoveLoanEvent,
  createRepayDebtEvent,
  createSetBorrowerDelegatesEvent
} from "./utils/erc-20-pool-utils"
import {
  BucketState,
  LoanState,
  PoolSnapshot,
  mockBucketInfo,
  mockDeletedLoan,
  mockLoan,
  mockPoolSnapshot,
  mockPoolSnapshotReverts,
  mockPoolT0Debt
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
const BORROWER = testAddress(0xb001)
const KEEPER = testAddress(0xb002)
const CREATED_AT = 100
const INDEX = 2550
const HIGHER_PRICE_INDEX = 2500

const LOAN_1 = loanId(BORROWER, 1)
const LOAN_2 = loanId(BORROWER, 2)

function deployment(): Deployment {
  return allDeployments()[0]
}

function loanEntityId(pool: Address, id: Bytes): string {
  return getLoanEntityId(pool, id).toHexString()
}

// for fields that are not set: Matchstick's fieldEquals cannot see those
function storedLoan(entityId: string): Loan {
  return Loan.load(Bytes.fromHexString(entityId))!
}

function bucketId(index: i32): string {
  return getBucketId(POOL, index).toHexString()
}

// the timestamp a loan opened in the given block expires at
function expiryOf(blockNumber: i32): BigInt {
  return blockTimestamp(blockNumber).plus(THIRTY_DAYS)
}

// the pool with the given t0 debt outstanding, at an inflator of 1
function mockPoolDebt(t0debt: BigInt): void {
  const snapshot = new PoolSnapshot()
  snapshot.poolSize = wad(5000)
  snapshot.debt = t0debt
  snapshot.t0debt = t0debt
  mockPoolSnapshot(deployment().poolInfoUtilsMulticall, POOL, snapshot)
}

// a bucket holding 5000 quote, with the given t0 debt drawn from it and collateral in it
function mockBucketDebt(index: i32, t0debt: BigInt, collateral: BigInt): void {
  const bucket = new BucketState()
  bucket.price = wad(100)
  bucket.deposit = wad(5000)
  bucket.lp = wad(5000)
  bucket.collateral = collateral
  bucket.t0debt = t0debt
  mockBucketInfo(deployment().poolInfoUtils, POOL, index, bucket)
}

// a live loan of BORROWER's opened in the given block; t0Tp is 1.05 * t0Debt / collateral
function liveLoan(t0Debt: BigInt, collateral: BigInt, t0Tp: BigInt, index: i32, openedAt: i32): LoanState {
  const loan = new LoanState()
  loan.t0Debt = t0Debt
  loan.collateral = collateral
  loan.t0Tp = t0Tp
  loan.bucketIndex = index
  loan.expiry = expiryOf(openedAt)
  return loan
}

// BORROWER opens LOAN_1 in block 101: 1000 of debt against 20 collateral, from the bucket at INDEX
function openLoan1(): void {
  mockPoolDebt(wad(1000))
  mockBucketDebt(INDEX, wad(1000), wad(0))
  mockLoan(POOL, LOAN_1, BORROWER, liveLoan(wad(1000), wad(20), wadOf("52.5"), INDEX, 101))
  handleDrawDebt(createDrawDebtEvent(POOL, 101, 0, BORROWER, LOAN_1, INDEX, wad(1000), wad(20)))
}

describe("loan ids", () => {
  test("a loan id is the borrower's address followed by a counter", () => {
    const borrower = Address.fromString("0x1234567890abcdef1234567890abcdef12345678")
    const id = Bytes.fromHexString("0x1234567890abcdef1234567890abcdef12345678" + "000000000000000102030405")

    assert.addressEquals(borrower, loanBorrower(id))
    // 0x0102030405
    assert.bigIntEquals(BigInt.fromString("4328719365"), loanCounter(id))
    assert.bigIntEquals(BigInt.fromI32(1), loanCounter(LOAN_1))
    // decoding leaves the id as it was
    assert.bytesEquals(
      Bytes.fromHexString("0x1234567890abcdef1234567890abcdef12345678" + "000000000000000102030405"),
      id
    )
  })
})

describe("ERC20Pool loan events", () => {
  beforeEach(() => {
    createPool(deployment(), POOL, COLLATERAL, QUOTE, new PoolSnapshot(), CREATED_AT)
  })

  afterEach(() => {
    clearStore()
  })

  test("DrawDebt opens a loan and refreshes the pool and the loan's bucket", () => {
    const snapshot = new PoolSnapshot()
    snapshot.poolSize = wad(5000)
    snapshot.debt = wad(1020)
    snapshot.t0debt = wad(1000)
    snapshot.inflator = BigInt.fromString("1020000000000000000") // 1.02
    mockPoolSnapshot(deployment().poolInfoUtilsMulticall, POOL, snapshot)
    mockBucketDebt(INDEX, wad(1000), wad(0))
    const loan = liveLoan(wad(1000), wad(20), wadOf("52.5"), INDEX, 101)
    loan.inflatorAtDraw = snapshot.inflator
    mockLoan(POOL, LOAN_1, BORROWER, loan)

    const event = createDrawDebtEvent(POOL, 101, 4, BORROWER, LOAN_1, INDEX, wad(1020), wad(20))
    handleDrawDebt(event)

    const id = loanEntityId(POOL, LOAN_1)
    assert.fieldEquals("Loan", id, "pool", POOL.toHexString())
    assert.fieldEquals("Loan", id, "poolAddress", POOL.toHexString())
    assert.fieldEquals("Loan", id, "loanId", LOAN_1.toHexString())
    assert.fieldEquals("Loan", id, "counter", "1")
    assert.fieldEquals("Loan", id, "borrower", BORROWER.toHexString())
    assert.fieldEquals("Loan", id, "account", BORROWER.toHexString())
    assert.fieldEquals("Loan", id, "bucket", bucketId(INDEX))
    assert.fieldEquals("Loan", id, "bucketIndex", "2550")
    assert.fieldEquals("Loan", id, "status", "Active")
    assert.fieldEquals("Loan", id, "collateralPledged", "20")
    assert.fieldEquals("Loan", id, "t0debt", "1000")
    assert.fieldEquals("Loan", id, "t0Tp", "52.5")
    // 52.5 at the pool's inflator of 1.02
    assert.fieldEquals("Loan", id, "thresholdPrice", "53.55")
    assert.fieldEquals("Loan", id, "inflatorAtDraw", "1.02")
    assert.fieldEquals("Loan", id, "expiry", expiryOf(101).toString())
    assert.assertTrue(storedLoan(id).movedFrom === null)
    assert.assertTrue(storedLoan(id).call === null)
    assert.fieldEquals("Loan", id, "createdAtBlockNumber", "101")
    assert.fieldEquals("Loan", id, "createdAtTimestamp", blockTimestamp(101).toString())
    assert.assertTrue(storedLoan(id).closedAtBlockNumber === null)
    assert.fieldEquals("Loan", id, "updatedAtBlockNumber", "101")

    const eventId = eventEntityId(event)
    assert.fieldEquals("DrawDebt", eventId, "pool", POOL.toHexString())
    assert.fieldEquals("DrawDebt", eventId, "loan", id)
    assert.fieldEquals("DrawDebt", eventId, "bucket", bucketId(INDEX))
    assert.fieldEquals("DrawDebt", eventId, "borrower", BORROWER.toHexString())
    assert.fieldEquals("DrawDebt", eventId, "amountBorrowed", "1020")
    assert.fieldEquals("DrawDebt", eventId, "collateralPledged", "20")
    assert.fieldEquals("DrawDebt", eventId, "blockNumber", "101")

    assert.fieldEquals("Pool", POOL.toHexString(), "debt", "1020")
    assert.fieldEquals("Pool", POOL.toHexString(), "t0debt", "1000")
    assert.fieldEquals("Pool", POOL.toHexString(), "loansCount", "1")
    assert.fieldEquals("Pool", POOL.toHexString(), "pledgedCollateral", "20")
    assert.fieldEquals("Pool", POOL.toHexString(), "lenderCollateral", "0")
    assert.fieldEquals("Pool", POOL.toHexString(), "txCount", "1")
    assert.fieldEquals("Bucket", bucketId(INDEX), "t0debt", "1000")
    assert.fieldEquals("Bucket", bucketId(INDEX), "deposit", "5000")
    assert.fieldEquals("Account", BORROWER.toHexString(), "txCount", "1")
    assert.fieldEquals("Token", QUOTE.toHexString(), "txCount", "1")
  })

  test("opens a loan when the pool cannot be read, taking the inflator at draw from the loan", () => {
    // the pool's inflator is still the 1 read when the pool was created
    mockPoolSnapshotReverts(deployment().poolInfoUtilsMulticall, POOL)
    mockPoolT0Debt(POOL, wad(1000))
    mockBucketDebt(INDEX, wad(1000), wad(0))
    const loan = liveLoan(wad(1000), wad(20), wadOf("52.5"), INDEX, 101)
    loan.inflatorAtDraw = BigInt.fromString("1020000000000000000") // 1.02
    mockLoan(POOL, LOAN_1, BORROWER, loan)

    handleDrawDebt(createDrawDebtEvent(POOL, 101, 0, BORROWER, LOAN_1, INDEX, wad(1020), wad(20)))

    const id = loanEntityId(POOL, LOAN_1)
    assert.fieldEquals("Loan", id, "status", "Active")
    assert.fieldEquals("Loan", id, "t0debt", "1000")
    assert.fieldEquals("Loan", id, "inflatorAtDraw", "1.02")
    assert.fieldEquals("Pool", POOL.toHexString(), "inflator", "1")
    assert.fieldEquals("Pool", POOL.toHexString(), "updatedAtBlockNumber", "100")
    // t0 debt is read from the pool itself, so it still matches the loans
    assert.fieldEquals("Pool", POOL.toHexString(), "t0debt", "1000")
    // what follows from the event and the loan is still recorded
    assert.fieldEquals("Pool", POOL.toHexString(), "loansCount", "1")
    assert.fieldEquals("Pool", POOL.toHexString(), "pledgedCollateral", "20")
    assert.fieldEquals("Bucket", bucketId(INDEX), "t0debt", "1000")
  })

  test("DrawDebt with nothing borrowed pledges collateral to the existing loan", () => {
    openLoan1()

    mockLoan(POOL, LOAN_1, BORROWER, liveLoan(wad(1000), wad(30), wad(35), INDEX, 101))
    const event = createDrawDebtEvent(POOL, 102, 0, BORROWER, LOAN_1, INDEX, wad(0), wad(10))
    handleDrawDebt(event)

    const id = loanEntityId(POOL, LOAN_1)
    assert.entityCount("Loan", 1)
    assert.fieldEquals("Loan", id, "collateralPledged", "30")
    assert.fieldEquals("Loan", id, "t0Tp", "35")
    assert.fieldEquals("Loan", id, "status", "Active")
    // a pledge does not extend the loan
    assert.fieldEquals("Loan", id, "expiry", expiryOf(101).toString())
    assert.fieldEquals("Loan", id, "createdAtBlockNumber", "101")
    assert.fieldEquals("DrawDebt", eventEntityId(event), "amountBorrowed", "0")
    assert.fieldEquals("DrawDebt", eventEntityId(event), "collateralPledged", "10")
    assert.fieldEquals("Pool", POOL.toHexString(), "pledgedCollateral", "30")
    assert.fieldEquals("Pool", POOL.toHexString(), "loansCount", "1")
  })

  test("RepayDebt: a partial repayment, clearing the debt, then pulling the collateral", () => {
    openLoan1()
    const id = loanEntityId(POOL, LOAN_1)

    // part of the debt is repaid
    mockPoolDebt(wad(600))
    mockBucketDebt(INDEX, wad(600), wad(0))
    mockLoan(POOL, LOAN_1, BORROWER, liveLoan(wad(600), wad(20), wadOf("31.5"), INDEX, 101))
    const partial = createRepayDebtEvent(POOL, 102, 0, BORROWER, LOAN_1, INDEX, wad(400), wad(0))
    handleRepayDebt(partial)

    assert.fieldEquals("RepayDebt", eventEntityId(partial), "pool", POOL.toHexString())
    assert.fieldEquals("RepayDebt", eventEntityId(partial), "loan", id)
    assert.fieldEquals("RepayDebt", eventEntityId(partial), "bucket", bucketId(INDEX))
    assert.fieldEquals("RepayDebt", eventEntityId(partial), "borrower", BORROWER.toHexString())
    assert.fieldEquals("RepayDebt", eventEntityId(partial), "quoteRepaid", "400")
    assert.fieldEquals("RepayDebt", eventEntityId(partial), "collateralPulled", "0")
    assert.fieldEquals("Loan", id, "status", "Active")
    assert.fieldEquals("Loan", id, "t0debt", "600")
    assert.fieldEquals("Bucket", bucketId(INDEX), "t0debt", "600")
    assert.fieldEquals("Pool", POOL.toHexString(), "loansCount", "1")

    // The rest is repaid and the collateral left on the loan. repayDebt emits LoanClosed first.
    mockPoolDebt(wad(0))
    mockBucketDebt(INDEX, wad(0), wad(0))
    mockLoan(POOL, LOAN_1, BORROWER, liveLoan(wad(0), wad(20), wad(0), INDEX, 101))
    const debtCleared = createLoanClosedEvent(POOL, 103, 0, BORROWER, LOAN_1, false)
    handleLoanClosed(debtCleared)
    handleRepayDebt(createRepayDebtEvent(POOL, 103, 1, BORROWER, LOAN_1, INDEX, wad(600), wad(0)))

    assert.fieldEquals("LoanClosed", eventEntityId(debtCleared), "pool", POOL.toHexString())
    assert.fieldEquals("LoanClosed", eventEntityId(debtCleared), "loan", id)
    assert.fieldEquals("LoanClosed", eventEntityId(debtCleared), "borrower", BORROWER.toHexString())
    assert.fieldEquals("LoanClosed", eventEntityId(debtCleared), "deleted", "false")
    assert.fieldEquals("Loan", id, "status", "DebtFree")
    assert.fieldEquals("Loan", id, "t0debt", "0")
    assert.fieldEquals("Loan", id, "collateralPledged", "20")
    assert.assertTrue(storedLoan(id).closedAtBlockNumber === null)
    assert.fieldEquals("Bucket", bucketId(INDEX), "t0debt", "0")
    assert.fieldEquals("Pool", POOL.toHexString(), "loansCount", "0")
    assert.fieldEquals("Pool", POOL.toHexString(), "pledgedCollateral", "20")

    // the collateral is pulled, which deletes the loan
    mockDeletedLoan(POOL, LOAN_1)
    const deleted = createLoanClosedEvent(POOL, 104, 0, BORROWER, LOAN_1, true)
    handleLoanClosed(deleted)
    handleRepayDebt(createRepayDebtEvent(POOL, 104, 1, BORROWER, LOAN_1, INDEX, wad(0), wad(20)))

    assert.fieldEquals("LoanClosed", eventEntityId(deleted), "deleted", "true")
    assert.fieldEquals("Loan", id, "status", "Closed")
    assert.fieldEquals("Loan", id, "collateralPledged", "0")
    assert.fieldEquals("Loan", id, "closedAtBlockNumber", "104")
    assert.fieldEquals("Loan", id, "closedAtTimestamp", blockTimestamp(104).toString())
    // the loan is kept, with the bucket and expiry it had
    assert.fieldEquals("Loan", id, "bucketIndex", "2550")
    assert.fieldEquals("Loan", id, "expiry", expiryOf(101).toString())
    assert.fieldEquals("Loan", id, "inflatorAtDraw", "1")
    assert.fieldEquals("Pool", POOL.toHexString(), "pledgedCollateral", "0")
    assert.fieldEquals("Pool", POOL.toHexString(), "loansCount", "0")

    assert.entityCount("RepayDebt", 3)
    assert.entityCount("LoanClosed", 2)
    // LoanClosed is part of the repayment, not an action of its own
    assert.fieldEquals("Pool", POOL.toHexString(), "txCount", "4")
    assert.fieldEquals("Account", BORROWER.toHexString(), "txCount", "4")
  })

  test("drawing against a debt-free loan closes it and opens a new loan with its collateral", () => {
    openLoan1()
    mockPoolDebt(wad(0))
    mockBucketDebt(INDEX, wad(0), wad(0))
    mockLoan(POOL, LOAN_1, BORROWER, liveLoan(wad(0), wad(20), wad(0), INDEX, 101))
    handleLoanClosed(createLoanClosedEvent(POOL, 102, 0, BORROWER, LOAN_1, false))
    handleRepayDebt(createRepayDebtEvent(POOL, 102, 1, BORROWER, LOAN_1, INDEX, wad(1000), wad(0)))

    // drawDebt emits LoanClosed for the old loan, then DrawDebt for the new one. The new loan
    // holds the old loan's 20 collateral plus the 5 transferred in.
    mockPoolDebt(wad(500))
    mockBucketDebt(HIGHER_PRICE_INDEX, wad(500), wad(0))
    mockDeletedLoan(POOL, LOAN_1)
    mockLoan(POOL, LOAN_2, BORROWER, liveLoan(wad(500), wad(25), wad(21), HIGHER_PRICE_INDEX, 103))
    handleLoanClosed(createLoanClosedEvent(POOL, 103, 0, BORROWER, LOAN_1, true))
    const draw = createDrawDebtEvent(POOL, 103, 1, BORROWER, LOAN_2, HIGHER_PRICE_INDEX, wad(500), wad(5))
    handleDrawDebt(draw)

    assert.entityCount("Loan", 2)
    assert.fieldEquals("Loan", loanEntityId(POOL, LOAN_1), "status", "Closed")
    assert.fieldEquals("Loan", loanEntityId(POOL, LOAN_1), "closedAtBlockNumber", "103")
    const id = loanEntityId(POOL, LOAN_2)
    assert.fieldEquals("Loan", id, "status", "Active")
    assert.fieldEquals("Loan", id, "counter", "2")
    assert.fieldEquals("Loan", id, "collateralPledged", "25")
    assert.fieldEquals("Loan", id, "bucketIndex", "2500")
    assert.fieldEquals("Loan", id, "expiry", expiryOf(103).toString())
    assert.assertTrue(storedLoan(id).movedFrom === null)
    assert.fieldEquals("DrawDebt", eventEntityId(draw), "loan", id)
    assert.fieldEquals("DrawDebt", eventEntityId(draw), "collateralPledged", "5")

    // only the 5 transferred in is new to the pool
    assert.fieldEquals("Pool", POOL.toHexString(), "pledgedCollateral", "25")
    assert.fieldEquals("Pool", POOL.toHexString(), "loansCount", "1")
  })

  test("MoveLoan moves part of a loan's debt into a new loan in another bucket", () => {
    openLoan1()

    // 400 of debt and 8 collateral move; the source keeps the rest, so there is no LoanClosed
    mockPoolDebt(wad(1000))
    mockBucketDebt(INDEX, wad(600), wad(0))
    mockBucketDebt(HIGHER_PRICE_INDEX, wad(400), wad(0))
    mockLoan(POOL, LOAN_1, BORROWER, liveLoan(wad(600), wad(12), wadOf("52.5"), INDEX, 101))
    mockLoan(POOL, LOAN_2, BORROWER, liveLoan(wad(400), wad(8), wadOf("52.5"), HIGHER_PRICE_INDEX, 102))
    const event = createMoveLoanEvent(
      POOL,
      102,
      0,
      BORROWER,
      LOAN_1,
      LOAN_2,
      INDEX,
      HIGHER_PRICE_INDEX,
      wad(400),
      wad(8)
    )
    handleMoveLoan(event)

    const fromId = loanEntityId(POOL, LOAN_1)
    const toId = loanEntityId(POOL, LOAN_2)
    assert.fieldEquals("Loan", fromId, "status", "Active")
    assert.fieldEquals("Loan", fromId, "t0debt", "600")
    assert.fieldEquals("Loan", fromId, "collateralPledged", "12")
    // the source keeps its term
    assert.fieldEquals("Loan", fromId, "expiry", expiryOf(101).toString())

    assert.fieldEquals("Loan", toId, "status", "Active")
    assert.fieldEquals("Loan", toId, "t0debt", "400")
    assert.fieldEquals("Loan", toId, "collateralPledged", "8")
    assert.fieldEquals("Loan", toId, "bucket", bucketId(HIGHER_PRICE_INDEX))
    assert.fieldEquals("Loan", toId, "bucketIndex", "2500")
    assert.fieldEquals("Loan", toId, "borrower", BORROWER.toHexString())
    assert.fieldEquals("Loan", toId, "movedFrom", fromId)
    // the new loan gets a fresh term
    assert.fieldEquals("Loan", toId, "expiry", expiryOf(102).toString())
    assert.fieldEquals("Loan", toId, "createdAtBlockNumber", "102")

    const eventId = eventEntityId(event)
    assert.fieldEquals("MoveLoan", eventId, "pool", POOL.toHexString())
    assert.fieldEquals("MoveLoan", eventId, "borrower", BORROWER.toHexString())
    assert.fieldEquals("MoveLoan", eventId, "fromLoan", fromId)
    assert.fieldEquals("MoveLoan", eventId, "toLoan", toId)
    assert.fieldEquals("MoveLoan", eventId, "fromBucket", bucketId(INDEX))
    assert.fieldEquals("MoveLoan", eventId, "toBucket", bucketId(HIGHER_PRICE_INDEX))
    assert.fieldEquals("MoveLoan", eventId, "debtMoved", "400")
    assert.fieldEquals("MoveLoan", eventId, "collateralMoved", "8")

    assert.fieldEquals("Bucket", bucketId(INDEX), "t0debt", "600")
    assert.fieldEquals("Bucket", bucketId(HIGHER_PRICE_INDEX), "t0debt", "400")
    // a move changes neither total
    assert.fieldEquals("Pool", POOL.toHexString(), "pledgedCollateral", "20")
    assert.fieldEquals("Pool", POOL.toHexString(), "t0debt", "1000")
    assert.fieldEquals("Pool", POOL.toHexString(), "loansCount", "2")
    assert.fieldEquals("Pool", POOL.toHexString(), "txCount", "2")
    assert.fieldEquals("Account", BORROWER.toHexString(), "txCount", "2")
  })

  test("MoveLoan moves collateral alone into a loan the borrower already has", () => {
    openLoan1()
    mockPoolDebt(wad(1500))
    mockBucketDebt(HIGHER_PRICE_INDEX, wad(500), wad(0))
    mockLoan(POOL, LOAN_2, BORROWER, liveLoan(wad(500), wad(10), wadOf("52.5"), HIGHER_PRICE_INDEX, 102))
    handleDrawDebt(createDrawDebtEvent(POOL, 102, 0, BORROWER, LOAN_2, HIGHER_PRICE_INDEX, wad(500), wad(10)))

    mockLoan(POOL, LOAN_1, BORROWER, liveLoan(wad(1000), wad(18), wadOf("58.333333333333333334"), INDEX, 101))
    mockLoan(POOL, LOAN_2, BORROWER, liveLoan(wad(500), wad(12), wadOf("43.75"), HIGHER_PRICE_INDEX, 102))
    const event = createMoveLoanEvent(POOL, 103, 0, BORROWER, LOAN_1, LOAN_2, INDEX, HIGHER_PRICE_INDEX, wad(0), wad(2))
    handleMoveLoan(event)

    assert.entityCount("Loan", 2)
    assert.fieldEquals("Loan", loanEntityId(POOL, LOAN_1), "collateralPledged", "18")
    assert.fieldEquals("Loan", loanEntityId(POOL, LOAN_2), "collateralPledged", "12")
    assert.fieldEquals("Loan", loanEntityId(POOL, LOAN_2), "t0debt", "500")
    // the destination was opened by a draw, not by this move, and keeps its term
    assert.assertTrue(storedLoan(loanEntityId(POOL, LOAN_2)).movedFrom === null)
    assert.fieldEquals("Loan", loanEntityId(POOL, LOAN_2), "expiry", expiryOf(102).toString())
    assert.fieldEquals("MoveLoan", eventEntityId(event), "debtMoved", "0")
    assert.fieldEquals("MoveLoan", eventEntityId(event), "collateralMoved", "2")
    assert.fieldEquals("Pool", POOL.toHexString(), "pledgedCollateral", "30")
    assert.fieldEquals("Pool", POOL.toHexString(), "loansCount", "2")
  })

  test("improveLoan: MoveLoan, LoanClosed, then ImproveLoan move the whole loan to a new one", () => {
    openLoan1()

    mockPoolDebt(wad(1000))
    mockBucketDebt(INDEX, wad(0), wad(0))
    mockBucketDebt(HIGHER_PRICE_INDEX, wad(1000), wad(0))
    mockDeletedLoan(POOL, LOAN_1)
    mockLoan(POOL, LOAN_2, BORROWER, liveLoan(wad(1000), wad(20), wadOf("52.5"), HIGHER_PRICE_INDEX, 102))
    handleMoveLoan(
      createMoveLoanEvent(POOL, 102, 0, BORROWER, LOAN_1, LOAN_2, INDEX, HIGHER_PRICE_INDEX, wad(1000), wad(20))
    )
    handleLoanClosed(createLoanClosedEvent(POOL, 102, 1, BORROWER, LOAN_1, true))
    const improve = createImproveLoanEvent(POOL, 102, 2, KEEPER, LOAN_1, LOAN_2)
    handleImproveLoan(improve)

    const fromId = loanEntityId(POOL, LOAN_1)
    const toId = loanEntityId(POOL, LOAN_2)
    assert.fieldEquals("Loan", fromId, "status", "Closed")
    assert.fieldEquals("Loan", fromId, "closedAtBlockNumber", "102")
    assert.fieldEquals("Loan", toId, "status", "Active")
    assert.fieldEquals("Loan", toId, "t0debt", "1000")
    assert.fieldEquals("Loan", toId, "collateralPledged", "20")
    assert.fieldEquals("Loan", toId, "bucketIndex", "2500")
    assert.fieldEquals("Loan", toId, "movedFrom", fromId)
    assert.fieldEquals("Loan", toId, "expiry", expiryOf(102).toString())

    const eventId = eventEntityId(improve)
    assert.fieldEquals("ImproveLoan", eventId, "pool", POOL.toHexString())
    assert.fieldEquals("ImproveLoan", eventId, "caller", KEEPER.toHexString())
    assert.fieldEquals("ImproveLoan", eventId, "fromLoan", fromId)
    assert.fieldEquals("ImproveLoan", eventId, "toLoan", toId)
    assert.entityCount("MoveLoan", 1)
    assert.entityCount("LoanClosed", 1)

    // one loan with debt before, one after
    assert.fieldEquals("Pool", POOL.toHexString(), "loansCount", "1")
    assert.fieldEquals("Pool", POOL.toHexString(), "pledgedCollateral", "20")
    // the draw and the improvement: three events, one action
    assert.fieldEquals("Pool", POOL.toHexString(), "txCount", "2")
    assert.fieldEquals("Account", BORROWER.toHexString(), "txCount", "2")
    assert.notInStore("Account", KEEPER.toHexString())
  })

  test("callLoan: LoanClosed, then LoanCalled, leaving the borrower's remainder on the loan", () => {
    openLoan1()

    // Of the loan's 20 collateral, 10.1 goes to the bucket, 0.2 to the caller and 0.3 to
    // surplus; 9.4 stays on the loan for the borrower.
    mockPoolDebt(wad(0))
    mockBucketDebt(INDEX, wad(0), wadOf("10.1"))
    mockLoan(POOL, LOAN_1, BORROWER, liveLoan(wad(0), wadOf("9.4"), wad(0), INDEX, 101))
    handleLoanClosed(createLoanClosedEvent(POOL, 102, 0, BORROWER, LOAN_1, false))
    const event = createLoanCalledEvent(POOL, 102, 1, LOAN_1, KEEPER, wad(1010), wadOf("10.1"), wadOf("0.2"), wadOf("0.3"))
    handleLoanCalled(event)

    const id = loanEntityId(POOL, LOAN_1)
    const eventId = eventEntityId(event)
    assert.fieldEquals("LoanCalled", eventId, "pool", POOL.toHexString())
    assert.fieldEquals("LoanCalled", eventId, "loan", id)
    // the event itself names neither of these
    assert.fieldEquals("LoanCalled", eventId, "bucket", bucketId(INDEX))
    assert.fieldEquals("LoanCalled", eventId, "borrower", BORROWER.toHexString())
    assert.fieldEquals("LoanCalled", eventId, "caller", KEEPER.toHexString())
    assert.fieldEquals("LoanCalled", eventId, "debt", "1010")
    assert.fieldEquals("LoanCalled", eventId, "lenderCollateral", "10.1")
    assert.fieldEquals("LoanCalled", eventId, "callerCollateral", "0.2")
    assert.fieldEquals("LoanCalled", eventId, "surplusCollateral", "0.3")

    assert.fieldEquals("Loan", id, "status", "DebtFree")
    assert.fieldEquals("Loan", id, "t0debt", "0")
    assert.fieldEquals("Loan", id, "collateralPledged", "9.4")
    assert.fieldEquals("Loan", id, "call", eventId)
    assert.assertTrue(storedLoan(id).closedAtBlockNumber === null)

    assert.fieldEquals("Bucket", bucketId(INDEX), "collateral", "10.1")
    assert.fieldEquals("Bucket", bucketId(INDEX), "t0debt", "0")
    assert.fieldEquals("Pool", POOL.toHexString(), "pledgedCollateral", "9.4")
    assert.fieldEquals("Pool", POOL.toHexString(), "lenderCollateral", "10.1")
    assert.fieldEquals("Pool", POOL.toHexString(), "loansCount", "0")
    assert.fieldEquals("Pool", POOL.toHexString(), "txCount", "2")
    // the call is an action on the borrower's loan
    assert.fieldEquals("Account", BORROWER.toHexString(), "txCount", "2")
  })

  test("callLoan that takes all of the collateral deletes the loan", () => {
    openLoan1()

    mockPoolDebt(wad(0))
    mockBucketDebt(INDEX, wad(0), wadOf("19.5"))
    mockDeletedLoan(POOL, LOAN_1)
    handleLoanClosed(createLoanClosedEvent(POOL, 102, 0, BORROWER, LOAN_1, true))
    const event = createLoanCalledEvent(POOL, 102, 1, LOAN_1, KEEPER, wad(1900), wadOf("19.5"), wadOf("0.25"), wadOf("0.25"))
    handleLoanCalled(event)

    const id = loanEntityId(POOL, LOAN_1)
    assert.fieldEquals("Loan", id, "status", "Closed")
    assert.fieldEquals("Loan", id, "collateralPledged", "0")
    assert.fieldEquals("Loan", id, "call", eventEntityId(event))
    assert.fieldEquals("Loan", id, "closedAtBlockNumber", "102")
    // the deleted loan could no longer be read, and the event has no bucket: it came from the Loan
    assert.fieldEquals("LoanCalled", eventEntityId(event), "bucket", bucketId(INDEX))
    assert.fieldEquals("Pool", POOL.toHexString(), "pledgedCollateral", "0")
    assert.fieldEquals("Pool", POOL.toHexString(), "lenderCollateral", "19.5")
    assert.fieldEquals("Pool", POOL.toHexString(), "loansCount", "0")
  })

  test("a loan opened and closed in one block is recorded as closed, with what its events say", () => {
    // By the end of the block the loan is gone, so it reads as zeros even while its DrawDebt is handled.
    const snapshot = new PoolSnapshot()
    snapshot.poolSize = wad(5000)
    snapshot.inflator = BigInt.fromString("1020000000000000000") // 1.02
    mockPoolSnapshot(deployment().poolInfoUtilsMulticall, POOL, snapshot)
    mockBucketDebt(INDEX, wad(0), wad(0))
    mockDeletedLoan(POOL, LOAN_1)

    const draw = createDrawDebtEvent(POOL, 101, 0, BORROWER, LOAN_1, INDEX, wad(1000), wad(20))
    handleDrawDebt(draw)
    const closed = createLoanClosedEvent(POOL, 101, 1, BORROWER, LOAN_1, true)
    handleLoanClosed(closed)
    const repay = createRepayDebtEvent(POOL, 101, 2, BORROWER, LOAN_1, INDEX, wad(1000), wad(20))
    handleRepayDebt(repay)

    const id = loanEntityId(POOL, LOAN_1)
    assert.fieldEquals("Loan", id, "status", "Closed")
    assert.fieldEquals("Loan", id, "t0debt", "0")
    assert.fieldEquals("Loan", id, "collateralPledged", "0")
    assert.fieldEquals("Loan", id, "createdAtBlockNumber", "101")
    assert.fieldEquals("Loan", id, "closedAtBlockNumber", "101")
    // from the DrawDebt event, the pool's loan term and the pool's inflator in that block
    assert.fieldEquals("Loan", id, "bucketIndex", "2550")
    assert.fieldEquals("Loan", id, "expiry", expiryOf(101).toString())
    assert.fieldEquals("Loan", id, "inflatorAtDraw", "1.02")

    assert.fieldEquals("DrawDebt", eventEntityId(draw), "loan", id)
    assert.fieldEquals("LoanClosed", eventEntityId(closed), "loan", id)
    assert.fieldEquals("RepayDebt", eventEntityId(repay), "loan", id)
    // the loan never counted as having debt, and what was pledged was pulled again
    assert.fieldEquals("Pool", POOL.toHexString(), "loansCount", "0")
    assert.fieldEquals("Pool", POOL.toHexString(), "pledgedCollateral", "0")
    assert.fieldEquals("Pool", POOL.toHexString(), "txCount", "2")
  })

  test("reads a loan once per block", () => {
    openLoan1()

    // Chain state cannot differ within a block. Changing the mock here only shows whether a
    // second event for the loan in block 101 reads it again.
    mockLoan(POOL, LOAN_1, BORROWER, liveLoan(wad(1000), wad(30), wad(35), INDEX, 101))
    handleDrawDebt(createDrawDebtEvent(POOL, 101, 1, BORROWER, LOAN_1, INDEX, wad(0), wad(10)))
    assert.fieldEquals("Loan", loanEntityId(POOL, LOAN_1), "collateralPledged", "20")
    // the pledge itself is still added to the pool's total
    assert.fieldEquals("Pool", POOL.toHexString(), "pledgedCollateral", "30")

    handleDrawDebt(createDrawDebtEvent(POOL, 102, 0, BORROWER, LOAN_1, INDEX, wad(0), wad(1)))
    assert.fieldEquals("Loan", loanEntityId(POOL, LOAN_1), "collateralPledged", "30")
    assert.fieldEquals("Loan", loanEntityId(POOL, LOAN_1), "updatedAtBlockNumber", "102")
    assert.fieldEquals("Pool", POOL.toHexString(), "loansCount", "1")
  })

  test("the same loan id in two pools is two loans", () => {
    const otherPool = testAddress(0x1001)
    createPool(deployment(), otherPool, COLLATERAL, testAddress(0x7002), new PoolSnapshot(), CREATED_AT)
    openLoan1()

    // each pool numbers its loans from 1, so the same borrower's first loan has the same id in both
    const snapshot = new PoolSnapshot()
    snapshot.t0debt = wad(300)
    mockPoolSnapshot(deployment().poolInfoUtilsMulticall, otherPool, snapshot)
    const bucket = new BucketState()
    bucket.t0debt = wad(300)
    mockBucketInfo(deployment().poolInfoUtils, otherPool, INDEX, bucket)
    mockLoan(otherPool, LOAN_1, BORROWER, liveLoan(wad(300), wad(6), wadOf("52.5"), INDEX, 101))
    handleDrawDebt(createDrawDebtEvent(otherPool, 101, 1, BORROWER, LOAN_1, INDEX, wad(300), wad(6)))

    assert.entityCount("Loan", 2)
    assert.fieldEquals("Loan", loanEntityId(POOL, LOAN_1), "t0debt", "1000")
    assert.fieldEquals("Loan", loanEntityId(POOL, LOAN_1), "pool", POOL.toHexString())
    assert.fieldEquals("Loan", loanEntityId(otherPool, LOAN_1), "t0debt", "300")
    assert.fieldEquals("Loan", loanEntityId(otherPool, LOAN_1), "pool", otherPool.toHexString())
    assert.fieldEquals("Pool", POOL.toHexString(), "loansCount", "1")
    assert.fieldEquals("Pool", otherPool.toHexString(), "loansCount", "1")
    assert.fieldEquals("Pool", otherPool.toHexString(), "pledgedCollateral", "6")
    assert.fieldEquals("Account", BORROWER.toHexString(), "txCount", "2")
  })

  test("SetBorrowerDelegates approves and revokes delegates", () => {
    const first = testAddress(0xd001)
    const second = testAddress(0xd002)
    const firstId = getBorrowerDelegateId(POOL, BORROWER, first).toHexString()
    const secondId = getBorrowerDelegateId(POOL, BORROWER, second).toHexString()

    const approve = createSetBorrowerDelegatesEvent(POOL, 101, 0, BORROWER, [first, second], true)
    handleSetBorrowerDelegates(approve)

    assert.fieldEquals("BorrowerDelegate", firstId, "pool", POOL.toHexString())
    assert.fieldEquals("BorrowerDelegate", firstId, "borrower", BORROWER.toHexString())
    assert.fieldEquals("BorrowerDelegate", firstId, "delegate", first.toHexString())
    assert.fieldEquals("BorrowerDelegate", secondId, "delegate", second.toHexString())
    assert.fieldEquals("SetBorrowerDelegates", eventEntityId(approve), "pool", POOL.toHexString())
    assert.fieldEquals("SetBorrowerDelegates", eventEntityId(approve), "borrower", BORROWER.toHexString())
    assert.fieldEquals(
      "SetBorrowerDelegates",
      eventEntityId(approve),
      "delegates",
      "[" + first.toHexString() + ", " + second.toHexString() + "]"
    )
    assert.fieldEquals("SetBorrowerDelegates", eventEntityId(approve), "approved", "true")

    // approving a delegate again changes nothing
    handleSetBorrowerDelegates(createSetBorrowerDelegatesEvent(POOL, 102, 0, BORROWER, [first], true))
    assert.entityCount("BorrowerDelegate", 2)

    // revoking one delegate, and one that was never approved
    const revoke = createSetBorrowerDelegatesEvent(POOL, 103, 0, BORROWER, [first, testAddress(0xd003)], false)
    handleSetBorrowerDelegates(revoke)

    assert.notInStore("BorrowerDelegate", firstId)
    assert.entityCount("BorrowerDelegate", 1)
    assert.fieldEquals("BorrowerDelegate", secondId, "delegate", second.toHexString())
    assert.fieldEquals("SetBorrowerDelegates", eventEntityId(revoke), "approved", "false")
    assert.entityCount("SetBorrowerDelegates", 3)

    assert.fieldEquals("Pool", POOL.toHexString(), "txCount", "3")
    assert.fieldEquals("Account", BORROWER.toHexString(), "txCount", "3")
  })

  test("a delegate approved by one borrower is not a delegate of another", () => {
    const delegate = testAddress(0xd001)
    const otherBorrower = testAddress(0xb003)
    handleSetBorrowerDelegates(createSetBorrowerDelegatesEvent(POOL, 101, 0, BORROWER, [delegate], true))
    handleSetBorrowerDelegates(createSetBorrowerDelegatesEvent(POOL, 101, 1, otherBorrower, [delegate], true))
    handleSetBorrowerDelegates(createSetBorrowerDelegatesEvent(POOL, 102, 0, BORROWER, [delegate], false))

    assert.notInStore("BorrowerDelegate", getBorrowerDelegateId(POOL, BORROWER, delegate).toHexString())
    assert.fieldEquals(
      "BorrowerDelegate",
      getBorrowerDelegateId(POOL, otherBorrower, delegate).toHexString(),
      "borrower",
      otherBorrower.toHexString()
    )
  })
})
