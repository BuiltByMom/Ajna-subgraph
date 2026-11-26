import { createMockedFunction } from "matchstick-as"
import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts"

import { ONE_WAD_BI, ZERO_BI } from "../../src/utils/constants"

function uintValue(value: BigInt): ethereum.Value {
  return ethereum.Value.fromUnsignedBigInt(value)
}

function indexValue(index: i32): ethereum.Value {
  return ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(index))
}

/**********************/
/*** Factory, token ***/
/**********************/

export function mockLoanTerm(factory: Address, loanTerm: BigInt): void {
  createMockedFunction(factory, "loanTerm", "loanTerm():(uint256)").returns([uintValue(loanTerm)])
}

export function mockTokenInfo(token: Address, name: string, symbol: string): void {
  createMockedFunction(token, "name", "name():(string)").returns([ethereum.Value.fromString(name)])
  createMockedFunction(token, "symbol", "symbol():(string)").returns([ethereum.Value.fromString(symbol)])
}

// The scales a pool keeps for its two tokens, 10^(18 - decimals), fixed when the factory deployed
// it. A token's decimals are taken from these and not from the token.
export function mockPoolScales(pool: Address, collateralDecimals: i32, quoteDecimals: i32): void {
  createMockedFunction(pool, "collateralScale", "collateralScale():(uint256)").returns([
    uintValue(BigInt.fromI32(10).pow(<u8>(18 - collateralDecimals)))
  ])
  createMockedFunction(pool, "quoteTokenScale", "quoteTokenScale():(uint256)").returns([
    uintValue(BigInt.fromI32(10).pow(<u8>(18 - quoteDecimals)))
  ])
}

// A token that answers decimals() with a number no 32-bit integer holds. Nothing may convert it:
// a mapping that asks the token, as the generated try_decimals does, aborts here.
export function mockTokenDecimalsOutOfRange(token: Address): void {
  createMockedFunction(token, "decimals", "decimals():(uint8)").returns([
    uintValue(BigInt.fromI32(2).pow(255))
  ])
}

// a token whose name() and symbol() do not decode as strings
export function mockTokenStringsRevert(token: Address): void {
  createMockedFunction(token, "name", "name():(string)").reverts()
  createMockedFunction(token, "symbol", "symbol():(string)").reverts()
}

export function mockTokenBytes32Info(token: Address, name: string, symbol: string): void {
  createMockedFunction(token, "name", "name():(bytes32)").returns([ethereum.Value.fromFixedBytes(bytes32(name))])
  createMockedFunction(token, "symbol", "symbol():(bytes32)").returns([ethereum.Value.fromFixedBytes(bytes32(symbol))])
}

export function mockTokenBytes32InfoReverts(token: Address): void {
  createMockedFunction(token, "name", "name():(bytes32)").reverts()
  createMockedFunction(token, "symbol", "symbol():(bytes32)").reverts()
}

// text as a bytes32: its UTF-8 bytes padded with zeros on the right
function bytes32(text: string): Bytes {
  const padded = new Bytes(32)
  const utf8 = Bytes.fromUTF8(text)
  for (let i = 0; i < utf8.length; i++) {
    padded[i] = utf8[i]
  }
  return padded
}

/*********************/
/*** Pool snapshot ***/
/*********************/

// What the two PoolInfoUtilsMulticall reads, and the pool's own totalT0Debt, return for a pool.
// Values are WADs.
export class PoolSnapshot {
  poolSize: BigInt = ZERO_BI
  t0debt: BigInt = ZERO_BI
  inflator: BigInt = ONE_WAD_BI
  borrowRate: BigInt = ZERO_BI
  rateAtTarget: BigInt = ZERO_BI
  utilization: BigInt = ZERO_BI
  debt: BigInt = ZERO_BI
  quoteTokenBalance: BigInt = ZERO_BI
  collateralBalance: BigInt = ZERO_BI
  escrowedQuote: BigInt = ZERO_BI
  availableQuote: BigInt = ZERO_BI
  quoteSurplus: BigInt = ZERO_BI
  quoteSurplusClaimable: BigInt = ZERO_BI
  quoteSurplusLotRemaining: BigInt = ZERO_BI
  collateralSurplus: BigInt = ZERO_BI
  collateralSurplusClaimable: BigInt = ZERO_BI
  collateralSurplusLotRemaining: BigInt = ZERO_BI
}

const POOL_DETAILS_SIGNATURE =
  "poolDetailsMulticall(address):((uint256,uint256,uint256),(uint256,uint256,uint256,uint256),(uint256,uint256,uint256,uint256,uint256),(uint256,uint256,uint256,uint256,uint256))"
const POOL_BALANCES_SIGNATURE =
  "poolBalanceDetails(address):((uint256,uint256,uint256,uint256,uint256,uint256,uint256))"

