import { Address, store } from "@graphprotocol/graph-ts"

import {
  Approval as ApprovalEvent,
  ApprovalForAll as ApprovalForAllEvent,
  Burn as BurnEvent,
  MemorializePosition as MemorializePositionEvent,
  Mint as MintEvent,
  MoveLiquidity as MoveLiquidityEvent,
  RedeemPosition as RedeemPositionEvent,
  Transfer as TransferEvent
} from "../../generated/PositionManager/PositionManager"
import {
  Approval,
  ApprovalForAll,
  Burn,
  MemorializePosition,
  Mint,
  MoveLiquidity,
  Position,
  RedeemPosition,
  Transfer
} from "../../generated/schema"

import { ensureAccount, incrementAccountTxCount } from "../utils/account"
import { ONE_BI } from "../utils/constants"
import { bigIntArrayToIntArray, eventId, wadToDecimal } from "../utils/convert"
import { updateBucket } from "../utils/pool/bucket"
import { loadPool } from "../utils/pool/pool"
import { getPositionId, loadOrCreatePositionManager, loadPosition, updatePositionLend } from "../utils/position"

// A network can hold several PositionManagers, one per pool factory, and their token ids overlap.
// A position is always found by the address that emitted the event together with the token id.
//
// The manager holds its positions' LP in the pool under its own address, so each call that moves
// LP also makes the pool emit its own event first, with the manager as a lender:
//
//   memorializePositions  TransferLP (pool), MemorializePosition
//   moveLiquidity         MoveQuoteToken (pool), MoveLiquidity
//   redeemPositions       IncreaseLPAllowance (pool), TransferLP (pool), RedeemPosition
//   mint                  Transfer, Mint
//   burn                  Transfer, Burn
//
// The pool's handlers count those calls as actions on the pool and keep the manager's own Lend.
// The handlers here keep each position's part of that LP, and count the action for the owner.
//
// The bucket indexes in these events are converted to Ints, which is safe because the pool
// rejects an index that is not a bucket in transferLP and moveQuoteToken, within the same call.

/****************/
/*** Position ***/
/****************/

// The position is created here and not by the Transfer that the mint emits just before: only
// Mint names the pool.
export function handleMint(event: MintEvent): void {
  const manager = loadOrCreatePositionManager(event.address)
  manager.positionCount = manager.positionCount.plus(ONE_BI)
  manager.save()

  // the manager only mints for a pool its factory deployed
  const pool = loadPool(event.params.pool)

  const position = new Position(getPositionId(manager.id, event.params.tokenId))
  position.positionManager = manager.id
  position.tokenId = event.params.tokenId
  position.pool = pool.id
  position.owner = event.params.lender
  position.account = event.params.lender
  position.createdAtBlockNumber = event.block.number
  position.createdAtTimestamp = event.block.timestamp
  position.save()
  incrementAccountTxCount(event.params.lender)

  const mint = new Mint(eventId(event))
  mint.positionManager = manager.id
  mint.tokenId = event.params.tokenId
  mint.pool = pool.id
  mint.lender = event.params.lender

  mint.blockNumber = event.block.number
  mint.blockTimestamp = event.block.timestamp
  mint.transactionHash = event.transaction.hash
  mint.save()
}

// The manager does not burn a position that still holds LP, and every call that takes LP out of
// a position names the buckets it leaves, so no PositionLend is left behind.
export function handleBurn(event: BurnEvent): void {
  const position = loadPosition(event.address, event.params.tokenId)

  const manager = loadOrCreatePositionManager(event.address)
  manager.positionCount = manager.positionCount.minus(ONE_BI)
  manager.save()
  incrementAccountTxCount(position.owner)

  const burn = new Burn(eventId(event))
  burn.positionManager = position.positionManager
  burn.tokenId = position.tokenId
  burn.pool = position.pool
  burn.lender = event.params.lender
  burn.owner = position.owner

  burn.blockNumber = event.block.number
  burn.blockTimestamp = event.block.timestamp
  burn.transactionHash = event.transaction.hash
  burn.save()

  store.remove("Position", position.id.toHexString())
}

// A mint and a burn emit a Transfer too, from or to the zero address, just before their Mint and
// Burn. Those handlers create and remove the position, so only a transfer between holders is
// handled here. It leaves the position's LP as it is, and clears any approval without an event.
export function handleTransfer(event: TransferEvent): void {
  if (event.params.from.equals(Address.zero()) || event.params.to.equals(Address.zero())) return

  const position = loadPosition(event.address, event.params.tokenId)
  position.owner = event.params.to
  position.account = event.params.to
  position.save()
  ensureAccount(event.params.to)

  const transfer = new Transfer(eventId(event))
  transfer.positionManager = position.positionManager
  transfer.tokenId = position.tokenId
  transfer.pool = position.pool
  transfer.from = event.params.from
  transfer.to = event.params.to

  transfer.blockNumber = event.block.number
  transfer.blockTimestamp = event.block.timestamp
  transfer.transactionHash = event.transaction.hash
  transfer.save()
}

