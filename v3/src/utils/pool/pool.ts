import { Address, BigDecimal, BigInt, ethereum, log } from "@graphprotocol/graph-ts"

import { Pool } from "../../../generated/schema"
import { ERC20Pool } from "../../../generated/templates/ERC20Pool/ERC20Pool"
import { PoolInfoUtilsMulticall } from "../../../generated/templates/ERC20Pool/PoolInfoUtilsMulticall"

import { LENDER_INTEREST_SHARE_BI, ONE_BI, ZERO_BD, ZERO_BI } from "../constants"
import { wadToDecimal } from "../convert"
import { poolDeployment } from "../deployments"
import { wmul } from "../math"
import { incrementTokenTxCounts } from "../token-erc20"

// A new pool with nothing read from chain yet. The caller sets its factory, tokens and creation
// block, then calls updatePool.
export function createPool(poolAddress: Address): Pool {
  const pool = new Pool(poolAddress)
  pool.txCount = ZERO_BI

  pool.poolSize = ZERO_BD
  pool.debt = ZERO_BD
  pool.t0debt = ZERO_BD
  pool.inflator = ZERO_BD
  pool.loansCount = ZERO_BI

  pool.borrowRate = ZERO_BD
  pool.rateAtTarget = ZERO_BD
  pool.utilization = ZERO_BD
  pool.lendRate = ZERO_BD

  pool.quoteTokenBalance = ZERO_BD
  pool.collateralBalance = ZERO_BD
  pool.escrowedQuote = ZERO_BD
  pool.availableQuote = ZERO_BD
  pool.pledgedCollateral = ZERO_BD
  pool.lenderCollateral = ZERO_BD

  pool.quoteSurplus = ZERO_BD
  pool.quoteSurplusClaimable = ZERO_BD
  pool.quoteSurplusLotRemaining = ZERO_BD
  pool.collateralSurplus = ZERO_BD
  pool.collateralSurplusClaimable = ZERO_BD
  pool.collateralSurplusLotRemaining = ZERO_BD

  pool.totalAjnaBurned = ZERO_BD
  pool.quoteTokenFlashloaned = ZERO_BD
  pool.collateralFlashloaned = ZERO_BD
  pool.interestUpdateFailures = ZERO_BI

  pool.updatedAtBlockNumber = ZERO_BI
  pool.updatedAtTimestamp = ZERO_BI
  return pool
}

export function loadPool(poolAddress: Address): Pool {
  const pool = Pool.load(poolAddress)
  if (pool == null) {
    // a pool data source is only started after its Pool is saved
    log.critical("loadPool: no Pool entity for {}", [poolAddress.toHexString()])
  }
  return pool!
}

// The annual rate lenders earn on average across the pool: their share of the interest paid on
// the part of the deposits that is lent. Both arguments and the lenders' share are WADs.
export function lendRate(borrowRate: BigInt, utilization: BigInt): BigDecimal {
  return wadToDecimal(wmul(wmul(borrowRate, LENDER_INTEREST_SHARE_BI), utilization))
}

function logUnreadable(pool: Pool, block: ethereum.Block): void {
  log.warning("updatePool: could not read pool {} at block {}; keeping its state from block {}", [
    pool.id.toHexString(),
    block.number.toString(),
    pool.updatedAtBlockNumber.toString()
  ])
}

// Refreshes the fields of the pool that are read from chain. The caller saves it.
//
// A contract call made while handling an event reads state as of the end of that event's block,
// so every event of a block sees the same values and one read per block is enough.
//
// The readers project interest to the current block. Where the pool's own accrual failed
// (InterestUpdateFailure), that projection can revert as well; the pool then keeps the state it
// had, apart from its t0 debt, and updatedAtBlockNumber shows that it was not refreshed.
export function updatePool(pool: Pool, block: ethereum.Block): void {
  if (pool.updatedAtBlockNumber.equals(block.number)) return

  const poolAddress = Address.fromBytes(pool.id)

  // Read first, and whether or not the readers below can be: it is a stored value, so this call
  // cannot revert, and the pool's t0 debt keeps matching its loans' while the rest is unreadable.
  pool.t0debt = wadToDecimal(ERC20Pool.bind(poolAddress).totalT0Debt())

  const multicall = PoolInfoUtilsMulticall.bind(poolDeployment(pool).poolInfoUtilsMulticall)
  const detailsCall = multicall.try_poolDetailsMulticall(poolAddress)
  if (detailsCall.reverted) {
    logUnreadable(pool, block)
    return
  }
  const balancesCall = multicall.try_poolBalanceDetails(poolAddress)
  if (balancesCall.reverted) {
    logUnreadable(pool, block)
    return
  }

  const loansInfo = detailsCall.value.getPoolLoansInfo_()
  pool.poolSize = wadToDecimal(loansInfo.poolSize)
  pool.inflator = wadToDecimal(loansInfo.pendingInflator)

  const rates = detailsCall.value.getPoolRatesAndFees_()
  pool.borrowRate = wadToDecimal(rates.interestRate)
  pool.rateAtTarget = wadToDecimal(rates.rateAtTarget)
  pool.utilization = wadToDecimal(rates.utilization)
  pool.lendRate = lendRate(rates.interestRate, rates.utilization)

  const quoteSurplus = detailsCall.value.getQuoteSurplusInfo_()
  pool.quoteSurplus = wadToDecimal(quoteSurplus.surplus)
  pool.quoteSurplusClaimable = wadToDecimal(quoteSurplus.claimableSurplus)
  pool.quoteSurplusLotRemaining = wadToDecimal(quoteSurplus.lotRemaining)

  const collateralSurplus = detailsCall.value.getCollateralSurplusInfo_()
  pool.collateralSurplus = wadToDecimal(collateralSurplus.surplus)
  pool.collateralSurplusClaimable = wadToDecimal(collateralSurplus.claimableSurplus)
  pool.collateralSurplusLotRemaining = wadToDecimal(collateralSurplus.lotRemaining)

  const balances = balancesCall.value
  pool.debt = wadToDecimal(balances.debt)
  pool.quoteTokenBalance = wadToDecimal(balances.quoteTokenBalance)
  pool.collateralBalance = wadToDecimal(balances.collateralTokenBalance)
  pool.escrowedQuote = wadToDecimal(balances.escrowedQuote)
  pool.availableQuote = wadToDecimal(balances.availableQuote)

  pool.updatedAtBlockNumber = block.number
  pool.updatedAtTimestamp = block.timestamp
}

// Counts one action against the pool and both of its tokens. One call to the pool is one action,
// whatever number of events it emits. The caller saves the pool.
export function countPoolAction(pool: Pool): void {
  pool.txCount = pool.txCount.plus(ONE_BI)
  incrementTokenTxCounts(pool)
}
