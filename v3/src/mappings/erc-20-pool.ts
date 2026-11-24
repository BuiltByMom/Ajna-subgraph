import {
  AddCollateral as AddCollateralEvent,
  AddQuoteToken as AddQuoteTokenEvent,
  ApproveLPTransferors as ApproveLPTransferorsEvent,
  DecreaseLPAllowance as DecreaseLPAllowanceEvent,
  DrawDebt as DrawDebtEvent,
  ExitQueueFunded as ExitQueueFundedEvent,
  Flashloan as FlashloanEvent,
  ImproveLoan as ImproveLoanEvent,
  IncreaseLPAllowance as IncreaseLPAllowanceEvent,
  InterestUpdateFailure as InterestUpdateFailureEvent,
  KickCollateralSurplusAuction as KickCollateralSurplusAuctionEvent,
  KickQuoteSurplusAuction as KickQuoteSurplusAuctionEvent,
  LoanCalled as LoanCalledEvent,
  LoanClosed as LoanClosedEvent,
  MarkQuoteForWithdrawal as MarkQuoteForWithdrawalEvent,
  MoveLoan as MoveLoanEvent,
  MoveQuoteToken as MoveQuoteTokenEvent,
  RemoveCollateral as RemoveCollateralEvent,
  RemoveQuoteToken as RemoveQuoteTokenEvent,
  RepayDebt as RepayDebtEvent,
  RevokeLPAllowance as RevokeLPAllowanceEvent,
  RevokeLPTransferors as RevokeLPTransferorsEvent,
  SetBorrowerDelegates as SetBorrowerDelegatesEvent,
  TakeCollateralSurplus as TakeCollateralSurplusEvent,
  TakeQuoteSurplus as TakeQuoteSurplusEvent,
  TransferLP as TransferLPEvent,
  UpdateInterestRate as UpdateInterestRateEvent
} from "../../generated/templates/ERC20Pool/ERC20Pool"

// Not implemented yet: these handlers index nothing. Every pool event has one so that the build
// checks each signature against the pinned ABI, and so that `yarn configure` can tell when the
// ABI gains an event that nothing handles.

// lender

export function handleAddCollateral(event: AddCollateralEvent): void {}

export function handleAddQuoteToken(event: AddQuoteTokenEvent): void {}

export function handleMoveQuoteToken(event: MoveQuoteTokenEvent): void {}

export function handleRemoveCollateral(event: RemoveCollateralEvent): void {}

export function handleRemoveQuoteToken(event: RemoveQuoteTokenEvent): void {}

// lender exit queue

export function handleMarkQuoteForWithdrawal(event: MarkQuoteForWithdrawalEvent): void {}

export function handleExitQueueFunded(event: ExitQueueFundedEvent): void {}

// LP allowances and transfers

export function handleApproveLPTransferors(event: ApproveLPTransferorsEvent): void {}

export function handleRevokeLPTransferors(event: RevokeLPTransferorsEvent): void {}

export function handleIncreaseLPAllowance(event: IncreaseLPAllowanceEvent): void {}

export function handleDecreaseLPAllowance(event: DecreaseLPAllowanceEvent): void {}

export function handleRevokeLPAllowance(event: RevokeLPAllowanceEvent): void {}

export function handleTransferLP(event: TransferLPEvent): void {}

// borrower

export function handleDrawDebt(event: DrawDebtEvent): void {}

export function handleRepayDebt(event: RepayDebtEvent): void {}

export function handleMoveLoan(event: MoveLoanEvent): void {}

export function handleImproveLoan(event: ImproveLoanEvent): void {}

export function handleLoanClosed(event: LoanClosedEvent): void {}

export function handleLoanCalled(event: LoanCalledEvent): void {}

export function handleSetBorrowerDelegates(event: SetBorrowerDelegatesEvent): void {}

// surplus auctions

export function handleKickQuoteSurplusAuction(event: KickQuoteSurplusAuctionEvent): void {}

export function handleTakeQuoteSurplus(event: TakeQuoteSurplusEvent): void {}

export function handleKickCollateralSurplusAuction(event: KickCollateralSurplusAuctionEvent): void {}

export function handleTakeCollateralSurplus(event: TakeCollateralSurplusEvent): void {}

// pool

export function handleFlashloan(event: FlashloanEvent): void {}

export function handleUpdateInterestRate(event: UpdateInterestRateEvent): void {}

export function handleInterestUpdateFailure(event: InterestUpdateFailureEvent): void {}
