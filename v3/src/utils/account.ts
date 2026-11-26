import { Bytes } from "@graphprotocol/graph-ts"

import { Account } from "../../generated/schema"

import { ONE_BI, ZERO_BI } from "./constants"

export function loadOrCreateAccount(accountId: Bytes): Account {
  let account = Account.load(accountId)
  if (account == null) {
    account = new Account(accountId)
    account.txCount = ZERO_BI
  }
  return account
}

// An entity that points at an account needs the Account to exist, even if it has done nothing itself.
export function ensureAccount(accountId: Bytes): void {
  if (Account.load(accountId) == null) loadOrCreateAccount(accountId).save()
}

export function incrementAccountTxCount(accountId: Bytes): void {
  const account = loadOrCreateAccount(accountId)
  account.txCount = account.txCount.plus(ONE_BI)
  account.save()
}
