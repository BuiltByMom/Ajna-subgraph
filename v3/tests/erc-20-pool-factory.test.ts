import { afterEach, assert, clearStore, describe, test } from "matchstick-as/assembly/index"
import { BigInt } from "@graphprotocol/graph-ts"

import { handlePoolCreated } from "../src/mappings/erc-20-pool-factory"
import { allDeployments } from "../src/utils/deployments"
import { MAX_TOKEN_TEXT_LENGTH, clipTokenText, decimalsOfScale } from "../src/utils/token-erc20"
import { THIRTY_DAYS, blockTimestamp, eventEntityId, testAddress } from "./utils/common"
import { createPool, createPoolCreatedEvent } from "./utils/erc-20-pool-factory-utils"
import {
  PoolSnapshot,
  mockLoanTerm,
  mockPoolScales,
  mockPoolSnapshot,
  mockPoolSnapshotReverts,
  mockPoolT0Debt,
  mockTokenBytes32Info,
  mockTokenBytes32InfoReverts,
  mockTokenDecimalsOutOfRange,
  mockTokenInfo,
  mockTokenStringsRevert
} from "./utils/mock-contract-calls"

// These tests run against whichever config `yarn configure` last rendered. Tests of one pool use
// its first deployment; the test of several factories covers every deployment in it. CI runs
// them with tests/fixtures/two-factories.json.

const COLLATERAL = testAddress(0x7000)
const QUOTE = testAddress(0x7001)
const CREATED_AT = 100

// a pool as it is at deployment: no deposits yet, and a starting borrow rate
function newPoolSnapshot(): PoolSnapshot {
  const snapshot = new PoolSnapshot()
  snapshot.borrowRate = BigInt.fromString("50000000000000000") // 0.05
  snapshot.rateAtTarget = BigInt.fromString("200000000000000000") // 0.2
  return snapshot
}

