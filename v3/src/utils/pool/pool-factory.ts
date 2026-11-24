import { Address } from "@graphprotocol/graph-ts"

import { ERC20PoolFactory } from "../../../generated/ERC20PoolFactory/ERC20PoolFactory"
import { PoolFactory } from "../../../generated/schema"

import { ZERO_BI } from "../constants"

export function loadOrCreateFactory(factoryAddress: Address): PoolFactory {
  let factory = PoolFactory.load(factoryAddress)
  if (factory == null) {
    factory = new PoolFactory(factoryAddress)
    // fixed when the factory was deployed
    factory.loanTerm = ERC20PoolFactory.bind(factoryAddress).loanTerm()
    factory.poolCount = ZERO_BI
  }
  return factory
}
