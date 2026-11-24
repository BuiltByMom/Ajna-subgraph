import { Address, log } from "@graphprotocol/graph-ts"

import { Pool } from "../../generated/schema"
import {
  FACTORIES,
  POOL_INFO_UTILS,
  POOL_INFO_UTILS_MULTICALL,
  POSITION_MANAGERS
} from "../config/deployments"

// Ajna v3 has one pool factory per loan term, each with its own PositionManager, so a network can
// hold several deployments. Nothing here may assume there is only one: a handler finds its
// deployment from the address that emitted the event, or from the pool's factory.
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

// The deployment a pool belongs to, which holds the reader contracts to use for it. It is found
// through the pool's factory, so it works in every data source.
export function poolDeployment(pool: Pool): Deployment {
  const deployment = deploymentForFactory(Address.fromBytes(pool.factory))
  if (deployment == null) {
    // pools are only created by configured factories, so the generated address lists are out of
    // sync with the manifest
    log.critical("poolDeployment: factory {} of pool {} is not a configured deployment", [
      pool.factory.toHexString(),
      pool.id.toHexString()
    ])
  }
  return deployment!
}
