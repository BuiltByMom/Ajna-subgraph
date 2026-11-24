import { Address, ethereum, log } from "@graphprotocol/graph-ts"

import {
  AddCollateral,
  AddQuoteToken,
  Bucket,
  Flashloan,
  InterestUpdateFailure,
  MoveQuoteToken,
  Pool,
  RemoveCollateral,
  RemoveQuoteToken,
  Token,
  TransferLP,
  UpdateInterestRate
} from "../../generated/schema"
import {
  AddCollateral as AddCollateralEvent,
  AddQuoteToken as AddQuoteTokenEvent,
  ApproveLPTransferors as ApproveLPTransferorsEvent,
  DecreaseLPAllowance as DecreaseLPAllowanceEvent,
  DrawDebt as DrawDebtEvent,
  ExitQueueFunded as ExitQueueFundedEvent,
  Flashloan as FlashloanEvent,
  ImproveLoan as ImproveLoanEvent,
  IncreaseLPAllowance as IncreaseLPAllowanceEvent,
  InterestUpdateFailure as InterestUpdateFailureEvent,
  KickCollateralSurplusAuction as KickCollateralSurplusAuctionEvent,
  KickQuoteSurplusAuction as KickQuoteSurplusAuctionEvent,
  LoanCalled as LoanCalledEvent,
  LoanClosed as LoanClosedEvent,
  MarkQuoteForWithdrawal as MarkQuoteForWithdrawalEvent,
  MoveLoan as MoveLoanEvent,
  MoveQuoteToken as MoveQuoteTokenEvent,
  RemoveCollateral as RemoveCollateralEvent,
  RemoveQuoteToken as RemoveQuoteTokenEvent,
  RepayDebt as RepayDebtEvent,
  RevokeLPAllowance as RevokeLPAllowanceEvent,
  RevokeLPTransferors as RevokeLPTransferorsEvent,
  SetBorrowerDelegates as SetBorrowerDelegatesEvent,
  TakeCollateralSurplus as TakeCollateralSurplusEvent,
  TakeQuoteSurplus as TakeQuoteSurplusEvent,
  TransferLP as TransferLPEvent,
  UpdateInterestRate as UpdateInterestRateEvent
} from "../../generated/templates/ERC20Pool/ERC20Pool"

import { incrementAccountTxCount } from "../utils/account"
import { ONE_BI } from "../utils/constants"
import { bigIntArrayToIntArray, eventId, tokenAmountToDecimal, wadToDecimal } from "../utils/convert"
import { updateBucket } from "../utils/pool/bucket"
import { updateLend } from "../utils/pool/lend"
import { clearAllowances, decreaseAllowances, increaseAllowances } from "../utils/pool/lp-allowances"
import { approveTransferors, revokeTransferors } from "../utils/pool/lp-transferors"
import { countPoolAction, loadPool, updatePool } from "../utils/pool/pool"

// Pool, Bucket and Lend are set from contract reads rather than from event amounts. A read made
// while handling an event returns state as of the end of that event's block, so these entities
// always hold end-of-block state, and events that share a block all write the same values. The
// entity that records each event keeps that event's own amounts.

/*****************************/
/*** Lender Event Handlers ***/
/*****************************/

// Counts a lender's action against the pool and the lender, and refreshes the pool.
function recordLenderAction(event: ethereum.Event, pool: Pool, lender: Address): void {
  countPoolAction(pool)
  updatePool(pool, event.block)
  pool.save()
  incrementAccountTxCount(lender)
}

// Refreshes a bucket and the lender's position in it.
function refreshLend(event: ethereum.Event, pool: Pool, index: i32, lender: Address): Bucket {
  const bucket = updateBucket(pool, index, event.block)
  updateLend(pool, bucket, lender, event.block)
  return bucket
}

