import { createMockedFunction } from "matchstick-as"
import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts"

// Building blocks for tests generated from a recorded chain (integration/record.js): contract
// reads mocked with what the chain returned, and events placed where the chain emitted them.
// The names are short because generated tests use them thousands of times.

export function A(hex: string): ethereum.Value {
  return ethereum.Value.fromAddress(Address.fromString(hex))
}

export function U(decimal: string): ethereum.Value {
  return ethereum.Value.fromUnsignedBigInt(BigInt.fromString(decimal))
}

// a fixed-size bytes value, such as a bytes32 loan id
export function F(hex: string): ethereum.Value {
  return ethereum.Value.fromFixedBytes(Bytes.fromHexString(hex))
}

export function L(value: boolean): ethereum.Value {
  return ethereum.Value.fromBoolean(value)
}

export function S(text: string): ethereum.Value {
  return ethereum.Value.fromString(text)
}

export function UA(decimals: string[]): ethereum.Value {
  const values: BigInt[] = []
  for (let i = 0; i < decimals.length; i++) {
    values.push(BigInt.fromString(decimals[i]))
  }
  return ethereum.Value.fromUnsignedBigIntArray(values)
}

export function AA(hexes: string[]): ethereum.Value {
  const values: Address[] = []
  for (let i = 0; i < hexes.length; i++) {
    values.push(Address.fromString(hexes[i]))
  }
  return ethereum.Value.fromAddressArray(values)
}

export function T(values: ethereum.Value[]): ethereum.Value {
  const tuple = new ethereum.Tuple()
  for (let i = 0; i < values.length; i++) {
    tuple.push(values[i])
  }
  return ethereum.Value.fromTuple(tuple)
}

export function P(name: string, value: ethereum.Value): ethereum.EventParam {
  return new ethereum.EventParam(name, value)
}

// what a contract read returns from now on
export function returns(
  contract: string,
  name: string,
  signature: string,
  args: ethereum.Value[],
  values: ethereum.Value[]
): void {
  const mocked = createMockedFunction(Address.fromString(contract), name, signature)
  if (args.length == 0) {
    mocked.returns(values)
  } else {
    mocked.withArgs(args).returns(values)
  }
}

// a contract read that reverts from now on, or whose contract has no code yet
export function reverts(contract: string, name: string, signature: string, args: ethereum.Value[]): void {
  const mocked = createMockedFunction(Address.fromString(contract), name, signature)
  if (args.length == 0) {
    mocked.reverts()
  } else {
    mocked.withArgs(args).reverts()
  }
}

// gives a mock event its emitter, block, transaction, log index and parameters
export function place(
  event: ethereum.Event,
  emitter: string,
  blockNumber: i32,
  timestamp: string,
  transactionHash: string,
  logIndex: i32,
  parameters: ethereum.EventParam[]
): void {
  event.address = Address.fromString(emitter)
  event.block.number = BigInt.fromI32(blockNumber)
  event.block.timestamp = BigInt.fromString(timestamp)
  event.transaction.hash = Bytes.fromHexString(transactionHash)
  event.logIndex = BigInt.fromI32(logIndex)
  event.parameters = parameters
}
