import { createMockedFunction, newMockEvent } from "matchstick-as"
import { Address, BigInt, ethereum } from "@graphprotocol/graph-ts"

import {
  Approval,
  ApprovalForAll,
  Burn,
  MemorializePosition,
  Mint,
  MoveLiquidity,
  RedeemPosition,
  Transfer
} from "../../generated/PositionManager/PositionManager"
import { ZERO_BI } from "../../src/utils/constants"
import { placeEvent } from "./common"

// Each creator places its event (manager, block, log index) and then lists the event's parameters
// in the order the ABI declares them.

function addressParam(name: string, value: Address): ethereum.EventParam {
  return new ethereum.EventParam(name, ethereum.Value.fromAddress(value))
}

function uintParam(name: string, value: BigInt): ethereum.EventParam {
  return new ethereum.EventParam(name, ethereum.Value.fromUnsignedBigInt(value))
}

function tokenIdParam(tokenId: i32): ethereum.EventParam {
  return uintParam("tokenId", BigInt.fromI32(tokenId))
}

function indexesParam(indexes: i32[]): ethereum.EventParam {
  const values: BigInt[] = []
  for (let i = 0; i < indexes.length; i++) {
    values.push(BigInt.fromI32(indexes[i]))
  }
  return new ethereum.EventParam("indexes", ethereum.Value.fromUnsignedBigIntArray(values))
}

export function createMintEvent(
  manager: Address,
  blockNumber: i32,
  logIndex: i32,
  lender: Address,
  pool: Address,
  tokenId: i32
): Mint {
  const event = changetype<Mint>(newMockEvent())
  placeEvent(event, manager, blockNumber, logIndex)
  event.parameters = [addressParam("lender", lender), addressParam("pool", pool), tokenIdParam(tokenId)]
  return event
}

export function createBurnEvent(
  manager: Address,
  blockNumber: i32,
  logIndex: i32,
  lender: Address,
  tokenId: i32
): Burn {
  const event = changetype<Burn>(newMockEvent())
  placeEvent(event, manager, blockNumber, logIndex)
  event.parameters = [addressParam("lender", lender), tokenIdParam(tokenId)]
  return event
}

export function createMemorializePositionEvent(
  manager: Address,
  blockNumber: i32,
  logIndex: i32,
  lender: Address,
  tokenId: i32,
  indexes: i32[]
): MemorializePosition {
  const event = changetype<MemorializePosition>(newMockEvent())
  placeEvent(event, manager, blockNumber, logIndex)
  event.parameters = [addressParam("lender", lender), tokenIdParam(tokenId), indexesParam(indexes)]
  return event
}

export function createRedeemPositionEvent(
  manager: Address,
  blockNumber: i32,
  logIndex: i32,
  lender: Address,
  tokenId: i32,
  indexes: i32[]
): RedeemPosition {
  const event = changetype<RedeemPosition>(newMockEvent())
  placeEvent(event, manager, blockNumber, logIndex)
  event.parameters = [addressParam("lender", lender), tokenIdParam(tokenId), indexesParam(indexes)]
  return event
}

export function createMoveLiquidityEvent(
  manager: Address,
  blockNumber: i32,
  logIndex: i32,
  lender: Address,
  tokenId: i32,
  fromIndex: i32,
  toIndex: i32,
  lpRedeemedFrom: BigInt,
  lpAwardedTo: BigInt
): MoveLiquidity {
  const event = changetype<MoveLiquidity>(newMockEvent())
  placeEvent(event, manager, blockNumber, logIndex)
  event.parameters = [
    addressParam("lender", lender),
    tokenIdParam(tokenId),
    uintParam("fromIndex", BigInt.fromI32(fromIndex)),
    uintParam("toIndex", BigInt.fromI32(toIndex)),
    uintParam("lpRedeemedFrom", lpRedeemedFrom),
    uintParam("lpAwardedTo", lpAwardedTo)
  ]
  return event
}

// the manager's ERC721 Transfer: from the zero address for a mint, to it for a burn
export function createTransferEvent(
  manager: Address,
  blockNumber: i32,
  logIndex: i32,
  from: Address,
  to: Address,
  tokenId: i32
): Transfer {
  const event = changetype<Transfer>(newMockEvent())
  placeEvent(event, manager, blockNumber, logIndex)
  event.parameters = [addressParam("from", from), addressParam("to", to), tokenIdParam(tokenId)]
  return event
}

export function createApprovalEvent(
  manager: Address,
  blockNumber: i32,
  logIndex: i32,
  owner: Address,
  approved: Address,
  tokenId: i32
): Approval {
  const event = changetype<Approval>(newMockEvent())
  placeEvent(event, manager, blockNumber, logIndex)
  event.parameters = [addressParam("owner", owner), addressParam("approved", approved), tokenIdParam(tokenId)]
  return event
}

export function createApprovalForAllEvent(
  manager: Address,
  blockNumber: i32,
  logIndex: i32,
  owner: Address,
  operator: Address,
  approved: boolean
): ApprovalForAll {
  const event = changetype<ApprovalForAll>(newMockEvent())
  placeEvent(event, manager, blockNumber, logIndex)
  event.parameters = [
    addressParam("owner", owner),
    addressParam("operator", operator),
    new ethereum.EventParam("approved", ethereum.Value.fromBoolean(approved))
  ]
  return event
}

// What the manager's getPositionInfo returns for a position in one bucket: its LP there, a WAD,
// and the deposit time recorded for it.
export function mockPositionInfo(manager: Address, tokenId: i32, index: i32, lp: BigInt, depositTime: BigInt): void {
  createMockedFunction(manager, "getPositionInfo", "getPositionInfo(uint256,uint256):(uint256,uint256)")
    .withArgs([
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(tokenId)),
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(index))
    ])
    .returns([ethereum.Value.fromUnsignedBigInt(lp), ethereum.Value.fromUnsignedBigInt(depositTime)])
}

// a bucket the position holds nothing in, or any bucket of a token that has been burned
export function mockNoPositionInfo(manager: Address, tokenId: i32, index: i32): void {
  mockPositionInfo(manager, tokenId, index, ZERO_BI, ZERO_BI)
}