export function handleAddCollateral(event: AddCollateralEvent): void {
  const pool = loadPool(event.address)
  const index = event.params.index.toI32()
  recordLenderAction(event, pool, event.params.actor)
  const bucket = refreshLend(event, pool, index, event.params.actor)

  const addCollateral = new AddCollateral(eventId(event))
  addCollateral.pool = pool.id
  addCollateral.bucket = bucket.id
  addCollateral.actor = event.params.actor
  addCollateral.index = index
  addCollateral.amount = wadToDecimal(event.params.amount)
  addCollateral.lpAwarded = wadToDecimal(event.params.lpAwarded)

  addCollateral.blockNumber = event.block.number
  addCollateral.blockTimestamp = event.block.timestamp
  addCollateral.transactionHash = event.transaction.hash
  addCollateral.save()
}

export function handleAddQuoteToken(event: AddQuoteTokenEvent): void {
  const pool = loadPool(event.address)
  const index = event.params.index.toI32()
  recordLenderAction(event, pool, event.params.lender)
  const bucket = refreshLend(event, pool, index, event.params.lender)

  const addQuoteToken = new AddQuoteToken(eventId(event))
  addQuoteToken.pool = pool.id
  addQuoteToken.bucket = bucket.id
  addQuoteToken.lender = event.params.lender
  addQuoteToken.index = index
  addQuoteToken.amount = wadToDecimal(event.params.amount)
  addQuoteToken.lpAwarded = wadToDecimal(event.params.lpAwarded)

  addQuoteToken.blockNumber = event.block.number
  addQuoteToken.blockTimestamp = event.block.timestamp
  addQuoteToken.transactionHash = event.transaction.hash
  addQuoteToken.save()
}

export function handleMoveQuoteToken(event: MoveQuoteTokenEvent): void {
  const pool = loadPool(event.address)
  recordLenderAction(event, pool, event.params.lender)
  const fromBucket = refreshLend(event, pool, event.params.from.toI32(), event.params.lender)
  const toBucket = refreshLend(event, pool, event.params.to.toI32(), event.params.lender)

  const moveQuoteToken = new MoveQuoteToken(eventId(event))
  moveQuoteToken.pool = pool.id
  moveQuoteToken.lender = event.params.lender
  moveQuoteToken.from = fromBucket.id
  moveQuoteToken.to = toBucket.id
  moveQuoteToken.amount = wadToDecimal(event.params.amount)
  moveQuoteToken.lpRedeemedFrom = wadToDecimal(event.params.lpRedeemedFrom)
  moveQuoteToken.lpAwardedTo = wadToDecimal(event.params.lpAwardedTo)

  moveQuoteToken.blockNumber = event.block.number
  moveQuoteToken.blockTimestamp = event.block.timestamp
  moveQuoteToken.transactionHash = event.transaction.hash
  moveQuoteToken.save()
}

// For a marked lender this is a claim of collateral from the bucket's exit escrow, and the
// amount can be zero.
export function handleRemoveCollateral(event: RemoveCollateralEvent): void {
  const pool = loadPool(event.address)
  const index = event.params.index.toI32()
  recordLenderAction(event, pool, event.params.claimer)
  const bucket = refreshLend(event, pool, index, event.params.claimer)

  const removeCollateral = new RemoveCollateral(eventId(event))
  removeCollateral.pool = pool.id
  removeCollateral.bucket = bucket.id
  removeCollateral.claimer = event.params.claimer
  removeCollateral.index = index
  removeCollateral.amount = wadToDecimal(event.params.amount)
  removeCollateral.lpRedeemed = wadToDecimal(event.params.lpRedeemed)

  removeCollateral.blockNumber = event.block.number
  removeCollateral.blockTimestamp = event.block.timestamp
  removeCollateral.transactionHash = event.transaction.hash
  removeCollateral.save()
}

