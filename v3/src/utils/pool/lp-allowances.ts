import { BigInt, Bytes, store } from "@graphprotocol/graph-ts"

import { LPAllowance, LPAllowanceList } from "../../../generated/schema"

import { MAX_BUCKET_INDEX_BI, ZERO_BI } from "../constants"
import { wadToDecimal } from "../convert"

// The pool changes an allowance by exactly the event's amount, so these follow the events
// without reading the chain. A transfer also clears the allowance it used: see clearAllowances.
//
// The arithmetic is done on the exact integer amounts (amountWad). BigDecimal keeps 34
// significant digits, so an allowance of the largest uint256, which is a common way to approve
// "everything", would not subtract back to exactly zero.

export function getAllowanceListId(poolId: Bytes, lender: Bytes, spender: Bytes): Bytes {
  const separator = Bytes.fromUTF8("|")
  return poolId.concat(separator).concat(lender).concat(separator).concat(spender)
}

export function getAllowanceId(allowanceListId: Bytes, index: BigInt): Bytes {
  return allowanceListId.concat(Bytes.fromUTF8("|" + index.toString()))
}

// The pool does not check an allowance's bucket index: it accepts any uint256. An index past the
// last bucket is skipped. It could not be stored as an Int (converting one that does not fit
// aborts the handler, which would halt the subgraph), and it grants nothing, since transferLP
// rejects it.
function isBucketIndex(index: BigInt): boolean {
  return index.le(MAX_BUCKET_INDEX_BI)
}

function ensureAllowanceList(listId: Bytes, poolId: Bytes, lender: Bytes, spender: Bytes): void {
  if (LPAllowanceList.load(listId) != null) return
  const list = new LPAllowanceList(listId)
  list.pool = poolId
  list.lender = lender
  list.spender = spender
  list.save()
}

function removeAllowance(allowanceId: Bytes): void {
  if (LPAllowance.load(allowanceId) != null) store.remove("LPAllowance", allowanceId.toHexString())
}

function saveOrRemoveAllowance(allowance: LPAllowance): void {
  if (allowance.amountWad.gt(ZERO_BI)) {
    allowance.amount = wadToDecimal(allowance.amountWad)
    allowance.save()
  } else {
    removeAllowance(allowance.id)
  }
}

export function increaseAllowances(
  poolId: Bytes,
  lender: Bytes,
  spender: Bytes,
  indexes: BigInt[],
  amounts: BigInt[]
): void {
  const listId = getAllowanceListId(poolId, lender, spender)
  for (let i = 0; i < indexes.length; i++) {
    if (!isBucketIndex(indexes[i])) continue

    const allowanceId = getAllowanceId(listId, indexes[i])
    let allowance = LPAllowance.load(allowanceId)
    if (allowance == null) {
      allowance = new LPAllowance(allowanceId)
      allowance.allowanceList = listId
      allowance.index = indexes[i].toI32()
      allowance.amountWad = ZERO_BI
    }
    allowance.amountWad = allowance.amountWad.plus(amounts[i])
    if (allowance.amountWad.gt(ZERO_BI)) ensureAllowanceList(listId, poolId, lender, spender)
    saveOrRemoveAllowance(allowance)
  }
}

export function decreaseAllowances(
  poolId: Bytes,
  lender: Bytes,
  spender: Bytes,
  indexes: BigInt[],
  amounts: BigInt[]
): void {
  const listId = getAllowanceListId(poolId, lender, spender)
  for (let i = 0; i < indexes.length; i++) {
    const allowance = LPAllowance.load(getAllowanceId(listId, indexes[i]))
    if (allowance != null) {
      allowance.amountWad = allowance.amountWad.minus(amounts[i])
      saveOrRemoveAllowance(allowance)
    }
  }
}

// Removes the lender's allowances to the spender in the given buckets: on RevokeLPAllowance, and
// on TransferLP, where the pool deletes the allowance of every bucket named in the transfer
// without emitting an event for it.
export function clearAllowances(poolId: Bytes, lender: Bytes, spender: Bytes, indexes: BigInt[]): void {
  const listId = getAllowanceListId(poolId, lender, spender)
  for (let i = 0; i < indexes.length; i++) {
    removeAllowance(getAllowanceId(listId, indexes[i]))
  }
}
