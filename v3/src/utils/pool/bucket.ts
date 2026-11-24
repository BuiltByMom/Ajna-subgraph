import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts"

import { Bucket, Pool } from "../../../generated/schema"
import { ERC20Pool } from "../../../generated/templates/ERC20Pool/ERC20Pool"
import { PoolInfoUtils } from "../../../generated/templates/ERC20Pool/PoolInfoUtils"

import { ZERO_BD } from "../constants"
import { wadToDecimal } from "../convert"
import { poolDeployment } from "../deployments"

export function getBucketId(poolId: Bytes, index: i32): Bytes {
  return poolId.concat(Bytes.fromUTF8("#" + index.toString()))
}

// Creates the bucket if needed, refreshes the fields that are read from chain and saves it. Like
// updatePool, it reads once per block: a bucket already refreshed in this block is returned as it is.
export function updateBucket(pool: Pool, index: i32, block: ethereum.Block): Bucket {
  const bucketId = getBucketId(pool.id, index)
  let bucket = Bucket.load(bucketId)
  if (bucket != null && bucket.updatedAtBlockNumber.equals(block.number)) return bucket

  const poolAddress = Address.fromBytes(pool.id)
  const bucketInfo = PoolInfoUtils.bind(poolDeployment(pool).poolInfoUtils).bucketInfo(
    poolAddress,
    BigInt.fromI32(index)
  )
  const t0Debt = ERC20Pool.bind(poolAddress).bucketT0Debt(BigInt.fromI32(index))

  if (bucket == null) {
    bucket = new Bucket(bucketId)
    bucket.pool = pool.id
    bucket.poolAddress = pool.id.toHexString()
    bucket.bucketIndex = index
    bucket.bucketPrice = wadToDecimal(bucketInfo.getPrice_())
    // the exit queue fields follow the pool's events: see exit-queue.ts
    bucket.queueHead = ZERO_BD
    bucket.queueTail = ZERO_BD
    bucket.escrowQuote = ZERO_BD
    bucket.escrowCollateral = ZERO_BD
  }
  bucket.deposit = wadToDecimal(bucketInfo.getQuoteTokens_())
  bucket.collateral = wadToDecimal(bucketInfo.getCollateral_())
  bucket.lpb = wadToDecimal(bucketInfo.getBucketLP_())
  bucket.exchangeRate = wadToDecimal(bucketInfo.getExchangeRate_())
  bucket.t0debt = wadToDecimal(t0Debt)
  bucket.updatedAtBlockNumber = block.number
  bucket.updatedAtTimestamp = block.timestamp
  bucket.save()

  return bucket
}
