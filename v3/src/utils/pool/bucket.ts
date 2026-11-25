import { Address, BigInt, Bytes, ethereum, log } from "@graphprotocol/graph-ts"

import { Bucket, Pool } from "../../../generated/schema"
import { ERC20Pool } from "../../../generated/templates/ERC20Pool/ERC20Pool"
import { PoolInfoUtils } from "../../../generated/templates/ERC20Pool/PoolInfoUtils"

import { ZERO_BD, ZERO_BI } from "../constants"
import { wadToDecimal } from "../convert"
import { poolDeployment } from "../deployments"

export function getBucketId(poolId: Bytes, index: i32): Bytes {
  return poolId.concat(Bytes.fromUTF8("#" + index.toString()))
}

// Creates the bucket if needed, refreshes the fields that are read from chain and saves it. Like
// updatePool, it reads once per block: a bucket already refreshed in this block is returned as it is.
//
// The reader contract can fail to answer: it has no code in a block before it was deployed, which
// a pool event can precede if the factory was deployed first. The bucket then keeps what it held,
// apart from its t0 debt, and updatedAtBlockNumber shows it was not refreshed. A bucket that did
// not exist yet is created without price, deposit, collateral, LP or exchange rate, because the
// entity that records the event points at it. A handler must never stop on this: the subgraph
// could not get past the block.
export function updateBucket(pool: Pool, index: i32, block: ethereum.Block): Bucket {
  const bucketId = getBucketId(pool.id, index)
  let bucket = Bucket.load(bucketId)
  if (bucket != null && bucket.updatedAtBlockNumber.equals(block.number)) return bucket

  if (bucket == null) {
    bucket = new Bucket(bucketId)
    bucket.pool = pool.id
    bucket.poolAddress = pool.id.toHexString()
    bucket.bucketIndex = index
    bucket.bucketPrice = ZERO_BD
    bucket.deposit = ZERO_BD
    bucket.collateral = ZERO_BD
    bucket.lpb = ZERO_BD
    bucket.exchangeRate = ZERO_BD
    bucket.updatedAtBlockNumber = ZERO_BI
    bucket.updatedAtTimestamp = ZERO_BI
    // the exit queue fields follow the pool's events: see exit-queue.ts
    bucket.queueHead = ZERO_BD
    bucket.queueTail = ZERO_BD
    bucket.escrowQuote = ZERO_BD
    bucket.escrowCollateral = ZERO_BD
  }

  // Read first, and whether or not the reader can be: it is a stored value of the pool itself, so
  // the bucket's t0 debt keeps matching its loans'.
  const poolAddress = Address.fromBytes(pool.id)
  bucket.t0debt = wadToDecimal(ERC20Pool.bind(poolAddress).bucketT0Debt(BigInt.fromI32(index)))

  const infoCall = PoolInfoUtils.bind(poolDeployment(pool).poolInfoUtils).try_bucketInfo(
    poolAddress,
    BigInt.fromI32(index)
  )
  if (infoCall.reverted) {
    log.warning("updateBucket: could not read bucket {} of pool {} at block {}; keeping its state from block {}", [
      index.toString(),
      pool.id.toHexString(),
      block.number.toString(),
      bucket.updatedAtBlockNumber.toString()
    ])
    bucket.save()
    return bucket
  }

  const bucketInfo = infoCall.value
  bucket.bucketPrice = wadToDecimal(bucketInfo.getPrice_())
  bucket.deposit = wadToDecimal(bucketInfo.getQuoteTokens_())
  bucket.collateral = wadToDecimal(bucketInfo.getCollateral_())
  bucket.lpb = wadToDecimal(bucketInfo.getBucketLP_())
  bucket.exchangeRate = wadToDecimal(bucketInfo.getExchangeRate_())
  bucket.updatedAtBlockNumber = block.number
  bucket.updatedAtTimestamp = block.timestamp
  bucket.save()

  return bucket
}
