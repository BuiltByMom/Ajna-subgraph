import { Address, BigInt, Bytes, ethereum, log } from "@graphprotocol/graph-ts"

import { Bucket, Loan, Pool } from "../../../generated/schema"
import { ERC20Pool } from "../../../generated/templates/ERC20Pool/ERC20Pool"

import { ensureAccount } from "../account"
import { ONE_BI, ZERO_BD, ZERO_BI } from "../constants"
import { wadToDecimal } from "../convert"

// values of the LoanStatus enum
export const LOAN_ACTIVE = "Active"
export const LOAN_DEBT_FREE = "DebtFree"
export const LOAN_CLOSED = "Closed"

// A loan id is the borrower's address (20 bytes) followed by a counter (12 bytes, big-endian).
// The counter is per pool, so the same loan id can exist in two pools.

export function getLoanEntityId(poolId: Bytes, loanId: Bytes): Bytes {
  return poolId.concat(Bytes.fromUTF8("|")).concat(loanId)
}

export function loanBorrower(loanId: Bytes): Address {
  return Address.fromBytes(Bytes.fromUint8Array(loanId.slice(0, 20)))
}

export function loanCounter(loanId: Bytes): BigInt {
  // BigInt reads its bytes little-endian
  return BigInt.fromUnsignedBytes(Bytes.fromUint8Array(loanId.slice(20, 32).reverse()))
}

// A loan as it stands before anything is read from chain: the caller refreshes it. Used by the
// two events that introduce a loan id: DrawDebt, and MoveLoan for the loan moved into.
export function createLoan(pool: Pool, loanId: Bytes, bucket: Bucket, block: ethereum.Block): Loan {
  const borrower = loanBorrower(loanId)
  const loan = new Loan(getLoanEntityId(pool.id, loanId))
  loan.pool = pool.id
  loan.poolAddress = pool.id.toHexString()
  loan.loanId = loanId
  loan.counter = loanCounter(loanId)
  loan.borrower = borrower
  loan.account = borrower
  ensureAccount(borrower)
  loan.bucket = bucket.id
  loan.bucketIndex = bucket.bucketIndex

  loan.status = LOAN_CLOSED
  loan.collateralPledged = ZERO_BD
  loan.t0debt = ZERO_BD
  loan.t0Tp = ZERO_BD
  loan.thresholdPrice = ZERO_BD
  // A loan expires one loan term after it opens, at the inflator of the block it opens in.
  // refreshLoan replaces both with the pool's own values, unless the loan closes within the
  // block it opens in and can no longer be read.
  loan.expiry = block.timestamp.plus(pool.loanTerm)
  loan.inflatorAtDraw = pool.inflator

  loan.createdAtBlockNumber = block.number
  loan.createdAtTimestamp = block.timestamp
  loan.updatedAtBlockNumber = ZERO_BI
  loan.updatedAtTimestamp = ZERO_BI
  return loan
}

// For events about a loan that an earlier event must have introduced.
export function loadLoan(pool: Pool, loanId: Bytes): Loan {
  const loan = Loan.load(getLoanEntityId(pool.id, loanId))
  if (loan == null) {
    // every loan id first appears in a DrawDebt, or in a MoveLoan as the loan moved into
    log.critical("loadLoan: pool {} has no Loan entity for loan id {}", [pool.id.toHexString(), loanId.toHexString()])
  }
  return loan!
}

// Refreshes the loan from chain, once per block, and keeps the pool's count of loans with debt
// in step. The caller saves both the loan and the pool.
//
// The read returns state as of the end of the block, so a loan that is repaid, moved or called
// later in the same block already reads as it ends up. A loan left with neither debt nor
// collateral is deleted by the pool and reads as zeros.
export function refreshLoan(pool: Pool, loan: Loan, block: ethereum.Block): void {
  if (loan.updatedAtBlockNumber.equals(block.number)) return

  const details = ERC20Pool.bind(Address.fromBytes(pool.id)).loanDetails(loan.loanId)
  const t0Debt = details.value1
  const collateral = details.value2

  let status = LOAN_CLOSED
  if (!t0Debt.isZero()) {
    status = LOAN_ACTIVE
  } else if (!collateral.isZero()) {
    status = LOAN_DEBT_FREE
  }

  loan.t0debt = wadToDecimal(t0Debt)
  loan.collateralPledged = wadToDecimal(collateral)
  loan.t0Tp = wadToDecimal(details.value3)
  loan.thresholdPrice = loan.t0Tp.times(pool.inflator)
  if (status != LOAN_CLOSED) {
    // neither changes during a loan's life
    loan.expiry = details.value5
    loan.inflatorAtDraw = wadToDecimal(details.value6)
  } else if (loan.closedAtBlockNumber === null) {
    loan.closedAtBlockNumber = block.number
    loan.closedAtTimestamp = block.timestamp
  }

  const hadDebt = loan.status == LOAN_ACTIVE
  const hasDebt = status == LOAN_ACTIVE
  if (hasDebt && !hadDebt) {
    pool.loansCount = pool.loansCount.plus(ONE_BI)
  } else if (hadDebt && !hasDebt) {
    pool.loansCount = pool.loansCount.minus(ONE_BI)
  }

  loan.status = status
  loan.updatedAtBlockNumber = block.number
  loan.updatedAtTimestamp = block.timestamp
}