function surplusInfo(surplus: BigInt, claimable: BigInt, lotRemaining: BigInt): ethereum.Value {
  const tuple = new ethereum.Tuple()
  tuple.push(uintValue(surplus))
  tuple.push(uintValue(claimable))
  tuple.push(uintValue(lotRemaining))
  tuple.push(uintValue(ZERO_BI)) // auctionPrice
  tuple.push(uintValue(ZERO_BI)) // timeRemaining
  return ethereum.Value.fromTuple(tuple)
}

export function mockPoolSnapshot(multicall: Address, pool: Address, snapshot: PoolSnapshot): void {
  const loansInfo = new ethereum.Tuple()
  loansInfo.push(uintValue(snapshot.poolSize))
  loansInfo.push(uintValue(snapshot.inflator))
  loansInfo.push(uintValue(ONE_WAD_BI)) // pendingInterestFactor

  const rates = new ethereum.Tuple()
  rates.push(uintValue(snapshot.borrowRate)) // pendingInterestRate
  rates.push(uintValue(snapshot.borrowRate))
  rates.push(uintValue(snapshot.rateAtTarget))
  rates.push(uintValue(snapshot.utilization))

  createMockedFunction(multicall, "poolDetailsMulticall", POOL_DETAILS_SIGNATURE)
    .withArgs([ethereum.Value.fromAddress(pool)])
    .returns([
      ethereum.Value.fromTuple(loansInfo),
      ethereum.Value.fromTuple(rates),
      surplusInfo(snapshot.quoteSurplus, snapshot.quoteSurplusClaimable, snapshot.quoteSurplusLotRemaining),
      surplusInfo(
        snapshot.collateralSurplus,
        snapshot.collateralSurplusClaimable,
        snapshot.collateralSurplusLotRemaining
      )
    ])

  const balances = new ethereum.Tuple()
  balances.push(uintValue(snapshot.debt))
  balances.push(uintValue(snapshot.debt)) // accruedDebt
  balances.push(uintValue(snapshot.quoteTokenBalance))
  balances.push(uintValue(snapshot.collateralBalance))
  balances.push(uintValue(snapshot.poolSize)) // depositSize
  balances.push(uintValue(snapshot.escrowedQuote))
  balances.push(uintValue(snapshot.availableQuote))

  createMockedFunction(multicall, "poolBalanceDetails", POOL_BALANCES_SIGNATURE)
    .withArgs([ethereum.Value.fromAddress(pool)])
    .returns([ethereum.Value.fromTuple(balances)])

  mockPoolT0Debt(pool, snapshot.t0debt)
}

// the pool's stored t0 debt, which is read from the pool itself and so stays readable when the readers revert
export function mockPoolT0Debt(pool: Address, t0debt: BigInt): void {
  createMockedFunction(pool, "totalT0Debt", "totalT0Debt():(uint256)").returns([uintValue(t0debt)])
}

// the readers' interest projection reverting, as it can after a pool's own accrual has failed
export function mockPoolSnapshotReverts(multicall: Address, pool: Address): void {
  createMockedFunction(multicall, "poolDetailsMulticall", POOL_DETAILS_SIGNATURE)
    .withArgs([ethereum.Value.fromAddress(pool)])
    .reverts()
}

/***********************/
/*** Buckets, lends  ***/
/***********************/

export class BucketState {
  price: BigInt = ONE_WAD_BI
  deposit: BigInt = ZERO_BI
  collateral: BigInt = ZERO_BI
  lp: BigInt = ZERO_BI
  exchangeRate: BigInt = ONE_WAD_BI
  t0debt: BigInt = ZERO_BI
}

export function mockBucketInfo(poolInfoUtils: Address, pool: Address, index: i32, bucket: BucketState): void {
  createMockedFunction(poolInfoUtils, "bucketInfo", BUCKET_INFO_SIGNATURE)
    .withArgs([ethereum.Value.fromAddress(pool), indexValue(index)])
    .returns([
      uintValue(bucket.price),
      uintValue(bucket.deposit),
      uintValue(bucket.collateral),
      uintValue(bucket.lp),
      uintValue(bucket.exchangeRate)
    ])

  createMockedFunction(pool, "bucketT0Debt", "bucketT0Debt(uint256):(uint256)")
    .withArgs([indexValue(index)])
    .returns([uintValue(bucket.t0debt)])
}

const BUCKET_INFO_SIGNATURE = "bucketInfo(address,uint256):(uint256,uint256,uint256,uint256,uint256)"
const LENDER_POSITION_SIGNATURE = "lenderPosition(address,uint256,address):(uint256,bool,uint256,uint256,uint256)"

