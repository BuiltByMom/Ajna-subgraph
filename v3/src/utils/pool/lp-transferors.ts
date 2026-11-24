import { Address, Bytes, store } from "@graphprotocol/graph-ts"

import { LPTransferorList } from "../../../generated/schema"

export function getTransferorListId(poolId: Bytes, lender: Bytes): Bytes {
  return poolId.concat(Bytes.fromUTF8("|")).concat(lender)
}

function loadOrCreateTransferorList(poolId: Bytes, lender: Bytes): LPTransferorList {
  const id = getTransferorListId(poolId, lender)
  let list = LPTransferorList.load(id)
  if (list == null) {
    list = new LPTransferorList(id)
    list.pool = poolId
    list.lender = lender
    list.transferors = []
  }
  return list
}

function saveOrRemoveTransferorList(list: LPTransferorList): void {
  if (list.transferors.length != 0) {
    list.save()
  } else if (LPTransferorList.load(list.id) != null) {
    store.remove("LPTransferorList", list.id.toHexString())
  }
}

export function approveTransferors(poolId: Bytes, lender: Bytes, approved: Address[]): void {
  const list = loadOrCreateTransferorList(poolId, lender)
  const transferors = list.transferors
  for (let i = 0; i < approved.length; i++) {
    if (transferors.indexOf(approved[i]) == -1) transferors.push(approved[i])
  }
  list.transferors = transferors
  saveOrRemoveTransferorList(list)
}

export function revokeTransferors(poolId: Bytes, lender: Bytes, revoked: Address[]): void {
  const list = loadOrCreateTransferorList(poolId, lender)
  const transferors = list.transferors
  for (let i = 0; i < revoked.length; i++) {
    const position = transferors.indexOf(revoked[i])
    if (position != -1) transferors.splice(position, 1)
  }
  list.transferors = transferors
  saveOrRemoveTransferorList(list)
}
