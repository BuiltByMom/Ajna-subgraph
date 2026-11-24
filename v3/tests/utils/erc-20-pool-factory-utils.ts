import { newMockEvent } from "matchstick-as"
import { Address, BigInt, ethereum } from "@graphprotocol/graph-ts"

import { PoolCreated } from "../../generated/ERC20PoolFactory/ERC20PoolFactory"

export function createPoolCreatedEvent(
  factory: Address,
  pool: Address,
  collateral: Address,
  quote: Address,
  logIndex: i32
): PoolCreated {
  const event = changetype<PoolCreated>(newMockEvent())
  event.address = factory
  event.logIndex = BigInt.fromI32(logIndex)

  event.parameters = new Array()
  event.parameters.push(new ethereum.EventParam("pool_", ethereum.Value.fromAddress(pool)))
  event.parameters.push(new ethereum.EventParam("collateral_", ethereum.Value.fromAddress(collateral)))
  event.parameters.push(new ethereum.EventParam("quote_", ethereum.Value.fromAddress(quote)))

  return event
}
