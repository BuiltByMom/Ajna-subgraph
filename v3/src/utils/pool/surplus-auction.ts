import { Address, BigInt, Bytes, ethereum, log } from "@graphprotocol/graph-ts"

import { Pool, SurplusAuction, SurplusAuctionKick, SurplusAuctionTake } from "../../../generated/schema"

import { ZERO_BD } from "../constants"
import { eventId, wadToDecimal } from "../convert"

// values of the SurplusAuctionKind enum
export const SURPLUS_QUOTE = "Quote"
export const SURPLUS_COLLATERAL = "Collateral"

// A pool has two surplus auctions, one selling quote and one selling collateral, with separate
// timers and the same behaviour and event shapes. Each kind can be kicked at most once in five
// days and its takes close 72 hours after the kick, so a take always belongs to the pool's
// latest auction of its kind, and an auction is identified by its kick time.
//
// Callers save the pool.

export function getSurplusAuctionId(poolId: Bytes, kind: string, kickTime: BigInt): Bytes {
  return poolId.concat(Bytes.fromUTF8("|" + kind + "|" + kickTime.toString()))
}

// The pool's latest auction of the kind, or null if none has been kicked.
function latestAuctionId(pool: Pool, kind: string): Bytes | null {
  return kind == SURPLUS_QUOTE ? pool.quoteSurplusAuction : pool.collateralSurplusAuction
}

// KickQuoteSurplusAuction or KickCollateralSurplusAuction.
export function kickSurplusAuction(
  event: ethereum.Event,
  pool: Pool,
  kind: string,
  kicker: Address,
  lot: BigInt,
  rolledOver: BigInt,
  auctionPrice: BigInt
): void {
  const isQuote = kind == SURPLUS_QUOTE
  const auction = new SurplusAuction(getSurplusAuctionId(pool.id, kind, event.block.timestamp))
  auction.pool = pool.id
  auction.kind = kind
  auction.token = isQuote ? pool.quoteToken : pool.collateralToken
  auction.kick = eventId(event)
  auction.kicker = kicker
  auction.kickTime = event.block.timestamp
  auction.lot = wadToDecimal(lot)
  auction.rolledOver = wadToDecimal(rolledOver)
  auction.startingPrice = wadToDecimal(auctionPrice)
  auction.lotRemaining = auction.lot
  auction.ajnaBurned = ZERO_BD
  auction.save()

  if (isQuote) {
    pool.quoteSurplusAuction = auction.id
  } else {
    pool.collateralSurplusAuction = auction.id
  }

  const kick = new SurplusAuctionKick(eventId(event))
  kick.pool = pool.id
  kick.auction = auction.id
  kick.kind = kind
  kick.kicker = kicker
  kick.lot = auction.lot
  kick.rolledOver = auction.rolledOver
  kick.auctionPrice = auction.startingPrice

  kick.blockNumber = event.block.number
  kick.blockTimestamp = event.block.timestamp
  kick.transactionHash = event.transaction.hash
  kick.save()
}

// TakeQuoteSurplus or TakeCollateralSurplus.
export function takeSurplus(
  event: ethereum.Event,
  pool: Pool,
  kind: string,
  taker: Address,
  amount: BigInt,
  ajnaBurned: BigInt,
  lotRemaining: BigInt,
  auctionPrice: BigInt
): void {
  const auctionId = latestAuctionId(pool, kind)
  if (auctionId === null) {
    // the pool only accepts a take within 72 hours of a kick
    log.critical("takeSurplus: pool {} has no {} surplus auction for a take", [pool.id.toHexString(), kind])
    return
  }
  const auction = SurplusAuction.load(auctionId)
  if (auction == null) {
    log.critical("takeSurplus: pool {} points at a missing surplus auction {}", [
      pool.id.toHexString(),
      auctionId.toHexString()
    ])
    return
  }

  const burned = wadToDecimal(ajnaBurned)
  auction.lotRemaining = wadToDecimal(lotRemaining)
  auction.lastTakePrice = wadToDecimal(auctionPrice)
  auction.ajnaBurned = auction.ajnaBurned.plus(burned)
  auction.save()

  pool.totalAjnaBurned = pool.totalAjnaBurned.plus(burned)

  const take = new SurplusAuctionTake(eventId(event))
  take.pool = pool.id
  take.auction = auction.id
  take.kind = kind
  take.taker = taker
  take.amount = wadToDecimal(amount)
  take.ajnaBurned = burned
  take.lotRemaining = auction.lotRemaining
  take.auctionPrice = wadToDecimal(auctionPrice)

  take.blockNumber = event.block.number
  take.blockTimestamp = event.block.timestamp
  take.transactionHash = event.transaction.hash
  take.save()
}
