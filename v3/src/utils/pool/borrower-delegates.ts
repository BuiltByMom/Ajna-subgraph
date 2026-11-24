import { Address, Bytes, store } from "@graphprotocol/graph-ts"

import { BorrowerDelegate } from "../../../generated/schema"

export function getBorrowerDelegateId(poolId: Bytes, borrower: Bytes, delegate: Bytes): Bytes {
  const separator = Bytes.fromUTF8("|")
  return poolId.concat(separator).concat(borrower).concat(separator).concat(delegate)
}

// One call approves or revokes a list of delegates. A BorrowerDelegate exists while its
// delegate is approved.
export function setBorrowerDelegates(poolId: Bytes, borrower: Bytes, delegates: Address[], approved: boolean): void {
  for (let i = 0; i < delegates.length; i++) {
    const id = getBorrowerDelegateId(poolId, borrower, delegates[i])
    const exists = BorrowerDelegate.load(id) != null
    if (approved && !exists) {
      const borrowerDelegate = new BorrowerDelegate(id)
      borrowerDelegate.pool = poolId
      borrowerDelegate.borrower = borrower
      borrowerDelegate.delegate = delegates[i]
      borrowerDelegate.save()
    } else if (!approved && exists) {
      store.remove("BorrowerDelegate", id.toHexString())
    }
  }
}
