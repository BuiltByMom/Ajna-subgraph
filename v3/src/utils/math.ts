import { BigInt } from "@graphprotocol/graph-ts"

import { HALF_WAD_BI, ONE_WAD_BI } from "./constants"

// multiply two WADs and return a BigInt in WAD precision
export function wmul(lhs: BigInt, rhs: BigInt): BigInt {
  return lhs.times(rhs).plus(HALF_WAD_BI).div(ONE_WAD_BI)
}
