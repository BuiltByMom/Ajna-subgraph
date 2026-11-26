import { Address, BigInt, Bytes, ethereum, log, store } from "@graphprotocol/graph-ts"

import { Bucket, Lend, Pool } from "../../../generated/schema"
import { ERC20Pool } from "../../../generated/templates/ERC20Pool/ERC20Pool"
import { PoolInfoUtils } from "../../../generated/templates/ERC20Pool/PoolInfoUtils"

import { ensureAccount } from "../account"
import { ZERO_BI } from "../constants"
import { wadToDecimal } from "../convert"
import { poolDeployment } from "../deployments"

export function getLendId(bucketId: Bytes, lender: Bytes): Bytes {
  return bucketId.concat(Bytes.fromUTF8("|")).concat(lender)
}

// Sets the lender's Lend in the bucket to what the pool holds for them, removing it if they have
// no LP left there.
//
// The position is read from chain rather than worked out from the event: a marked lender's
// removals are claims from escrow that follow different arithmetic, and TransferLP does not say
// how much LP moved in each bucket.
//
// If the reader contract cannot be read (see updateBucket), the Lend is left as it is: one that
// does not exist yet is not created, and the next event that names the lender in the bucket
// catches up.
//
// Like every contract read, this returns the state at the end of the event's block, so a Lend
// already refreshed in this block is left as it is.
export function updateLend(pool: Pool, bucket: Bucket, lender: Address, block: ethereum.Block): void {
  const poolAddress = Address.fromBytes(pool.id)
  const index = BigInt.fromI32(bucket.bucketIndex)
  const lendId = getLendId(bucket.id, lender)
  let lend = Lend.load(lendId)
  if (lend != null && lend.updatedAtBlockNumber.equals(block.number)) return

  const positionCall = PoolInfoUtils.bind(poolDeployment(pool).poolInfoUtils).try_lenderPosition(
    poolAddress,
    index,
    lender
  )
  if (positionCall.reverted) {
    log.warning("updateLend: could not read lender {} in bucket {} of pool {} at block {}; keeping the Lend as it is", [
      lender.toHexString(),
      bucket.bucketIndex.toString(),
      pool.id.toHexString(),
      block.number.toString()
    ])
    return
  }
  const position = positionCall.value
  const lp = position.getLp_()
  if (lp.equals(ZERO_BI)) {
    if (lend != null) store.remove("Lend", lendId.toHexString())
    return
  }

  if (lend == null) {
    lend = new Lend(lendId)
    lend.pool = pool.id
    lend.poolAddress = pool.id.toHexString()
    lend.bucket = bucket.id
    lend.bucketIndex = bucket.bucketIndex
    lend.lender = lender
    lend.account = lender
    ensureAccount(lender)
  }
  lend.lpb = wadToDecimal(lp)
  lend.lpbValueInQuote = wadToDecimal(position.getLiveWorth_().plus(position.getFundedWorth_()))
  lend.marked = position.getMarked_()
  lend.liveLpb = wadToDecimal(position.getLiveLp_())
  lend.fundedValueInQuote = wadToDecimal(position.getFundedWorth_())
  lend.depositTime = ERC20Pool.bind(poolAddress).lenderInfo(index, lender).getDepositTime_()
  lend.updatedAtBlockNumber = block.number
  lend.updatedAtTimestamp = block.timestamp
  lend.save()
}
