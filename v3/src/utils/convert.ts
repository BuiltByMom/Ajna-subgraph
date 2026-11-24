import { BigDecimal, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts"

import { EXP_18_BD, TEN_BI } from "./constants"

// convert an 18 decimal int to a decimal
export function wadToDecimal(wad: BigInt): BigDecimal {
  return wad.toBigDecimal().div(EXP_18_BD)
}

// convert an amount in a token's own decimals to a decimal
export function tokenAmountToDecimal(amount: BigInt, decimals: i32): BigDecimal {
  return amount.toBigDecimal().div(TEN_BI.pow(<u8>decimals).toBigDecimal())
}

export function bigIntArrayToIntArray(values: BigInt[]): i32[] {
  const result: i32[] = []
  for (let i = 0; i < values.length; i++) {
    result.push(values[i].toI32())
  }
  return result
}

// Id for an entity that records one event. Unique per log, so several events of one kind in a
// single transaction, as in a multicall, never collide.
export function eventId(event: ethereum.Event): Bytes {
  return event.transaction.hash.concatI32(event.logIndex.toI32())
}
