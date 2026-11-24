import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts"

import { Bucket, Pool } from "../../../generated/schema"
import { PoolInfoUtils } from "../../../generated/templates/ERC20Pool/PoolInfoUtils"

import { wadToDecimal } from "../convert"
import { poolDeployment } from "../deployments"

export function getBucketId(poolId: Bytes, index: i32): Bytes {
  return poolId.concat(Bytes.fromUTF8("#" + index.toString()))
}

// Creates the bucket if needed, refreshes it from chain and saves it. Like updatePool, it reads
// once per block: a bucket already refreshed in this block is returned as it is.
export function updateBucket(pool: Pool, index: i32, block: ethereum.Block): Bucket {
  const bucketId = getBucketId(pool.id, index)
  let bucket = Bucket.load(bucketId)
  if (bucket != null && bucket.updatedAtBlockNumber.equals(block.number)) return bucket

  const bucketInfo = PoolInfoUtils.bind(poolDeployment(pool).poolInfoUtils).bucketInfo(
    Address.fromBytes(pool.id),
    BigInt.fromI32(index)
  )

  if (bucket == null) {
    bucket = new Bucket(bucketId)
    bucket.pool = pool.id
    bucket.poolAddress = pool.id.toHexString()
    bucket.bucketIndex = index
    bucket.bucketPrice = wadToDecimal(bucketInfo.getPrice_())
  }
  bucket.deposit = wadToDecimal(bucketInfo.getQuoteTokens_())
  bucket.collateral = wadToDecimal(bucketInfo.getCollateral_())
  bucket.lpb = wadToDecimal(bucketInfo.getBucketLP_())
  bucket.exchangeRate = wadToDecimal(bucketInfo.getExchangeRate_())
  bucket.updatedAtBlockNumber = block.number
  bucket.updatedAtTimestamp = block.timestamp
  bucket.save()

  return bucket
}
