import { log } from "@graphprotocol/graph-ts"

import { PoolCreated as PoolCreatedEvent } from "../../generated/ERC20PoolFactory/ERC20PoolFactory"
import { PoolCreated } from "../../generated/schema"
import { ERC20Pool } from "../../generated/templates"

import { ONE_BI } from "../utils/constants"
import { eventId } from "../utils/convert"
import { deploymentForFactory } from "../utils/deployments"
import { createPool, updatePool } from "../utils/pool/pool"
import { loadOrCreateFactory } from "../utils/pool/pool-factory"
import { loadOrCreateToken } from "../utils/token-erc20"

export function handlePoolCreated(event: PoolCreatedEvent): void {
  if (deploymentForFactory(event.address) == null) {
    // subgraph.yaml and the deployment list are generated from the same config, so this means they
    // are out of sync. Stop rather than index pools without their reader contracts.
    log.critical("handlePoolCreated: factory {} is not a configured deployment", [event.address.toHexString()])
    return
  }

  const factory = loadOrCreateFactory(event.address)
  factory.poolCount = factory.poolCount.plus(ONE_BI)
  factory.save()

  // the factory does not deploy a pool whose collateral and quote are the same token
  const collateralToken = loadOrCreateToken(event.params.collateral_, event.params.pool_, false)
  collateralToken.poolCount = collateralToken.poolCount.plus(ONE_BI)
  collateralToken.save()
  const quoteToken = loadOrCreateToken(event.params.quote_, event.params.pool_, true)
  quoteToken.poolCount = quoteToken.poolCount.plus(ONE_BI)
  quoteToken.save()

  const pool = createPool(event.params.pool_)
  pool.factory = factory.id
  pool.loanTerm = factory.loanTerm
  pool.createdAtBlockNumber = event.block.number
  pool.createdAtTimestamp = event.block.timestamp
  pool.collateralToken = collateralToken.id
  pool.quoteToken = quoteToken.id
  updatePool(pool, event.block)
  pool.save()

  const poolCreated = new PoolCreated(eventId(event))
  poolCreated.pool = pool.id
  poolCreated.factory = factory.id
  poolCreated.collateralToken = event.params.collateral_
  poolCreated.quoteToken = event.params.quote_

  poolCreated.blockNumber = event.block.number
  poolCreated.blockTimestamp = event.block.timestamp
  poolCreated.transactionHash = event.transaction.hash
  poolCreated.save()

  // start indexing the pool's own events; its handlers load the Pool saved above
  ERC20Pool.create(event.params.pool_)
}