// PoolInfoUtils not answering for a bucket, as in a block before the contract was deployed. The
// bucket's t0 debt is read from the pool itself, and stays readable.
export function mockBucketInfoReverts(poolInfoUtils: Address, pool: Address, index: i32, t0debt: BigInt): void {
  createMockedFunction(poolInfoUtils, "bucketInfo", BUCKET_INFO_SIGNATURE)
    .withArgs([ethereum.Value.fromAddress(pool), indexValue(index)])
    .reverts()

  createMockedFunction(pool, "bucketT0Debt", "bucketT0Debt(uint256):(uint256)")
    .withArgs([indexValue(index)])
    .returns([uintValue(t0debt)])
}

// PoolInfoUtils not answering for a lender in a bucket
export function mockLenderReverts(poolInfoUtils: Address, pool: Address, index: i32, lender: Address): void {
  createMockedFunction(poolInfoUtils, "lenderPosition", LENDER_POSITION_SIGNATURE)
    .withArgs([ethereum.Value.fromAddress(pool), indexValue(index), ethereum.Value.fromAddress(lender)])
    .reverts()
}

// What the pool holds for a lender in one bucket: PoolInfoUtils.lenderPosition and the pool's lenderInfo.
export class LenderState {
  lp: BigInt = ZERO_BI
  marked: boolean = false
  liveLp: BigInt = ZERO_BI
  liveWorth: BigInt = ZERO_BI
  fundedWorth: BigInt = ZERO_BI
  depositTime: BigInt = ZERO_BI
}

// a lender who is not on the exit queue: all of their LP is in the bucket
export function unmarkedLender(lp: BigInt, worth: BigInt, depositTime: BigInt): LenderState {
  const lender = new LenderState()
  lender.lp = lp
  lender.liveLp = lp
  lender.liveWorth = worth
  lender.depositTime = depositTime
  return lender
}

// A lender on the exit queue: fundedWorth is the worth of the LP the queue has funded, and the
// rest of their LP, liveLp, is still in the bucket.
export function markedLender(
  lp: BigInt,
  liveLp: BigInt,
  liveWorth: BigInt,
  fundedWorth: BigInt,
  depositTime: BigInt
): LenderState {
  const lender = new LenderState()
  lender.lp = lp
  lender.marked = true
  lender.liveLp = liveLp
  lender.liveWorth = liveWorth
  lender.fundedWorth = fundedWorth
  lender.depositTime = depositTime
  return lender
}

export function mockLender(
  poolInfoUtils: Address,
  pool: Address,
  index: i32,
  lender: Address,
  state: LenderState
): void {
  createMockedFunction(poolInfoUtils, "lenderPosition", LENDER_POSITION_SIGNATURE)
    .withArgs([ethereum.Value.fromAddress(pool), indexValue(index), ethereum.Value.fromAddress(lender)])
    .returns([
      uintValue(state.lp),
      ethereum.Value.fromBoolean(state.marked),
      uintValue(state.liveLp),
      uintValue(state.liveWorth),
      uintValue(state.fundedWorth)
    ])

  createMockedFunction(pool, "lenderInfo", "lenderInfo(uint256,address):(uint256,uint256)")
    .withArgs([indexValue(index), ethereum.Value.fromAddress(lender)])
    .returns([uintValue(state.lp), uintValue(state.depositTime)])
}

/*************/
/*** Loans ***/
/*************/

// What the pool's loanDetails returns for a live loan. Values other than the index and expiry are WADs.
export class LoanState {
  t0Debt: BigInt = ZERO_BI
  collateral: BigInt = ZERO_BI
  t0Tp: BigInt = ZERO_BI
  bucketIndex: i32 = 0
  expiry: BigInt = ZERO_BI
  inflatorAtDraw: BigInt = ONE_WAD_BI
}

const LOAN_DETAILS_SIGNATURE = "loanDetails(bytes32):(address,uint256,uint256,uint256,uint256,uint256,uint256)"

export function mockLoan(pool: Address, loanId: Bytes, borrower: Address, state: LoanState): void {
  createMockedFunction(pool, "loanDetails", LOAN_DETAILS_SIGNATURE)
    .withArgs([ethereum.Value.fromFixedBytes(loanId)])
    .returns([
      ethereum.Value.fromAddress(borrower),
      uintValue(state.t0Debt),
      uintValue(state.collateral),
      uintValue(state.t0Tp),
      indexValue(state.bucketIndex),
      uintValue(state.expiry),
      uintValue(state.inflatorAtDraw)
    ])
}

// a loan left with neither debt nor collateral is deleted, and reads as zeros
export function mockDeletedLoan(pool: Address, loanId: Bytes): void {
  mockLoan(pool, loanId, Address.zero(), new LoanState())
}
