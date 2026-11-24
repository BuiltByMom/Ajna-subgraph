import { Address } from "@graphprotocol/graph-ts"

import { ERC20 } from "../../generated/ERC20PoolFactory/ERC20"
import { ERC20Bytes32 } from "../../generated/ERC20PoolFactory/ERC20Bytes32"
import { Pool, Token } from "../../generated/schema"

import { ONE_BI, ZERO_BI } from "./constants"

const UNKNOWN = "unknown"

// Some tokens return name and symbol as bytes32 instead of string, which fails to decode as a
// string and reads as a reverted call.

function getTokenName(tokenAddress: Address): string {
  const nameCall = ERC20.bind(tokenAddress).try_name()
  if (!nameCall.reverted) return nameCall.value

  const bytes32NameCall = ERC20Bytes32.bind(tokenAddress).try_name()
  return bytes32NameCall.reverted ? UNKNOWN : bytes32NameCall.value.toString()
}

function getTokenSymbol(tokenAddress: Address): string {
  const symbolCall = ERC20.bind(tokenAddress).try_symbol()
  if (!symbolCall.reverted) return symbolCall.value

  const bytes32SymbolCall = ERC20Bytes32.bind(tokenAddress).try_symbol()
  return bytes32SymbolCall.reverted ? UNKNOWN : bytes32SymbolCall.value.toString()
}

// The factory only deploys pools for tokens that report at most 18 decimals, so the fallback is
// not expected to be used.
function getTokenDecimals(tokenAddress: Address): i32 {
  const decimalsCall = ERC20.bind(tokenAddress).try_decimals()
  return decimalsCall.reverted ? 18 : decimalsCall.value
}

// Only callable from the pool factory data source, the one whose manifest entry lists the token ABIs.
export function loadOrCreateToken(tokenAddress: Address): Token {
  let token = Token.load(tokenAddress)
  if (token == null) {
    token = new Token(tokenAddress)
    token.name = getTokenName(tokenAddress)
    token.symbol = getTokenSymbol(tokenAddress)
    token.decimals = getTokenDecimals(tokenAddress)
    token.poolCount = ZERO_BI
    token.txCount = ZERO_BI
  }
  return token
}

function incrementTxCount(tokenId: Address): void {
  const token = Token.load(tokenId)
  if (token != null) {
    token.txCount = token.txCount.plus(ONE_BI)
    token.save()
  }
}

// counts one pool action against both of the pool's tokens
export function incrementTokenTxCounts(pool: Pool): void {
  incrementTxCount(Address.fromBytes(pool.collateralToken))
  incrementTxCount(Address.fromBytes(pool.quoteToken))
}
