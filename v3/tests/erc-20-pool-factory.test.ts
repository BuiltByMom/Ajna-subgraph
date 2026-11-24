import { afterEach, assert, clearStore, describe, test } from "matchstick-as/assembly/index"
import { BigInt } from "@graphprotocol/graph-ts"

import { handlePoolCreated } from "../src/mappings/erc-20-pool-factory"
import { allDeployments } from "../src/utils/deployments"
import { THIRTY_DAYS, blockTimestamp, eventEntityId, testAddress } from "./utils/common"
import { createPool, createPoolCreatedEvent } from "./utils/erc-20-pool-factory-utils"
import {
  PoolSnapshot,
  mockLoanTerm,
  mockPoolSnapshot,
  mockPoolSnapshotReverts,
  mockTokenBytes32Info,
  mockTokenBytes32InfoReverts,
  mockTokenDecimals,
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
    mockTokenInfo(COLLATERAL, "Collateral Token", "COLL", 18)
    mockTokenInfo(QUOTE, "Quote Token", "QUOTE", 6)
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
      mockTokenInfo(COLLATERAL, "Collateral Token", "COLL", 18)
      mockTokenInfo(QUOTE, "Quote Token", "QUOTE", 18)
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
    mockTokenInfo(otherCollateral, "Other Collateral", "OTHER", 8)
    createPool(deployment, testAddress(0x3000), COLLATERAL, QUOTE, newPoolSnapshot(), CREATED_AT)

    // createPool mocks 18-decimal tokens, so create the second pool directly
    const secondPool = testAddress(0x3001)
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
  })

  test("reads a token name and symbol stored as bytes32", () => {
    const deployment = allDeployments()[0]
    const bytes32Token = testAddress(0x7003)
    const pool = testAddress(0x4000)
    mockLoanTerm(deployment.factory, THIRTY_DAYS)
    mockTokenStringsRevert(bytes32Token)
    mockTokenBytes32Info(bytes32Token, "Maker", "MKR")
    mockTokenDecimals(bytes32Token, 18)
    mockTokenInfo(QUOTE, "Quote Token", "QUOTE", 18)
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
    mockTokenDecimals(namelessToken, 18)
    mockTokenInfo(QUOTE, "Quote Token", "QUOTE", 18)
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
    mockTokenInfo(COLLATERAL, "Collateral Token", "COLL", 18)
    mockTokenInfo(QUOTE, "Quote Token", "QUOTE", 18)
    mockPoolSnapshotReverts(deployment.poolInfoUtilsMulticall, pool)

    handlePoolCreated(createPoolCreatedEvent(deployment.factory, pool, COLLATERAL, QUOTE, CREATED_AT, 0))

    assert.fieldEquals("Pool", pool.toHexString(), "borrowRate", "0")
    // zero marks a pool that has never been read
    assert.fieldEquals("Pool", pool.toHexString(), "updatedAtBlockNumber", "0")
    assert.dataSourceExists("ERC20Pool", pool.toHexString())
  })

  // A PoolCreated from a factory that is not configured ends in log.critical, which Matchstick
  // turns into a panic of the whole test run, so that path has no test here. The lookup it depends
  // on is covered in deployments.test.ts.
})
