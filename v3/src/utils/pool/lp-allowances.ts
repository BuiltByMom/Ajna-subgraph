import { BigInt, Bytes, store } from "@graphprotocol/graph-ts"

import { LPAllowance, LPAllowanceList } from "../../../generated/schema"

import { ZERO_BD } from "../constants"
import { wadToDecimal } from "../convert"

// The pool changes an allowance by exactly the event's amount, so these follow the events
// without reading the chain. A transfer also clears the allowance it used: see clearAllowances.

export function getAllowanceListId(poolId: Bytes, lender: Bytes, spender: Bytes): Bytes {
  const separator = Bytes.fromUTF8("|")
  return poolId.concat(separator).concat(lender).concat(separator).concat(spender)
}

export function getAllowanceId(allowanceListId: Bytes, index: BigInt): Bytes {
  return allowanceListId.concat(Bytes.fromUTF8("|" + index.toString()))
}

function removeAllowance(allowanceId: Bytes): void {
  if (LPAllowance.load(allowanceId) != null) store.remove("LPAllowance", allowanceId.toHexString())
}

function saveOrRemoveAllowance(allowance: LPAllowance): void {
  if (allowance.amount.gt(ZERO_BD)) {
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
  if (LPAllowanceList.load(listId) == null) {
    const list = new LPAllowanceList(listId)
    list.pool = poolId
    list.lender = lender
    list.spender = spender
    list.save()
  }

  for (let i = 0; i < indexes.length; i++) {
    const allowanceId = getAllowanceId(listId, indexes[i])
    let allowance = LPAllowance.load(allowanceId)
    if (allowance == null) {
      allowance = new LPAllowance(allowanceId)
      allowance.allowanceList = listId
      allowance.index = indexes[i].toI32()
      allowance.amount = ZERO_BD
    }
    allowance.amount = allowance.amount.plus(wadToDecimal(amounts[i]))
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
      allowance.amount = allowance.amount.minus(wadToDecimal(amounts[i]))
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
