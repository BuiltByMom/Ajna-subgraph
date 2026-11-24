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

// Not implemented yet: these handlers index nothing. See the note in erc-20-pool.ts.
//
// A network can hold several PositionManagers (one per pool factory), and their token ids overlap.
// Handlers must identify a position by event.address together with the token id.

export function handleApproval(event: ApprovalEvent): void {}

export function handleApprovalForAll(event: ApprovalForAllEvent): void {}

export function handleBurn(event: BurnEvent): void {}

export function handleMemorializePosition(event: MemorializePositionEvent): void {}

export function handleMint(event: MintEvent): void {}

export function handleMoveLiquidity(event: MoveLiquidityEvent): void {}

export function handleRedeemPosition(event: RedeemPositionEvent): void {}

export function handleTransfer(event: TransferEvent): void {}
