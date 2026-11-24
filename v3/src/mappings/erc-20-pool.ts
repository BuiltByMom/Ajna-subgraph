import { Address, Bytes, ethereum, log } from "@graphprotocol/graph-ts"

import {
  AddCollateral,
  AddQuoteToken,
  Bucket,
  DrawDebt,
  ExitQueueFunded,
  Flashloan,
  ImproveLoan,
  InterestUpdateFailure,
  Loan,
  LoanCalled,
  LoanClosed,
  MarkQuoteForWithdrawal,
  MoveLoan,
  MoveQuoteToken,
  Pool,
  RemoveCollateral,
  RemoveQuoteToken,
  RepayDebt,
  SetBorrowerDelegates,
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
import { bigIntArrayToIntArray, decimalToWad, eventId, tokenAmountToDecimal, wadToDecimal } from "../utils/convert"
import { setBorrowerDelegates } from "../utils/pool/borrower-delegates"
import { updateBucket } from "../utils/pool/bucket"
import {
  claimCollateralFromExitQueue,
  claimQuoteFromExitQueue,
  fundExitQueue,
  openExitQueuePlace
} from "../utils/pool/exit-queue"
import { updateLend } from "../utils/pool/lend"
import { createLoan, getLoanEntityId, loadLoan, refreshLoan } from "../utils/pool/loan"
import { clearAllowances, decreaseAllowances, increaseAllowances } from "../utils/pool/lp-allowances"
import { approveTransferors, revokeTransferors } from "../utils/pool/lp-transferors"
import { countPoolAction, lendRate, loadPool, updatePool } from "../utils/pool/pool"
import { SURPLUS_COLLATERAL, SURPLUS_QUOTE, kickSurplusAuction, takeSurplus } from "../utils/pool/surplus-auction"

// Pool, Bucket, Lend and Loan are set from contract reads rather than from event amounts. A read
// made while handling an event returns state as of the end of that event's block, so these
// entities always hold end-of-block state, and events that share a block all write the same
// values. The entity that records each event keeps that event's own amounts.
//
// The exceptions are values the contract changes by exactly an event's amount, which are added
// up from the events: the pool's counters and collateral totals, and the exit queue.
//
// A bucket index in an event is converted to an Int, which aborts the handler, halting the
// subgraph, if the value does not fit. That is safe only because the pool rejects an index
// that is not a bucket in every call handled here except the LP allowance calls, which take
// any uint256: lp-allowances.ts skips those. Check the contract before converting a new field.

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
  pool.lenderCollateral = pool.lenderCollateral.plus(wadToDecimal(event.params.amount))
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

// For a marked lender this is a claim of collateral from the bucket's exit escrow. The LP it
// redeems left the bucket when the queue funded it, and the amount is zero when the claim only
// clears funded LP too small to pay out.
export function handleRemoveCollateral(event: RemoveCollateralEvent): void {
  const pool = loadPool(event.address)
  const index = event.params.index.toI32()
  pool.lenderCollateral = pool.lenderCollateral.minus(wadToDecimal(event.params.amount))
  recordLenderAction(event, pool, event.params.claimer)
  const bucket = refreshLend(event, pool, index, event.params.claimer)
  const isExitClaim = claimCollateralFromExitQueue(
    bucket,
    event.params.claimer,
    event.params.amount,
    event.params.lpRedeemed
  )
  if (isExitClaim) bucket.save()

  const removeCollateral = new RemoveCollateral(eventId(event))
  removeCollateral.pool = pool.id
  removeCollateral.bucket = bucket.id
  removeCollateral.claimer = event.params.claimer
  removeCollateral.index = index
  removeCollateral.amount = wadToDecimal(event.params.amount)
  removeCollateral.lpRedeemed = wadToDecimal(event.params.lpRedeemed)
  removeCollateral.isExitClaim = isExitClaim

  removeCollateral.blockNumber = event.block.number
  removeCollateral.blockTimestamp = event.block.timestamp
  removeCollateral.transactionHash = event.transaction.hash
  removeCollateral.save()
}

// For a marked lender this is a claim of quote from the bucket's exit escrow. The LP it redeems
// left the bucket when the queue funded it, and the amount is zero when the claim only clears
// funded LP too small to pay out.
export function handleRemoveQuoteToken(event: RemoveQuoteTokenEvent): void {
  const pool = loadPool(event.address)
  const index = event.params.index.toI32()
  recordLenderAction(event, pool, event.params.lender)
  const bucket = refreshLend(event, pool, index, event.params.lender)
  const isExitClaim = claimQuoteFromExitQueue(bucket, event.params.lender, event.params.amount, event.params.lpRedeemed)
  if (isExitClaim) bucket.save()

  const removeQuoteToken = new RemoveQuoteToken(eventId(event))
  removeQuoteToken.pool = pool.id
  removeQuoteToken.bucket = bucket.id
  removeQuoteToken.lender = event.params.lender
  removeQuoteToken.index = index
  removeQuoteToken.amount = wadToDecimal(event.params.amount)
  removeQuoteToken.lpRedeemed = wadToDecimal(event.params.lpRedeemed)
  removeQuoteToken.isExitClaim = isExitClaim

  removeQuoteToken.blockNumber = event.block.number
  removeQuoteToken.blockTimestamp = event.block.timestamp
  removeQuoteToken.transactionHash = event.transaction.hash
  removeQuoteToken.save()
}

// The lender's whole LP in the bucket joins the back of its exit queue. Until their claims have
// redeemed all of it they cannot add, move or transfer LP in this bucket, and their removals
// are claims from escrow.
export function handleMarkQuoteForWithdrawal(event: MarkQuoteForWithdrawalEvent): void {
  const pool = loadPool(event.address)
  const index = event.params.index.toI32()
  recordLenderAction(event, pool, event.params.lender)
  const bucket = refreshLend(event, pool, index, event.params.lender)
  openExitQueuePlace(pool, bucket, event.params.lender, event.params.lp, event.params.queueStart, event.block)
  bucket.save()

  const mark = new MarkQuoteForWithdrawal(eventId(event))
  mark.pool = pool.id
  mark.bucket = bucket.id
  mark.lender = event.params.lender
  mark.index = index
  mark.lp = wadToDecimal(event.params.lp)
  mark.queueStart = wadToDecimal(event.params.queueStart)

  mark.blockNumber = event.block.number
  mark.blockTimestamp = event.block.timestamp
  mark.transactionHash = event.transaction.hash
  mark.save()
}

// The front of a bucket's queue was funded, or given up. Emitted inside the call that brought
// quote or collateral to the bucket and before that call's own event, including the mark that
// created the place being funded, so it is not counted as an action of its own. It names no
// lender: a lender's funded LP is found from their ExitQueuePlace and the bucket's queueHead.
export function handleExitQueueFunded(event: ExitQueueFundedEvent): void {
  const pool = loadPool(event.address)
  updatePool(pool, event.block)
  pool.save()

  const index = event.params.index.toI32()
  const bucket = updateBucket(pool, index, event.block)
  fundExitQueue(bucket, event.params.quote, event.params.collateral, event.params.queueHead)
  bucket.save()

  const funded = new ExitQueueFunded(eventId(event))
  funded.pool = pool.id
  funded.bucket = bucket.id
  funded.index = index
  funded.lp = wadToDecimal(event.params.lp)
  funded.quote = wadToDecimal(event.params.quote)
  funded.collateral = wadToDecimal(event.params.collateral)
  funded.queueHead = wadToDecimal(event.params.queueHead)
  funded.isGiveUp = event.params.quote.isZero() && event.params.collateral.isZero()

  funded.blockNumber = event.block.number
  funded.blockTimestamp = event.block.timestamp
  funded.transactionHash = event.transaction.hash
  funded.save()
}

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

// A loan event names its loan by the pool's loan id. A borrower can hold several loans, each in
// one bucket, and one call can touch two of them and emit several events:
//
//   repayDebt    ExitQueueFunded*, LoanClosed*, RepayDebt
//   drawDebt     LoanClosed (when it replaces a debt-free loan), DrawDebt
//   moveLoan     ExitQueueFunded*, MoveLoan, LoanClosed*
//   improveLoan  ExitQueueFunded*, MoveLoan, LoanClosed, ImproveLoan
//   callLoan     LoanClosed, ExitQueueFunded*, LoanCalled
//
// (* when it applies.) Each handler refreshes what its own event names, so no handler depends
// on another having run first, except that a loan must have been introduced by an earlier
// DrawDebt or MoveLoan.

// Counts an action on a borrower's loans and refreshes the pool. The caller saves the pool once
// it has refreshed the loans, because that can change the pool's count of loans with debt.
function beginLoanAction(event: ethereum.Event, pool: Pool, borrower: Address): void {
  countPoolAction(pool)
  updatePool(pool, event.block)
  incrementAccountTxCount(borrower)
}

// Opens a loan (amountBorrowed is not zero), or pledges collateral to an existing one.
export function handleDrawDebt(event: DrawDebtEvent): void {
  const pool = loadPool(event.address)
  beginLoanAction(event, pool, event.params.borrower)
  pool.pledgedCollateral = pool.pledgedCollateral.plus(wadToDecimal(event.params.collateralPledged))

  const bucket = updateBucket(pool, event.params.bucketIndex.toI32(), event.block)
  let loan = Loan.load(getLoanEntityId(pool.id, event.params.loanId))
  if (loan == null) {
    loan = createLoan(pool, event.params.loanId, bucket, event.block)
  }
  refreshLoan(pool, loan, event.block)
  loan.save()
  pool.save()

  const drawDebt = new DrawDebt(eventId(event))
  drawDebt.pool = pool.id
  drawDebt.loan = loan.id
  drawDebt.bucket = bucket.id
  drawDebt.borrower = event.params.borrower
  drawDebt.amountBorrowed = wadToDecimal(event.params.amountBorrowed)
  drawDebt.collateralPledged = wadToDecimal(event.params.collateralPledged)

  drawDebt.blockNumber = event.block.number
  drawDebt.blockTimestamp = event.block.timestamp
  drawDebt.transactionHash = event.transaction.hash
  drawDebt.save()
}

export function handleRepayDebt(event: RepayDebtEvent): void {
  const pool = loadPool(event.address)
  beginLoanAction(event, pool, event.params.borrower)
  pool.pledgedCollateral = pool.pledgedCollateral.minus(wadToDecimal(event.params.collateralPulled))

  const bucket = updateBucket(pool, event.params.bucketIndex.toI32(), event.block)
  const loan = loadLoan(pool, event.params.loanId)
  refreshLoan(pool, loan, event.block)
  loan.save()
  pool.save()

  const repayDebt = new RepayDebt(eventId(event))
  repayDebt.pool = pool.id
  repayDebt.loan = loan.id
  repayDebt.bucket = bucket.id
  repayDebt.borrower = event.params.borrower
  repayDebt.quoteRepaid = wadToDecimal(event.params.quoteRepaid)
  repayDebt.collateralPulled = wadToDecimal(event.params.collateralPulled)

  repayDebt.blockNumber = event.block.number
  repayDebt.blockTimestamp = event.block.timestamp
  repayDebt.transactionHash = event.transaction.hash
  repayDebt.save()
}

// Debt only ever moves into a loan opened by the move, in another bucket; collateral alone can
// move into a loan the borrower already has. The pool's debt and pledged collateral do not change.
export function handleMoveLoan(event: MoveLoanEvent): void {
  const pool = loadPool(event.address)
  beginLoanAction(event, pool, event.params.borrower)

  const fromBucket = updateBucket(pool, event.params.fromBucketIndex.toI32(), event.block)
  const toBucket = updateBucket(pool, event.params.toBucketIndex.toI32(), event.block)

  const fromLoan = loadLoan(pool, event.params.fromLoanId)
  let toLoan = Loan.load(getLoanEntityId(pool.id, event.params.toLoanId))
  if (toLoan == null) {
    toLoan = createLoan(pool, event.params.toLoanId, toBucket, event.block)
    toLoan.movedFrom = fromLoan.id
  }
  refreshLoan(pool, fromLoan, event.block)
  fromLoan.save()
  refreshLoan(pool, toLoan, event.block)
  toLoan.save()
  pool.save()

  const moveLoan = new MoveLoan(eventId(event))
  moveLoan.pool = pool.id
  moveLoan.borrower = event.params.borrower
  moveLoan.fromLoan = fromLoan.id
  moveLoan.toLoan = toLoan.id
  moveLoan.fromBucket = fromBucket.id
  moveLoan.toBucket = toBucket.id
  moveLoan.debtMoved = wadToDecimal(event.params.debtMoved)
  moveLoan.collateralMoved = wadToDecimal(event.params.collateralMoved)

  moveLoan.blockNumber = event.block.number
  moveLoan.blockTimestamp = event.block.timestamp
  moveLoan.transactionHash = event.transaction.hash
  moveLoan.save()
}

// Follows the MoveLoan and LoanClosed of the same call, which have already updated both loans,
// so this only records who made the move. It is not counted as an action of its own.
export function handleImproveLoan(event: ImproveLoanEvent): void {
  const pool = loadPool(event.address)
  const fromLoan = loadLoan(pool, event.params.fromLoanId)
  const toLoan = loadLoan(pool, event.params.toLoanId)

  const improveLoan = new ImproveLoan(eventId(event))
  improveLoan.pool = pool.id
  improveLoan.caller = event.params.caller
  improveLoan.fromLoan = fromLoan.id
  improveLoan.toLoan = toLoan.id

  improveLoan.blockNumber = event.block.number
  improveLoan.blockTimestamp = event.block.timestamp
  improveLoan.transactionHash = event.transaction.hash
  improveLoan.save()
}

// Emitted within the action that cleared the loan's debt or deleted it, so it is not counted as
// an action of its own. It can come before that action's own event.
export function handleLoanClosed(event: LoanClosedEvent): void {
  const pool = loadPool(event.address)
  updatePool(pool, event.block)
  const loan = loadLoan(pool, event.params.loanId)
  refreshLoan(pool, loan, event.block)
  loan.save()
  pool.save()

  const loanClosed = new LoanClosed(eventId(event))
  loanClosed.pool = pool.id
  loanClosed.loan = loan.id
  loanClosed.borrower = event.params.borrower
  loanClosed.deleted = event.params.deleted

  loanClosed.blockNumber = event.block.number
  loanClosed.blockTimestamp = event.block.timestamp
  loanClosed.transactionHash = event.transaction.hash
  loanClosed.save()
}

// The event names neither the borrower nor the bucket; both come from the Loan.
export function handleLoanCalled(event: LoanCalledEvent): void {
  const pool = loadPool(event.address)
  const loan = loadLoan(pool, event.params.loanId)
  beginLoanAction(event, pool, Address.fromBytes(loan.borrower))

  // The lenders', caller's and surplus shares all leave the loan. The lenders' share goes to
  // the loan's bucket; the borrower's remainder, if any, stays on the loan.
  const lenderCollateral = wadToDecimal(event.params.lenderCollateral)
  const callerCollateral = wadToDecimal(event.params.callerCollateral)
  const surplusCollateral = wadToDecimal(event.params.surplusCollateral)
  pool.pledgedCollateral = pool.pledgedCollateral
    .minus(lenderCollateral)
    .minus(callerCollateral)
    .minus(surplusCollateral)
  pool.lenderCollateral = pool.lenderCollateral.plus(lenderCollateral)

  const bucket = updateBucket(pool, loan.bucketIndex, event.block)
  refreshLoan(pool, loan, event.block)
  loan.call = eventId(event)
  loan.save()
  pool.save()

  const loanCalled = new LoanCalled(eventId(event))
  loanCalled.pool = pool.id
  loanCalled.loan = loan.id
  loanCalled.bucket = bucket.id
  loanCalled.borrower = loan.borrower
  loanCalled.caller = event.params.caller
  loanCalled.debt = wadToDecimal(event.params.debt)
  loanCalled.lenderCollateral = lenderCollateral
  loanCalled.callerCollateral = callerCollateral
  loanCalled.surplusCollateral = surplusCollateral

  loanCalled.blockNumber = event.block.number
  loanCalled.blockTimestamp = event.block.timestamp
  loanCalled.transactionHash = event.transaction.hash
  loanCalled.save()
}

export function handleSetBorrowerDelegates(event: SetBorrowerDelegatesEvent): void {
  const pool = loadPool(event.address)
  countPoolAction(pool)
  pool.save()
  incrementAccountTxCount(event.params.borrower)

  setBorrowerDelegates(pool.id, event.params.borrower, event.params.delegates, event.params.approved)

  const delegates: Bytes[] = []
  for (let i = 0; i < event.params.delegates.length; i++) {
    delegates.push(event.params.delegates[i])
  }
  const setDelegates = new SetBorrowerDelegates(eventId(event))
  setDelegates.pool = pool.id
  setDelegates.borrower = event.params.borrower
  setDelegates.delegates = delegates
  setDelegates.approved = event.params.approved

  setDelegates.blockNumber = event.block.number
  setDelegates.blockTimestamp = event.block.timestamp
  setDelegates.transactionHash = event.transaction.hash
  setDelegates.save()
}

/**************************************/
/*** Surplus Auction Event Handlers ***/
/**************************************/

// The pool sells its surplus quote and its surplus collateral in two separate auctions, for AJNA
// that is burned. Neither a kick nor a take accrues interest, so the pool's readers project it
// from the last update; the pool is refreshed for its balances and surplus all the same.

// Counts a kick or a take against the pool and whoever performed it, and refreshes the pool.
// The caller saves the pool.
function beginAuctionAction(event: ethereum.Event, pool: Pool, actor: Address): void {
  countPoolAction(pool)
  updatePool(pool, event.block)
  incrementAccountTxCount(actor)
}

export function handleKickQuoteSurplusAuction(event: KickQuoteSurplusAuctionEvent): void {
  const pool = loadPool(event.address)
  beginAuctionAction(event, pool, event.params.kicker)
  kickSurplusAuction(
    event,
    pool,
    SURPLUS_QUOTE,
    event.params.kicker,
    event.params.lot,
    event.params.rolledOver,
    event.params.auctionPrice
  )
  pool.save()
}

export function handleTakeQuoteSurplus(event: TakeQuoteSurplusEvent): void {
  const pool = loadPool(event.address)
  beginAuctionAction(event, pool, event.params.taker)
  takeSurplus(
    event,
    pool,
    SURPLUS_QUOTE,
    event.params.taker,
    event.params.amount,
    event.params.ajnaBurned,
    event.params.lotRemaining,
    event.params.auctionPrice
  )
  pool.save()
}

export function handleKickCollateralSurplusAuction(event: KickCollateralSurplusAuctionEvent): void {
  const pool = loadPool(event.address)
  beginAuctionAction(event, pool, event.params.kicker)
  kickSurplusAuction(
    event,
    pool,
    SURPLUS_COLLATERAL,
    event.params.kicker,
    event.params.lot,
    event.params.rolledOver,
    event.params.auctionPrice
  )
  pool.save()
}

export function handleTakeCollateralSurplus(event: TakeCollateralSurplusEvent): void {
  const pool = loadPool(event.address)
  beginAuctionAction(event, pool, event.params.taker)
  takeSurplus(
    event,
    pool,
    SURPLUS_COLLATERAL,
    event.params.taker,
    event.params.amount,
    event.params.ajnaBurned,
    event.params.lotRemaining,
    event.params.auctionPrice
  )
  pool.save()
}

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
    // The pool could not be read in this block, but the event still gives the rate it stored.
    // The lend rate follows it, at the utilization last read.
    pool.borrowRate = wadToDecimal(event.params.newRate)
    pool.lendRate = lendRate(event.params.newRate, decimalToWad(pool.utilization))
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
