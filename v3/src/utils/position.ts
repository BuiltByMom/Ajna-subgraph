import { Address, BigDecimal, BigInt, Bytes, ethereum, log, store } from "@graphprotocol/graph-ts"

import { PositionManager as PositionManagerContract } from "../../generated/PositionManager/PositionManager"
import { Bucket, Pool, Position, PositionLend, PositionManager } from "../../generated/schema"

import { ZERO_BD, ZERO_BI } from "./constants"
import { decimalToWad, wadToDecimal } from "./convert"
import { deploymentForPositionManager } from "./deployments"
import { updateBucket } from "./pool/bucket"
import { ensureFactory } from "./pool/pool-factory"

// Each PositionManager numbers its tokens from 1, and a network can hold several managers, so a
// token id identifies a position only together with the manager that issued it.
export function getPositionId(positionManager: Bytes, tokenId: BigInt): Bytes {
  return positionManager.concat(Bytes.fromUTF8("|" + tokenId.toString()))
}

export function getPositionLendId(positionId: Bytes, index: i32): Bytes {
  return positionId.concat(Bytes.fromUTF8("|" + index.toString()))
}

// The caller saves the manager.
export function loadOrCreatePositionManager(address: Address): PositionManager {
  let manager = PositionManager.load(address)
  if (manager == null) {
    const deployment = deploymentForPositionManager(address)
    if (deployment == null) {
      // subgraph.yaml and the deployment list are generated from the same config, so this means
      // they are out of sync
      log.critical("loadOrCreatePositionManager: {} is not a configured deployment", [address.toHexString()])
    }
    // the manager can emit an event before its factory has deployed a pool
    ensureFactory(deployment!.factory)

    manager = new PositionManager(address)
    manager.factory = deployment!.factory
    manager.positionCount = ZERO_BI
  }
  return manager
}

export function loadPosition(positionManager: Address, tokenId: BigInt): Position {
  const position = Position.load(getPositionId(positionManager, tokenId))
  if (position == null) {
    // every event that names a token follows the token's Mint, which creates the Position
    log.critical("loadPosition: no Position for token {} of PositionManager {}", [
      tokenId.toString(),
      positionManager.toHexString()
    ])
  }
  return position!
}

// What an amount of LP in a bucket is worth in quote at the bucket's exchange rate, rounded down to
// 1e-18. LP in a bucket that holds neither quote nor collateral is worth nothing, though the pool
// reports an exchange rate of 1 for such a bucket.
function lpValueInQuote(lpb: BigDecimal, bucket: Bucket): BigDecimal {
  if (bucket.deposit.equals(ZERO_BD) && bucket.collateral.equals(ZERO_BD)) return ZERO_BD
  return wadToDecimal(decimalToWad(lpb.times(bucket.exchangeRate)))
}

// Sets the position's PositionLend in a bucket to what the manager holds for it there, removing
// it if the position has no LP in the bucket.
//
// The LP is read from the manager rather than worked out from the event. MemorializePosition does
// not say how much LP joined the position in each bucket, and lists buckets where the owner had
// none. Like every contract read, this returns the state at the end of the event's block, so a
// PositionLend already refreshed in this block is left as it is.
export function updatePositionLend(position: Position, pool: Pool, index: i32, block: ethereum.Block): void {
  const lendId = getPositionLendId(position.id, index)
  let lend = PositionLend.load(lendId)
  if (lend != null && lend.updatedAtBlockNumber.equals(block.number)) return

  // Zeros for a bucket the position holds nothing in, and for a token burned later in the block.
  const info = PositionManagerContract.bind(Address.fromBytes(position.positionManager)).getPositionInfo(
    position.tokenId,
    BigInt.fromI32(index)
  )
  const lp = info.value0
  if (lp.equals(ZERO_BI)) {
    if (lend != null) store.remove("PositionLend", lendId.toHexString())
    return
  }

  const bucket = updateBucket(pool, index, block)
  if (lend == null) {
    lend = new PositionLend(lendId)
    lend.position = position.id
    lend.pool = pool.id
    lend.bucket = bucket.id
    lend.bucketIndex = index
  }
  lend.lpb = wadToDecimal(lp)
  lend.lpbValueInQuote = lpValueInQuote(lend.lpb, bucket)
  lend.depositTime = info.value1
  lend.updatedAtBlockNumber = block.number
  lend.updatedAtTimestamp = block.timestamp
  lend.save()
}