// For a marked lender this is a claim of quote from the bucket's exit escrow, and the amount
// can be zero.
export function handleRemoveQuoteToken(event: RemoveQuoteTokenEvent): void {
  const pool = loadPool(event.address)
  const index = event.params.index.toI32()
  recordLenderAction(event, pool, event.params.lender)
  const bucket = refreshLend(event, pool, index, event.params.lender)

  const removeQuoteToken = new RemoveQuoteToken(eventId(event))
  removeQuoteToken.pool = pool.id
  removeQuoteToken.bucket = bucket.id
  removeQuoteToken.lender = event.params.lender
  removeQuoteToken.index = index
  removeQuoteToken.amount = wadToDecimal(event.params.amount)
  removeQuoteToken.lpRedeemed = wadToDecimal(event.params.lpRedeemed)

  removeQuoteToken.blockNumber = event.block.number
  removeQuoteToken.blockTimestamp = event.block.timestamp
  removeQuoteToken.transactionHash = event.transaction.hash
  removeQuoteToken.save()
}

// Not implemented yet: the lender exit queue.

export function handleMarkQuoteForWithdrawal(event: MarkQuoteForWithdrawalEvent): void {}

export function handleExitQueueFunded(event: ExitQueueFundedEvent): void {}

/*************************************/
/*** LP Management Event Handlers  ***/
/*************************************/

export function handleApproveLPTransferors(event: ApproveLPTransferorsEvent): void {
  const pool = loadPool(event.address)
  countPoolAction(pool)
  pool.save()

  approveTransferors(pool.id, event.params.lender, event.params.transferors)
}

export function handleRevokeLPTransferors(event: RevokeLPTransferorsEvent): void {
  const pool = loadPool(event.address)
  countPoolAction(pool)
  pool.save()

  revokeTransferors(pool.id, event.params.lender, event.params.transferors)
}

export function handleIncreaseLPAllowance(event: IncreaseLPAllowanceEvent): void {
  const pool = loadPool(event.address)
  countPoolAction(pool)
  pool.save()

  increaseAllowances(pool.id, event.params.owner, event.params.spender, event.params.indexes, event.params.amounts)
}

export function handleDecreaseLPAllowance(event: DecreaseLPAllowanceEvent): void {
  const pool = loadPool(event.address)
  countPoolAction(pool)
  pool.save()

  decreaseAllowances(pool.id, event.params.owner, event.params.spender, event.params.indexes, event.params.amounts)
}

export function handleRevokeLPAllowance(event: RevokeLPAllowanceEvent): void {
  const pool = loadPool(event.address)
  countPoolAction(pool)
  pool.save()

  clearAllowances(pool.id, event.params.owner, event.params.spender, event.params.indexes)
}

// The event gives the total LP transferred but not how much moved in each bucket, and it lists
// buckets where the owner had no LP. Each bucket is refreshed along with both lenders'
// positions in it. A transfer does not change pool totals, so the pool is not refreshed.
export function handleTransferLP(event: TransferLPEvent): void {
  const pool = loadPool(event.address)
  countPoolAction(pool)
  pool.save()

  const indexes = event.params.indexes
  for (let i = 0; i < indexes.length; i++) {
    const bucket = updateBucket(pool, indexes[i].toI32(), event.block)
    updateLend(pool, bucket, event.params.owner, event.block)
    updateLend(pool, bucket, event.params.newOwner, event.block)
  }

  // the pool deletes the owner's allowance to the new owner in every bucket named, with no event
  clearAllowances(pool.id, event.params.owner, event.params.newOwner, indexes)

  const transferLP = new TransferLP(eventId(event))
  transferLP.pool = pool.id
  transferLP.owner = event.params.owner
  transferLP.newOwner = event.params.newOwner
  transferLP.indexes = bigIntArrayToIntArray(indexes)
  transferLP.lp = wadToDecimal(event.params.lp)

  transferLP.blockNumber = event.block.number
  transferLP.blockTimestamp = event.block.timestamp
  transferLP.transactionHash = event.transaction.hash
  transferLP.save()
}

/*******************************/
/*** Borrower Event Handlers ***/
/*******************************/

// Not implemented yet: loans.

export function handleDrawDebt(event: DrawDebtEvent): void {}

export function handleRepayDebt(event: RepayDebtEvent): void {}

export function handleMoveLoan(event: MoveLoanEvent): void {}