describe("handlePoolCreated", () => {
  afterEach(() => {
    clearStore()
  })

  test("creates the pool with its factory and tokens, and starts indexing it", () => {
    const deployment = allDeployments()[0]
    const pool = testAddress(0x1000)
    mockLoanTerm(deployment.factory, THIRTY_DAYS)
    mockTokenInfo(COLLATERAL, "Collateral Token", "COLL")
    mockTokenInfo(QUOTE, "Quote Token", "QUOTE")
    mockPoolScales(pool, 18, 6)
    mockPoolSnapshot(deployment.poolInfoUtilsMulticall, pool, newPoolSnapshot())

    const event = createPoolCreatedEvent(deployment.factory, pool, COLLATERAL, QUOTE, CREATED_AT, 7)
    handlePoolCreated(event)

    const factoryId = deployment.factory.toHexString()
    assert.fieldEquals("PoolFactory", factoryId, "loanTerm", "2592000")
    assert.fieldEquals("PoolFactory", factoryId, "poolCount", "1")

    const collateralId = COLLATERAL.toHexString()
    assert.fieldEquals("Token", collateralId, "name", "Collateral Token")
    assert.fieldEquals("Token", collateralId, "symbol", "COLL")
    assert.fieldEquals("Token", collateralId, "decimals", "18")
    assert.fieldEquals("Token", collateralId, "poolCount", "1")
    assert.fieldEquals("Token", collateralId, "txCount", "0")
    assert.fieldEquals("Token", QUOTE.toHexString(), "symbol", "QUOTE")
    assert.fieldEquals("Token", QUOTE.toHexString(), "decimals", "6")

    const poolId = pool.toHexString()
    assert.fieldEquals("Pool", poolId, "factory", factoryId)
    assert.fieldEquals("Pool", poolId, "loanTerm", "2592000")
    assert.fieldEquals("Pool", poolId, "collateralToken", collateralId)
    assert.fieldEquals("Pool", poolId, "quoteToken", QUOTE.toHexString())
    assert.fieldEquals("Pool", poolId, "createdAtBlockNumber", "100")
    assert.fieldEquals("Pool", poolId, "createdAtTimestamp", blockTimestamp(CREATED_AT).toString())
    assert.fieldEquals("Pool", poolId, "txCount", "0")
    assert.fieldEquals("Pool", poolId, "poolSize", "0")
    assert.fieldEquals("Pool", poolId, "inflator", "1")
    assert.fieldEquals("Pool", poolId, "borrowRate", "0.05")
    assert.fieldEquals("Pool", poolId, "rateAtTarget", "0.2")
    assert.fieldEquals("Pool", poolId, "lendRate", "0")
    assert.fieldEquals("Pool", poolId, "interestUpdateFailures", "0")
    assert.fieldEquals("Pool", poolId, "updatedAtBlockNumber", "100")

    const poolCreatedId = eventEntityId(event)
    assert.fieldEquals("PoolCreated", poolCreatedId, "pool", poolId)
    assert.fieldEquals("PoolCreated", poolCreatedId, "factory", factoryId)
    assert.fieldEquals("PoolCreated", poolCreatedId, "collateralToken", collateralId)
    assert.fieldEquals("PoolCreated", poolCreatedId, "quoteToken", QUOTE.toHexString())
    assert.fieldEquals("PoolCreated", poolCreatedId, "blockNumber", "100")

    assert.dataSourceExists("ERC20Pool", poolId)
  })

  test("gives each configured factory its own loan term and reads its pools through its own readers", () => {
    const deployments = allDeployments()

    for (let i = 0; i < deployments.length; i++) {
      const deployment = deployments[i]
      const pool = testAddress(0x2000 + i)
      // the same token pair has one pool in each factory
      const snapshot = newPoolSnapshot()
      snapshot.poolSize = BigInt.fromI32(i + 1).times(BigInt.fromString("1000000000000000000"))
      mockLoanTerm(deployment.factory, THIRTY_DAYS.times(BigInt.fromI32(i + 1)))
      mockTokenInfo(COLLATERAL, "Collateral Token", "COLL")
      mockTokenInfo(QUOTE, "Quote Token", "QUOTE")
      mockPoolScales(pool, 18, 18)
      mockPoolSnapshot(deployment.poolInfoUtilsMulticall, pool, snapshot)

      handlePoolCreated(createPoolCreatedEvent(deployment.factory, pool, COLLATERAL, QUOTE, CREATED_AT, i))

      const loanTerm = (2592000 * (i + 1)).toString()
      assert.fieldEquals("PoolFactory", deployment.factory.toHexString(), "loanTerm", loanTerm)
      assert.fieldEquals("PoolFactory", deployment.factory.toHexString(), "poolCount", "1")
      assert.fieldEquals("Pool", pool.toHexString(), "factory", deployment.factory.toHexString())
      assert.fieldEquals("Pool", pool.toHexString(), "loanTerm", loanTerm)
      assert.fieldEquals("Pool", pool.toHexString(), "poolSize", (i + 1).toString())
      assert.dataSourceExists("ERC20Pool", pool.toHexString())
    }

    assert.entityCount("PoolFactory", deployments.length)
    assert.entityCount("Pool", deployments.length)
    assert.fieldEquals("Token", QUOTE.toHexString(), "poolCount", deployments.length.toString())
  })

  test("counts a second pool against the factory and the token the two pools share", () => {
    const deployment = allDeployments()[0]
    const otherCollateral = testAddress(0x7002)
    mockTokenInfo(otherCollateral, "Other Collateral", "OTHER")
    createPool(deployment, testAddress(0x3000), COLLATERAL, QUOTE, newPoolSnapshot(), CREATED_AT)

    // createPool mocks 18-decimal tokens, so create the second pool directly. Its quote scale says
    // 6 decimals, which a token that already has an entity does not take on.
    const secondPool = testAddress(0x3001)
    mockPoolScales(secondPool, 8, 6)
    mockPoolSnapshot(deployment.poolInfoUtilsMulticall, secondPool, newPoolSnapshot())
    handlePoolCreated(
      createPoolCreatedEvent(deployment.factory, secondPool, otherCollateral, QUOTE, CREATED_AT + 1, 0)
    )

    assert.entityCount("PoolFactory", 1)
    assert.fieldEquals("PoolFactory", deployment.factory.toHexString(), "poolCount", "2")
    assert.entityCount("Pool", 2)
    assert.entityCount("Token", 3)
    assert.fieldEquals("Token", QUOTE.toHexString(), "poolCount", "2")
    assert.fieldEquals("Token", COLLATERAL.toHexString(), "poolCount", "1")
    assert.fieldEquals("Token", otherCollateral.toHexString(), "poolCount", "1")
    assert.fieldEquals("Token", otherCollateral.toHexString(), "decimals", "8")
    assert.fieldEquals("Token", QUOTE.toHexString(), "decimals", "18")
  })

  test("reads a token name and symbol stored as bytes32", () => {
    const deployment = allDeployments()[0]
    const bytes32Token = testAddress(0x7003)
    const pool = testAddress(0x4000)
    mockLoanTerm(deployment.factory, THIRTY_DAYS)
    mockTokenStringsRevert(bytes32Token)
    mockTokenBytes32Info(bytes32Token, "Maker", "MKR")
    mockTokenInfo(QUOTE, "Quote Token", "QUOTE")
    mockPoolScales(pool, 18, 18)
    mockPoolSnapshot(deployment.poolInfoUtilsMulticall, pool, newPoolSnapshot())

    handlePoolCreated(createPoolCreatedEvent(deployment.factory, pool, bytes32Token, QUOTE, CREATED_AT, 0))

    assert.fieldEquals("Token", bytes32Token.toHexString(), "name", "Maker")
    assert.fieldEquals("Token", bytes32Token.toHexString(), "symbol", "MKR")
  })

  test("still creates the pool when a token's name and symbol cannot be read", () => {
    const deployment = allDeployments()[0]
    const namelessToken = testAddress(0x7004)
    const pool = testAddress(0x5000)
    mockLoanTerm(deployment.factory, THIRTY_DAYS)
    mockTokenStringsRevert(namelessToken)
    mockTokenBytes32InfoReverts(namelessToken)
    mockTokenInfo(QUOTE, "Quote Token", "QUOTE")
    mockPoolScales(pool, 18, 18)
    mockPoolSnapshot(deployment.poolInfoUtilsMulticall, pool, newPoolSnapshot())

    handlePoolCreated(createPoolCreatedEvent(deployment.factory, pool, namelessToken, QUOTE, CREATED_AT, 0))

    assert.fieldEquals("Token", namelessToken.toHexString(), "name", "unknown")
    assert.fieldEquals("Token", namelessToken.toHexString(), "symbol", "unknown")
    assert.fieldEquals("Pool", pool.toHexString(), "collateralToken", namelessToken.toHexString())
  })

  test("creates the pool unread, and still starts indexing it, when the readers revert", () => {
    const deployment = allDeployments()[0]
    const pool = testAddress(0x6000)
    mockLoanTerm(deployment.factory, THIRTY_DAYS)
    mockTokenInfo(COLLATERAL, "Collateral Token", "COLL")
    mockTokenInfo(QUOTE, "Quote Token", "QUOTE")
    mockPoolScales(pool, 18, 18)
    mockPoolSnapshotReverts(deployment.poolInfoUtilsMulticall, pool)
    mockPoolT0Debt(pool, BigInt.zero())

    handlePoolCreated(createPoolCreatedEvent(deployment.factory, pool, COLLATERAL, QUOTE, CREATED_AT, 0))

    assert.fieldEquals("Pool", pool.toHexString(), "borrowRate", "0")
    // zero marks a pool that has never been read
    assert.fieldEquals("Pool", pool.toHexString(), "updatedAtBlockNumber", "0")
    assert.dataSourceExists("ERC20Pool", pool.toHexString())
  })

  // Anyone can deploy a pool for any token. What such a token answers must never stop the handler:
  // a handler that aborts stops the subgraph for every pool.

  test("takes a token's decimals from the pool, whatever the token itself answers", () => {
    const deployment = allDeployments()[0]
    const liar = testAddress(0x7005)
    const sixDecimals = testAddress(0x7006)
    const pool = testAddress(0x6100)
    mockLoanTerm(deployment.factory, THIRTY_DAYS)
    mockTokenInfo(liar, "Liar", "LIAR")
    mockTokenInfo(sixDecimals, "Six", "SIX")
    // both tokens now answer decimals() with 2^255; the pool was deployed when they said 0 and 6
    mockTokenDecimalsOutOfRange(liar)
    mockTokenDecimalsOutOfRange(sixDecimals)
    mockPoolScales(pool, 0, 6)
    mockPoolSnapshot(deployment.poolInfoUtilsMulticall, pool, newPoolSnapshot())

    handlePoolCreated(createPoolCreatedEvent(deployment.factory, pool, liar, sixDecimals, CREATED_AT, 0))

    assert.fieldEquals("Token", liar.toHexString(), "decimals", "0")
    assert.fieldEquals("Token", sixDecimals.toHexString(), "decimals", "6")
    assert.fieldEquals("Pool", pool.toHexString(), "collateralToken", liar.toHexString())
    assert.dataSourceExists("ERC20Pool", pool.toHexString())
  })

  test("reads every scale the factory can give a pool as its decimals", () => {
    for (let decimals = 0; decimals <= 18; decimals++) {
      const scale = BigInt.fromI32(10).pow(<u8>(18 - decimals))
      assert.i32Equals(decimals, decimalsOfScale(scale))
    }
  })

  test("cuts a token's name and symbol to a length that is safe to keep", () => {
    const deployment = allDeployments()[0]
    const verbose = testAddress(0x7007)
    const pool = testAddress(0x6200)
    mockLoanTerm(deployment.factory, THIRTY_DAYS)
    // a megabyte of name, and a symbol one character over the limit
    mockTokenInfo(verbose, "N".repeat(1000000), "S".repeat(MAX_TOKEN_TEXT_LENGTH + 1))
    mockTokenInfo(QUOTE, "Q".repeat(MAX_TOKEN_TEXT_LENGTH), "QUOTE")
    mockPoolScales(pool, 18, 18)
    mockPoolSnapshot(deployment.poolInfoUtilsMulticall, pool, newPoolSnapshot())

    handlePoolCreated(createPoolCreatedEvent(deployment.factory, pool, verbose, QUOTE, CREATED_AT, 0))

    assert.fieldEquals("Token", verbose.toHexString(), "name", "N".repeat(MAX_TOKEN_TEXT_LENGTH))
    assert.fieldEquals("Token", verbose.toHexString(), "symbol", "S".repeat(MAX_TOKEN_TEXT_LENGTH))
    // text of exactly the limit is kept whole
    assert.fieldEquals("Token", QUOTE.toHexString(), "name", "Q".repeat(MAX_TOKEN_TEXT_LENGTH))
    assert.fieldEquals("Token", QUOTE.toHexString(), "symbol", "QUOTE")
  })

  test("never cuts a character in half", () => {
    // A rocket is two UTF-16 code units. Cut at the limit, the first would be left alone, which is
    // not text and which the store refuses.
    const rocket = "\u{1F680}"
    assert.i32Equals(2, rocket.length)
    assert.stringEquals(
      "A".repeat(MAX_TOKEN_TEXT_LENGTH - 1),
      clipTokenText("A".repeat(MAX_TOKEN_TEXT_LENGTH - 1) + rocket + "B")
    )
    // a rocket that ends exactly at the limit is whole, and stays
    assert.stringEquals(
      "A".repeat(MAX_TOKEN_TEXT_LENGTH - 2) + rocket,
      clipTokenText("A".repeat(MAX_TOKEN_TEXT_LENGTH - 2) + rocket + "B")
    )
    // one that fits is untouched
    assert.stringEquals("A" + rocket, clipTokenText("A" + rocket))
  })

  test("keeps a bytes32 name that fills all 32 bytes", () => {
    const deployment = allDeployments()[0]
    const bytes32Token = testAddress(0x7008)
    const pool = testAddress(0x6300)
    mockLoanTerm(deployment.factory, THIRTY_DAYS)
    mockTokenStringsRevert(bytes32Token)
    mockTokenBytes32Info(bytes32Token, "Thirty-two bytes of name exactly", "MKR")
    mockTokenInfo(QUOTE, "Quote Token", "QUOTE")
    mockPoolScales(pool, 18, 18)
    mockPoolSnapshot(deployment.poolInfoUtilsMulticall, pool, newPoolSnapshot())

    handlePoolCreated(createPoolCreatedEvent(deployment.factory, pool, bytes32Token, QUOTE, CREATED_AT, 0))

    assert.fieldEquals("Token", bytes32Token.toHexString(), "name", "Thirty-two bytes of name exactly")
  })

  // A PoolCreated from a factory that is not configured ends in log.critical, which Matchstick
  // turns into a panic of the whole test run, so that path has no test here. The lookup it depends
  // on is covered in deployments.test.ts.
})
