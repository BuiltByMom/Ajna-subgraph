import { BigDecimal, BigInt } from "@graphprotocol/graph-ts"

export const ZERO_BI = BigInt.zero()
export const ONE_BI = BigInt.fromI32(1)
export const TEN_BI = BigInt.fromI32(10)
export const HALF_WAD_BI = BigInt.fromString("500000000000000000")
export const ONE_WAD_BI = BigInt.fromString("1000000000000000000")

export const ZERO_BD = BigDecimal.zero()
export const EXP_18_BD = BigDecimal.fromString("1000000000000000000")

// Lenders earn 96% of the interest borrowers pay. The other 4% is the pool's surplus
// (PoolCommons.NET_INTEREST_MARGIN); the contracts no longer expose it through a reader.
export const LENDER_INTEREST_SHARE_BI = BigInt.fromString("960000000000000000")
