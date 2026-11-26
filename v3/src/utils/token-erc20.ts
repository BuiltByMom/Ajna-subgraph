import { Address, BigInt } from "@graphprotocol/graph-ts"

import { ERC20 } from "../../generated/ERC20PoolFactory/ERC20"
import { ERC20Bytes32 } from "../../generated/ERC20PoolFactory/ERC20Bytes32"
import { Pool, Token } from "../../generated/schema"
import { ERC20Pool } from "../../generated/templates/ERC20Pool/ERC20Pool"

import { ONE_BI, TEN_BI, ZERO_BI } from "./constants"

// Anyone can deploy a pool for any token, so a token is a contract that may answer anything. What
// it says is kept only as text, and cut to a length that is safe to store and to serve. Nothing
// here converts a number a token reports: a conversion that does not fit aborts the handler, and
// an aborted handler stops the whole subgraph.

const UNKNOWN = "unknown"

// the longest name or symbol kept, in UTF-16 code units
export const MAX_TOKEN_TEXT_LENGTH = 128

const HIGH_SURROGATE_FIRST = 0xd800
const HIGH_SURROGATE_LAST = 0xdbff

// A token can return megabytes of text, which would be stored and then served with every pool
// that names it.
export function clipTokenText(text: string): string {
  if (text.length <= MAX_TOKEN_TEXT_LENGTH) return text

  let end = MAX_TOKEN_TEXT_LENGTH
  // A character outside the basic plane takes two code units. Half of one is not text, and the
  // store refuses it.
  const last = text.charCodeAt(end - 1)
  if (last >= HIGH_SURROGATE_FIRST && last <= HIGH_SURROGATE_LAST) end -= 1
  return text.slice(0, end)
}

// Some tokens return name and symbol as bytes32 instead of string, which fails to decode as a
// string and reads as a reverted call.

function getTokenName(tokenAddress: Address): string {
  const nameCall = ERC20.bind(tokenAddress).try_name()
  if (!nameCall.reverted) return clipTokenText(nameCall.value)

  const bytes32NameCall = ERC20Bytes32.bind(tokenAddress).try_name()
  return bytes32NameCall.reverted ? UNKNOWN : clipTokenText(bytes32NameCall.value.toString())
}

function getTokenSymbol(tokenAddress: Address): string {
  const symbolCall = ERC20.bind(tokenAddress).try_symbol()
  if (!symbolCall.reverted) return clipTokenText(symbolCall.value)

  const bytes32SymbolCall = ERC20Bytes32.bind(tokenAddress).try_symbol()
  return bytes32SymbolCall.reverted ? UNKNOWN : clipTokenText(bytes32SymbolCall.value.toString())
}

// The decimals a token had when the factory deployed a pool for it, from the scale the pool keeps
// for that token: 10^(18 - decimals). The factory accepts no token that reports more than 18.
export function decimalsOfScale(scale: BigInt): i32 {
  let decimals = 18
  let remaining = scale
  while (decimals > 0 && remaining.gt(ONE_BI)) {
    remaining = remaining.div(TEN_BI)
    decimals -= 1
  }
  return decimals
}

// The token is not asked for its decimals. It was asked once, by the factory, and the pool works
// with that answer for good; a token asked again can say something else, including a number too
// large to convert. The pool's scale is a constant of its deployment and its read cannot revert.
function getTokenDecimals(poolAddress: Address, isQuoteToken: boolean): i32 {
  const pool = ERC20Pool.bind(poolAddress)
  return decimalsOfScale(isQuoteToken ? pool.quoteTokenScale() : pool.collateralScale())
}

// The token of a pool that has just been deployed, created from that pool if this is the first
// pool to use it. A token that reported different decimals to two factories' calls keeps those of
// its first pool.
//
// Only callable from the pool factory data source, the one whose manifest entry lists the token ABIs.
export function loadOrCreateToken(tokenAddress: Address, poolAddress: Address, isQuoteToken: boolean): Token {
  let token = Token.load(tokenAddress)
  if (token == null) {
    token = new Token(tokenAddress)
    token.name = getTokenName(tokenAddress)
    token.symbol = getTokenSymbol(tokenAddress)
    token.decimals = getTokenDecimals(poolAddress, isQuoteToken)
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
