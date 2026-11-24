import { Address, DataSourceContext, dataSource } from "@graphprotocol/graph-ts"

import {
  FACTORIES,
  POOL_INFO_UTILS,
  POOL_INFO_UTILS_MULTICALL,
  POSITION_MANAGERS
} from "../config/deployments"

// Ajna v3 has one pool factory per loan term, each with its own PositionManager, so a network can
// hold several deployments. Nothing here may assume there is only one: handlers find theirs by the
// address that emitted the event, and pool handlers read it from their data source context.
export class Deployment {
  constructor(
    public factory: Address,
    public positionManager: Address,
    public poolInfoUtils: Address,
    public poolInfoUtilsMulticall: Address
  ) {}
}

function deploymentAt(i: i32): Deployment {
  return new Deployment(
    Address.fromString(FACTORIES[i]),
    Address.fromString(POSITION_MANAGERS[i]),
    Address.fromString(POOL_INFO_UTILS[i]),
    Address.fromString(POOL_INFO_UTILS_MULTICALL[i])
  )
}

export function allDeployments(): Deployment[] {
  const deployments: Deployment[] = []
  for (let i = 0; i < FACTORIES.length; i++) {
    deployments.push(deploymentAt(i))
  }
  return deployments
}

// The generated address lists are lowercase, as is toHexString().
function indexOfAddress(addresses: string[], address: Address): i32 {
  return addresses.indexOf(address.toHexString())
}

export function deploymentForFactory(factory: Address): Deployment | null {
  const i = indexOfAddress(FACTORIES, factory)
  return i == -1 ? null : deploymentAt(i)
}

export function deploymentForPositionManager(positionManager: Address): Deployment | null {
  const i = indexOfAddress(POSITION_MANAGERS, positionManager)
  return i == -1 ? null : deploymentAt(i)
}

const FACTORY_KEY = "factory"
const POOL_INFO_UTILS_KEY = "poolInfoUtils"
const POOL_INFO_UTILS_MULTICALL_KEY = "poolInfoUtilsMulticall"

// Context handed to each ERC20Pool data source when its factory creates the pool.
export function poolContext(deployment: Deployment): DataSourceContext {
  const context = new DataSourceContext()
  context.setBytes(FACTORY_KEY, deployment.factory)
  context.setBytes(POOL_INFO_UTILS_KEY, deployment.poolInfoUtils)
  context.setBytes(POOL_INFO_UTILS_MULTICALL_KEY, deployment.poolInfoUtilsMulticall)
  return context
}

// The three readers below are for ERC20Pool handlers only: they read the context set by poolContext.

export function poolFactory(): Address {
  return Address.fromBytes(dataSource.context().getBytes(FACTORY_KEY))
}

export function poolInfoUtils(): Address {
  return Address.fromBytes(dataSource.context().getBytes(POOL_INFO_UTILS_KEY))
}

export function poolInfoUtilsMulticall(): Address {
  return Address.fromBytes(dataSource.context().getBytes(POOL_INFO_UTILS_MULTICALL_KEY))
}