/**********/
/*** LP ***/
/**********/

// The owner's LP in each bucket named joins the position. A bucket where the owner held no LP is
// named all the same, and leaves the position as it was.
export function handleMemorializePosition(event: MemorializePositionEvent): void {
  const position = loadPosition(event.address, event.params.tokenId)
  const pool = loadPool(Address.fromBytes(position.pool))
  incrementAccountTxCount(event.params.lender)

  const indexes = event.params.indexes
  for (let i = 0; i < indexes.length; i++) {
    updatePositionLend(position, pool, indexes[i].toI32(), event.block)
  }

  const memorialize = new MemorializePosition(eventId(event))
  memorialize.positionManager = position.positionManager
  memorialize.tokenId = position.tokenId
  memorialize.pool = pool.id
  memorialize.lender = event.params.lender
  memorialize.indexes = bigIntArrayToIntArray(indexes)

  memorialize.blockNumber = event.block.number
  memorialize.blockTimestamp = event.block.timestamp
  memorialize.transactionHash = event.transaction.hash
  memorialize.save()
}

// All of the position's LP in each bucket named returns to the owner.
export function handleRedeemPosition(event: RedeemPositionEvent): void {
  const position = loadPosition(event.address, event.params.tokenId)
  const pool = loadPool(Address.fromBytes(position.pool))
  incrementAccountTxCount(event.params.lender)

  const indexes = event.params.indexes
  for (let i = 0; i < indexes.length; i++) {
    updatePositionLend(position, pool, indexes[i].toI32(), event.block)
  }

  const redeem = new RedeemPosition(eventId(event))
  redeem.positionManager = position.positionManager
  redeem.tokenId = position.tokenId
  redeem.pool = pool.id
  redeem.lender = event.params.lender
  redeem.indexes = bigIntArrayToIntArray(indexes)

  redeem.blockNumber = event.block.number
  redeem.blockTimestamp = event.block.timestamp
  redeem.transactionHash = event.transaction.hash
  redeem.save()
}

// Moves what can be moved of the position's quote from one bucket to another. Quote that is lent
// out stays, so the position can keep LP in the bucket it moved from.
export function handleMoveLiquidity(event: MoveLiquidityEvent): void {
  const position = loadPosition(event.address, event.params.tokenId)
  const pool = loadPool(Address.fromBytes(position.pool))
  incrementAccountTxCount(event.params.lender)

  const fromIndex = event.params.fromIndex.toI32()
  const toIndex = event.params.toIndex.toI32()
  updatePositionLend(position, pool, fromIndex, event.block)
  updatePositionLend(position, pool, toIndex, event.block)

  const moveLiquidity = new MoveLiquidity(eventId(event))
  moveLiquidity.positionManager = position.positionManager
  moveLiquidity.tokenId = position.tokenId
  moveLiquidity.pool = pool.id
  moveLiquidity.lender = event.params.lender
  moveLiquidity.from = updateBucket(pool, fromIndex, event.block).id
  moveLiquidity.to = updateBucket(pool, toIndex, event.block).id
  moveLiquidity.fromIndex = fromIndex
  moveLiquidity.toIndex = toIndex
  moveLiquidity.lpRedeemedFrom = wadToDecimal(event.params.lpRedeemedFrom)
  moveLiquidity.lpAwardedTo = wadToDecimal(event.params.lpAwardedTo)

  moveLiquidity.blockNumber = event.block.number
  moveLiquidity.blockTimestamp = event.block.timestamp
  moveLiquidity.transactionHash = event.transaction.hash
  moveLiquidity.save()
}

/*****************/
/*** Approvals ***/
/*****************/

export function handleApproval(event: ApprovalEvent): void {
  const position = loadPosition(event.address, event.params.tokenId)

  const approval = new Approval(eventId(event))
  approval.positionManager = position.positionManager
  approval.tokenId = position.tokenId
  approval.pool = position.pool
  approval.owner = event.params.owner
  approval.approved = event.params.approved

  approval.blockNumber = event.block.number
  approval.blockTimestamp = event.block.timestamp
  approval.transactionHash = event.transaction.hash
  approval.save()
}

// Needs no position: an owner can approve an operator before the manager has minted anything.
export function handleApprovalForAll(event: ApprovalForAllEvent): void {
  const manager = loadOrCreatePositionManager(event.address)
  manager.save()

  const approvalForAll = new ApprovalForAll(eventId(event))
  approvalForAll.positionManager = manager.id
  approvalForAll.owner = event.params.owner
  approvalForAll.operator = event.params.operator
  approvalForAll.approved = event.params.approved

  approvalForAll.blockNumber = event.block.number
  approvalForAll.blockTimestamp = event.block.timestamp
  approvalForAll.transactionHash = event.transaction.hash
  approvalForAll.save()
}
