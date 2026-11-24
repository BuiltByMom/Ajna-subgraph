import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts"

import { ONE_WAD_BI } from "../../src/utils/constants"

// A distinct address for each n, e.g. testAddress(26) is 0x000000000000000000000000000000000000001a.
// Use n of 0x1000 or more: the placeholder deployment addresses in tests/fixtures are below 0x100.
export function testAddress(n: i32): Address {
  return Address.fromString("0x" + n.toString(16).padStart(40, "0"))
}

// n whole units as a WAD
export function wad(n: i32): BigInt {
  return BigInt.fromI32(n).times(ONE_WAD_BI)
}

// a decimal number of whole units as a WAD, e.g. wadOf("10.25")
export function wadOf(decimal: string): BigInt {
  const parts = decimal.split(".")
  const fraction = parts.length > 1 ? parts[1] : ""
  return BigInt.fromString(parts[0] + fraction.padEnd(18, "0"))
}

export const THIRTY_DAYS = BigInt.fromI32(2592000)

// The pool's id for a borrower's loan: the borrower's address followed by a 12-byte counter.
export function loanId(borrower: Address, counter: i32): Bytes {
  return Bytes.fromHexString(borrower.toHexString() + counter.toString(16).padStart(24, "0"))
}

export function blockTimestamp(blockNumber: i32): BigInt {
  return BigInt.fromI32(1700000000 + blockNumber * 12)
}

// Places a mock event: who emitted it, in which block, and where in that block's logs. Handlers
// read contract state once per block, so tests that change mocked state must move to a new block.
//
// Every event placed in one block belongs to the same transaction, like the calls of a
// multicall, so give each its own log index.
export function placeEvent(event: ethereum.Event, emitter: Address, blockNumber: i32, logIndex: i32): void {
  event.address = emitter
  event.block.number = BigInt.fromI32(blockNumber)
  event.block.timestamp = blockTimestamp(blockNumber)
  event.transaction.hash = Bytes.fromHexString("0x" + blockNumber.toString(16).padStart(64, "0"))
  event.logIndex = BigInt.fromI32(logIndex)
}

// the id handlers give the entity that records an event
export function eventEntityId(event: ethereum.Event): string {
  return event.transaction.hash.concatI32(event.logIndex.toI32()).toHexString()
}
