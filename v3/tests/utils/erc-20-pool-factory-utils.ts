import { newMockEvent } from "matchstick-as"
import { Address, ethereum } from "@graphprotocol/graph-ts"

import { PoolCreated } from "../../generated/ERC20PoolFactory/ERC20PoolFactory"
import { handlePoolCreated } from "../../src/mappings/erc-20-pool-factory"
import { Deployment } from "../../src/utils/deployments"
import { THIRTY_DAYS, placeEvent } from "./common"
import { PoolSnapshot, mockLoanTerm, mockPoolSnapshot, mockTokenInfo } from "./mock-contract-calls"

export function createPoolCreatedEvent(
  factory: Address,
  pool: Address,
  collateral: Address,
  quote: Address,
  blockNumber: i32,
  logIndex: i32
): PoolCreated {
  const event = changetype<PoolCreated>(newMockEvent())
  placeEvent(event, factory, blockNumber, logIndex)

  event.parameters = new Array()
  event.parameters.push(new ethereum.EventParam("pool_", ethereum.Value.fromAddress(pool)))
  event.parameters.push(new ethereum.EventParam("collateral_", ethereum.Value.fromAddress(collateral)))
  event.parameters.push(new ethereum.EventParam("quote_", ethereum.Value.fromAddress(quote)))

  return event
}

// Mocks what the factory handler reads and runs it, creating a pool of 18-decimal tokens in the
// given deployment.
export function createPool(
  deployment: Deployment,
  pool: Address,
  collateral: Address,
  quote: Address,
  snapshot: PoolSnapshot,
  blockNumber: i32
): void {
  mockLoanTerm(deployment.factory, THIRTY_DAYS)
  mockTokenInfo(collateral, "Collateral Token", "COLL", 18)
  mockTokenInfo(quote, "Quote Token", "QUOTE", 18)
  mockPoolSnapshot(deployment.poolInfoUtilsMulticall, pool, snapshot)

  handlePoolCreated(createPoolCreatedEvent(deployment.factory, pool, collateral, quote, blockNumber, 0))
}
