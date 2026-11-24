import { newMockEvent } from "matchstick-as"
import { Address, BigInt, ethereum } from "@graphprotocol/graph-ts"

import {
  AddCollateral,
  AddQuoteToken,
  ApproveLPTransferors,
  DecreaseLPAllowance,
  Flashloan,
  IncreaseLPAllowance,
  InterestUpdateFailure,
  MoveQuoteToken,
  RemoveCollateral,
  RemoveQuoteToken,
  RevokeLPAllowance,
  RevokeLPTransferors,
  TransferLP,
  UpdateInterestRate
} from "../../generated/templates/ERC20Pool/ERC20Pool"
import { placeEvent } from "./common"

// Each creator places its event (pool, block, log index) and then lists the event's parameters
// in the order the ABI declares them.

function addressParam(name: string, value: Address): ethereum.EventParam {
  return new ethereum.EventParam(name, ethereum.Value.fromAddress(value))
}

function uintParam(name: string, value: BigInt): ethereum.EventParam {
  return new ethereum.EventParam(name, ethereum.Value.fromUnsignedBigInt(value))
}

function indexParam(name: string, index: i32): ethereum.EventParam {
  return uintParam(name, BigInt.fromI32(index))
}

function indexesParam(name: string, indexes: i32[]): ethereum.EventParam {
  const values: BigInt[] = []
  for (let i = 0; i < indexes.length; i++) {
    values.push(BigInt.fromI32(indexes[i]))
  }
  return new ethereum.EventParam(name, ethereum.Value.fromUnsignedBigIntArray(values))
}

export function createAddCollateralEvent(
  pool: Address,
  blockNumber: i32,
  logIndex: i32,
  actor: Address,
  index: i32,
  amount: BigInt,
  lpAwarded: BigInt
): AddCollateral {
  const event = changetype<AddCollateral>(newMockEvent())
  placeEvent(event, pool, blockNumber, logIndex)
  event.parameters = [
    addressParam("actor", actor),
    indexParam("index", index),
    uintParam("amount", amount),
    uintParam("lpAwarded", lpAwarded)
  ]
  return event
}

export function createAddQuoteTokenEvent(
  pool: Address,
  blockNumber: i32,
  logIndex: i32,
  lender: Address,
  index: i32,
  amount: BigInt,
  lpAwarded: BigInt
): AddQuoteToken {
  const event = changetype<AddQuoteToken>(newMockEvent())
  placeEvent(event, pool, blockNumber, logIndex)
  event.parameters = [
    addressParam("lender", lender),
    indexParam("index", index),
    uintParam("amount", amount),
    uintParam("lpAwarded", lpAwarded)
  ]
  return event
}

export function createMoveQuoteTokenEvent(
  pool: Address,
  blockNumber: i32,
  logIndex: i32,
  lender: Address,
  from: i32,
  to: i32,
  amount: BigInt,
  lpRedeemedFrom: BigInt,
  lpAwardedTo: BigInt
): MoveQuoteToken {
  const event = changetype<MoveQuoteToken>(newMockEvent())
  placeEvent(event, pool, blockNumber, logIndex)
  event.parameters = [
    addressParam("lender", lender),
    indexParam("from", from),
    indexParam("to", to),
    uintParam("amount", amount),
    uintParam("lpRedeemedFrom", lpRedeemedFrom),
    uintParam("lpAwardedTo", lpAwardedTo)
  ]
  return event
}

export function createRemoveCollateralEvent(
  pool: Address,
  blockNumber: i32,
  logIndex: i32,
  claimer: Address,
  index: i32,
  amount: BigInt,
  lpRedeemed: BigInt
): RemoveCollateral {
  const event = changetype<RemoveCollateral>(newMockEvent())
  placeEvent(event, pool, blockNumber, logIndex)
  event.parameters = [
    addressParam("claimer", claimer),
    indexParam("index", index),
    uintParam("amount", amount),
    uintParam("lpRedeemed", lpRedeemed)
  ]
  return event
}

export function createRemoveQuoteTokenEvent(
  pool: Address,
  blockNumber: i32,
  logIndex: i32,
  lender: Address,
  index: i32,
  amount: BigInt,
  lpRedeemed: BigInt
): RemoveQuoteToken {
  const event = changetype<RemoveQuoteToken>(newMockEvent())
  placeEvent(event, pool, blockNumber, logIndex)
  event.parameters = [
    addressParam("lender", lender),
    indexParam("index", index),
    uintParam("amount", amount),
    uintParam("lpRedeemed", lpRedeemed)
  ]
  return event
}

