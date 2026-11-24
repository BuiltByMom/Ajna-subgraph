import { Address, BigInt, ethereum, store } from "@graphprotocol/graph-ts"

import { Bucket, ExitQueuePlace, Pool } from "../../../generated/schema"

import { ensureAccount } from "../account"
import { ZERO_BI } from "../constants"
import { wadToDecimal } from "../convert"
import { getLendId } from "./lend"

// The exit queue is followed from the pool's events instead of being read from chain, for two
// reasons. The events give the queue exactly: the pool changes a bucket's queue and escrow, and
// a lender's place, by the amounts its events carry and nowhere else. And whether a removal is a
// claim from escrow depends on whether the lender was marked when it happened, which a read of
// end-of-block state cannot tell: a lender can mark and claim everything within one block.
//
// A place is tracked in the pool's exact integer amounts (queueStartWad, lpbWad). Whether it has
// ended decides how the lender's later removals are treated, and BigDecimal keeps 34 significant
// digits, so a very large place would not subtract back to exactly zero.
//
// Callers save the bucket.

// A marked lender's place has the id of their Lend in the bucket.
function loadPlace(bucket: Bucket, lender: Address): ExitQueuePlace | null {
  return ExitQueuePlace.load(getLendId(bucket.id, lender))
}

// MarkQuoteForWithdrawal: the lender's whole LP joins the back of the bucket's queue.
export function openExitQueuePlace(
  pool: Pool,
  bucket: Bucket,
  lender: Address,
  lp: BigInt,
  queueStart: BigInt,
  block: ethereum.Block
): void {
  const place = new ExitQueuePlace(getLendId(bucket.id, lender))
  place.pool = pool.id
  place.bucket = bucket.id
  place.bucketIndex = bucket.bucketIndex
  place.lender = lender
  place.account = lender
  ensureAccount(lender)
  place.queueStartWad = queueStart
  place.queueStart = wadToDecimal(queueStart)
  place.lpbWad = lp
  place.lpb = wadToDecimal(lp)
  place.markedAtBlockNumber = block.number
  place.markedAtTimestamp = block.timestamp
  place.save()

  bucket.queueTail = wadToDecimal(queueStart.plus(lp))
}

// ExitQueueFunded: the queue's head moved, and what paid for the LP it passed joined the escrow.
export function fundExitQueue(bucket: Bucket, quote: BigInt, collateral: BigInt, queueHead: BigInt): void {
  bucket.queueHead = wadToDecimal(queueHead)
  bucket.escrowQuote = bucket.escrowQuote.plus(wadToDecimal(quote))
  bucket.escrowCollateral = bucket.escrowCollateral.plus(wadToDecimal(collateral))
}

// A removal by a lender with a place is a claim: the LP redeemed comes off the front of the
// place, which ends when none is left. Returns false, changing nothing, if the lender has no place.
function claimFromPlace(bucket: Bucket, lender: Address, lpRedeemed: BigInt): boolean {
  const place = loadPlace(bucket, lender)
  if (place == null) return false

  place.queueStartWad = place.queueStartWad.plus(lpRedeemed)
  place.lpbWad = place.lpbWad.minus(lpRedeemed)
  if (place.lpbWad.gt(ZERO_BI)) {
    place.queueStart = wadToDecimal(place.queueStartWad)
    place.lpb = wadToDecimal(place.lpbWad)
    place.save()
  } else {
    store.remove("ExitQueuePlace", place.id.toHexString())
  }
  return true
}

// RemoveQuoteToken. Returns whether it was a claim of quote from the bucket's escrow.
export function claimQuoteFromExitQueue(bucket: Bucket, lender: Address, amount: BigInt, lpRedeemed: BigInt): boolean {
  if (!claimFromPlace(bucket, lender, lpRedeemed)) return false
  bucket.escrowQuote = bucket.escrowQuote.minus(wadToDecimal(amount))
  return true
}

// RemoveCollateral. Returns whether it was a claim of collateral from the bucket's escrow.
export function claimCollateralFromExitQueue(
  bucket: Bucket,
  lender: Address,
  amount: BigInt,
  lpRedeemed: BigInt
): boolean {
  if (!claimFromPlace(bucket, lender, lpRedeemed)) return false
  bucket.escrowCollateral = bucket.escrowCollateral.minus(wadToDecimal(amount))
  return true
}
