import { log } from "@graphprotocol/graph-ts"

import { PoolCreated as PoolCreatedEvent } from "../../generated/ERC20PoolFactory/ERC20PoolFactory"
import { PoolCreated } from "../../generated/schema"
import { ERC20Pool } from "../../generated/templates"

import { deploymentForFactory, poolContext } from "../utils/deployments"

export function handlePoolCreated(event: PoolCreatedEvent): void {
  const deployment = deploymentForFactory(event.address)
  if (deployment == null) {
    // subgraph.yaml and the deployment list are generated from the same config, so this means they
    // are out of sync. Stop rather than index pools without their reader contracts.
    log.critical("handlePoolCreated: factory {} is not a configured deployment", [event.address.toHexString()])
    return
  }

  const poolCreated = new PoolCreated(event.transaction.hash.concatI32(event.logIndex.toI32()))
  poolCreated.pool = event.params.pool_
  poolCreated.factory = event.address
  poolCreated.collateralToken = event.params.collateral_
  poolCreated.quoteToken = event.params.quote_

  poolCreated.blockNumber = event.block.number
  poolCreated.blockTimestamp = event.block.timestamp
  poolCreated.transactionHash = event.transaction.hash
  poolCreated.save()

  // start indexing the pool, telling its handlers which factory and readers it belongs to
  ERC20Pool.createWithContext(event.params.pool_, poolContext(deployment))
}