export function createTransferLPEvent(
  pool: Address,
  blockNumber: i32,
  logIndex: i32,
  owner: Address,
  newOwner: Address,
  indexes: i32[],
  lp: BigInt
): TransferLP {
  const event = changetype<TransferLP>(newMockEvent())
  placeEvent(event, pool, blockNumber, logIndex)
  event.parameters = [
    addressParam("owner", owner),
    addressParam("newOwner", newOwner),
    indexesParam("indexes", indexes),
    uintParam("lp", lp)
  ]
  return event
}

export function createApproveLPTransferorsEvent(
  pool: Address,
  blockNumber: i32,
  logIndex: i32,
  lender: Address,
  transferors: Address[]
): ApproveLPTransferors {
  const event = changetype<ApproveLPTransferors>(newMockEvent())
  placeEvent(event, pool, blockNumber, logIndex)
  event.parameters = [
    addressParam("lender", lender),
    new ethereum.EventParam("transferors", ethereum.Value.fromAddressArray(transferors))
  ]
  return event
}

export function createRevokeLPTransferorsEvent(
  pool: Address,
  blockNumber: i32,
  logIndex: i32,
  lender: Address,
  transferors: Address[]
): RevokeLPTransferors {
  const event = changetype<RevokeLPTransferors>(newMockEvent())
  placeEvent(event, pool, blockNumber, logIndex)
  event.parameters = [
    addressParam("lender", lender),
    new ethereum.EventParam("transferors", ethereum.Value.fromAddressArray(transferors))
  ]
  return event
}

export function createIncreaseLPAllowanceEvent(
  pool: Address,
  blockNumber: i32,
  logIndex: i32,
  owner: Address,
  spender: Address,
  indexes: i32[],
  amounts: BigInt[]
): IncreaseLPAllowance {
  const event = changetype<IncreaseLPAllowance>(newMockEvent())
  placeEvent(event, pool, blockNumber, logIndex)
  event.parameters = [
    addressParam("owner", owner),
    addressParam("spender", spender),
    indexesParam("indexes", indexes),
    new ethereum.EventParam("amounts", ethereum.Value.fromUnsignedBigIntArray(amounts))
  ]
  return event
}

export function createDecreaseLPAllowanceEvent(
  pool: Address,
  blockNumber: i32,
  logIndex: i32,
  owner: Address,
  spender: Address,
  indexes: i32[],
  amounts: BigInt[]
): DecreaseLPAllowance {
  const event = changetype<DecreaseLPAllowance>(newMockEvent())
  placeEvent(event, pool, blockNumber, logIndex)
  event.parameters = [
    addressParam("owner", owner),
    addressParam("spender", spender),
    indexesParam("indexes", indexes),
    new ethereum.EventParam("amounts", ethereum.Value.fromUnsignedBigIntArray(amounts))
  ]
  return event
}

export function createRevokeLPAllowanceEvent(
  pool: Address,
  blockNumber: i32,
  logIndex: i32,
  owner: Address,
  spender: Address,
  indexes: i32[]
): RevokeLPAllowance {
  const event = changetype<RevokeLPAllowance>(newMockEvent())
  placeEvent(event, pool, blockNumber, logIndex)
  event.parameters = [addressParam("owner", owner), addressParam("spender", spender), indexesParam("indexes", indexes)]
  return event
}

// amount is in the token's own decimals
export function createFlashloanEvent(
  pool: Address,
  blockNumber: i32,
  logIndex: i32,
  receiver: Address,
  token: Address,
  amount: BigInt
): Flashloan {
  const event = changetype<Flashloan>(newMockEvent())
  placeEvent(event, pool, blockNumber, logIndex)
  event.parameters = [addressParam("receiver", receiver), addressParam("token", token), uintParam("amount", amount)]
  return event
}

export function createUpdateInterestRateEvent(
  pool: Address,
  blockNumber: i32,
  logIndex: i32,
  oldRate: BigInt,
  newRate: BigInt
): UpdateInterestRate {
  const event = changetype<UpdateInterestRate>(newMockEvent())
  placeEvent(event, pool, blockNumber, logIndex)
  event.parameters = [uintParam("oldRate", oldRate), uintParam("newRate", newRate)]
  return event
}

export function createInterestUpdateFailureEvent(pool: Address, blockNumber: i32, logIndex: i32): InterestUpdateFailure {
  const event = changetype<InterestUpdateFailure>(newMockEvent())
  placeEvent(event, pool, blockNumber, logIndex)
  event.parameters = []
  return event
}