export function handleImproveLoan(event: ImproveLoanEvent): void {}

export function handleLoanClosed(event: LoanClosedEvent): void {}

export function handleLoanCalled(event: LoanCalledEvent): void {}

export function handleSetBorrowerDelegates(event: SetBorrowerDelegatesEvent): void {}

/**************************************/
/*** Surplus Auction Event Handlers ***/
/**************************************/

// Not implemented yet: surplus auctions.

export function handleKickQuoteSurplusAuction(event: KickQuoteSurplusAuctionEvent): void {}

export function handleTakeQuoteSurplus(event: TakeQuoteSurplusEvent): void {}

export function handleKickCollateralSurplusAuction(event: KickCollateralSurplusAuctionEvent): void {}

export function handleTakeCollateralSurplus(event: TakeCollateralSurplusEvent): void {}

/***************************/
/*** Pool Event Handlers ***/
/***************************/

// The loan is repaid within the same call, so the pool's balances are unchanged and it is not
// refreshed.
export function handleFlashloan(event: FlashloanEvent): void {
  const pool = loadPool(event.address)
  const token = Token.load(event.params.token)
  if (token == null) {
    // a pool only lends its own quote and collateral tokens, which were stored when it was created
    log.critical("handleFlashloan: pool {} lent token {}, which is not one of its tokens", [
      pool.id.toHexString(),
      event.params.token.toHexString()
    ])
    return
  }

  // unlike other pool events, the amount is in the token's own decimals
  const amount = tokenAmountToDecimal(event.params.amount, token.decimals)
  if (token.id.equals(pool.quoteToken)) {
    pool.quoteTokenFlashloaned = pool.quoteTokenFlashloaned.plus(amount)
  } else {
    pool.collateralFlashloaned = pool.collateralFlashloaned.plus(amount)
  }
  countPoolAction(pool)
  pool.save()

  const flashloan = new Flashloan(eventId(event))
  flashloan.pool = pool.id
  flashloan.token = token.id
  flashloan.borrower = event.params.receiver
  flashloan.amount = amount

  flashloan.blockNumber = event.block.number
  flashloan.blockTimestamp = event.block.timestamp
  flashloan.transactionHash = event.transaction.hash
  flashloan.save()
}

// Emitted after an action when it changed the stored borrow rate, so it is not counted as an
// action of its own.
export function handleUpdateInterestRate(event: UpdateInterestRateEvent): void {
  const pool = loadPool(event.address)
  updatePool(pool, event.block)
  if (!pool.updatedAtBlockNumber.equals(event.block.number)) {
    // the pool could not be read in this block, but the event still gives the rate it stored
    pool.borrowRate = wadToDecimal(event.params.newRate)
  }
  pool.save()

  const updateInterestRate = new UpdateInterestRate(eventId(event))
  updateInterestRate.pool = pool.id
  updateInterestRate.oldBorrowRate = wadToDecimal(event.params.oldRate)
  updateInterestRate.newBorrowRate = wadToDecimal(event.params.newRate)

  updateInterestRate.blockNumber = event.block.number
  updateInterestRate.blockTimestamp = event.block.timestamp
  updateInterestRate.transactionHash = event.transaction.hash
  updateInterestRate.save()
}

// Emitted within an action whose interest accrual or rate update reverted; the action itself
// went ahead, so it is not counted as an action of its own.
export function handleInterestUpdateFailure(event: InterestUpdateFailureEvent): void {
  const pool = loadPool(event.address)
  pool.interestUpdateFailures = pool.interestUpdateFailures.plus(ONE_BI)
  updatePool(pool, event.block)
  pool.save()

  const interestUpdateFailure = new InterestUpdateFailure(eventId(event))
  interestUpdateFailure.pool = pool.id

  interestUpdateFailure.blockNumber = event.block.number
  interestUpdateFailure.blockTimestamp = event.block.timestamp
  interestUpdateFailure.transactionHash = event.transaction.hash
  interestUpdateFailure.save()
}
