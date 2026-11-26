import {
  assert,
  describe,
  test,
  clearStore,
  createMockedFunction,
  beforeAll,
  afterAll
} from "matchstick-as/assembly/index"
import { Address, BigInt, Bytes, dataSource, ethereum } from "@graphprotocol/graph-ts"

import { FIVE_PERCENT_BI, MAX_PRICE, ONE_BI, ZERO_BI } from "../src/utils/constants"
import { create721Pool } from "./utils/common"

// Tests structure (matchstick-as >=0.5.0)
// https://thegraph.com/docs/en/developer/matchstick/#tests-structure-0-5-0

describe("ERC721PoolFactory assertions", () => {
  beforeAll(() => {
    const pool_ = Address.fromString("0x0000000000000000000000000000000000000001")
    const expectedCollateralToken = Address.fromString("0xC9bCeeEA5288b2BE0b777F4F388F125F55aB5a81")
    const expectedQuoteToken      = Address.fromString("0x10aA0Cf12AAb305bd77AD8F76c037E048B12513B")
    const expectedInitialInterestRate = FIVE_PERCENT_BI
    const expectedInitialFeeRate = ZERO_BI

    // TODO: deploy subset pool as well, this calldata is just for a collection pool
    const calldata = Bytes.fromHexString("0xb038d2e1000000000000000000000000c9bceeea5288b2be0b777f4f388f125f55ab5a8100000000000000000000000010aa0cf12aab305bd77ad8f76c037e048b12513b000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000b1a2bc2ec500000000000000000000000000000000000000000000000000000000000000000000")
    create721Pool(pool_, expectedCollateralToken, expectedQuoteToken, expectedInitialInterestRate, expectedInitialFeeRate, calldata)
  })

  afterAll(() => {
    clearStore()
  })

  // For more test scenarios, see:
  // https://thegraph.com/docs/en/developer/matchstick/#write-a-unit-test

  test("PoolCreated created and stored", () => {
    assert.entityCount("PoolCreated", 1)

    // 0xa16081f360e3847006db660bae1c6d1b2e17ec2a01000000 is the default address used in newMockEvent() function
    assert.fieldEquals(
      "PoolCreated",
      "0xa16081f360e3847006db660bae1c6d1b2e17ec2a01000000",
      "pool",
      "0x0000000000000000000000000000000000000001"
    )

    // More assert options:
    // https://thegraph.com/docs/en/developer/matchstick/#asserts
  })

  test("Factory entity attributes", () => {
    assert.entityCount("PoolFactory", 1)

    const erc721factoryAddress = Address.fromString("0x0000000000000000000000000000000000002020")
    assert.fieldEquals(
      "PoolFactory",
      erc721factoryAddress.toHexString(),
      "poolType",
      "ERC721"
    )
    assert.fieldEquals(
      "PoolFactory",
      erc721factoryAddress.toHexString(),
      "poolCount",
      `${ONE_BI}`
    )
    assert.fieldEquals(
      "PoolFactory",
      erc721factoryAddress.toHexString(),
      "txCount",
      `${ONE_BI}`
    )
  })

  test("Pool entity attributes", () => {
    const expectedCollateralToken = Address.fromString("0xC9bCeeEA5288b2BE0b777F4F388F125F55aB5a81")
    const expectedQuoteToken      = Address.fromString("0x10aA0Cf12AAb305bd77AD8F76c037E048B12513B")

    assert.entityCount("Pool", 1)

    assert.fieldEquals(
      "Pool",
      "0x0000000000000000000000000000000000000001",
      "collateralToken",
      `${expectedCollateralToken.toHexString()}`
    )
    assert.fieldEquals(
      "Pool",
      "0x0000000000000000000000000000000000000001",
      "quoteToken",
      `${expectedQuoteToken.toHexString()}`
    )
    assert.fieldEquals(
      "Pool",
      "0x0000000000000000000000000000000000000001",
      "poolType",
      "Collection"
    )
    assert.fieldEquals(
      "Pool",
      "0x0000000000000000000000000000000000000001",
      "tokenIdsAllowed",
      "[]"
    )
    assert.fieldEquals(
      "Pool",
      "0x0000000000000000000000000000000000000001",
      "lup",
      `${MAX_PRICE}`
    )
    assert.fieldEquals(
      "Pool",
      "0x0000000000000000000000000000000000000001",
      "t0debt",
      `${ZERO_BI}`
    )
    assert.fieldEquals(
      "Pool",
      "0x0000000000000000000000000000000000000001",
      "reserves",
      `${ZERO_BI}`
    )
    assert.fieldEquals(
      "Pool",
      "0x0000000000000000000000000000000000000001",
      "txCount",
      `${ZERO_BI}`
    )
  })

  test("Token entity attributes", () => {
    const expectedCollateralToken = Address.fromString("0xC9bCeeEA5288b2BE0b777F4F388F125F55aB5a81")
    const expectedQuoteToken      = Address.fromString("0x10aA0Cf12AAb305bd77AD8F76c037E048B12513B")

    assert.entityCount("Token", 2)

    assert.fieldEquals(
      "Token",
      `${expectedQuoteToken.toHexString()}`,
      "name",
      "quote"
    )
    assert.fieldEquals(
      "Token",
      `${expectedQuoteToken.toHexString()}`,
      "symbol",
      "Q"
    )
    assert.fieldEquals(
      "Token",
      `${expectedCollateralToken.toHexString()}`,
      "name",
      "collateral"
    )
    assert.fieldEquals(
      "Token",
      `${expectedCollateralToken.toHexString()}`,
      "symbol",
      "C"
    )
  })

})

// AssemblyScript has no closures, so what the subset pool's hooks and tests share is declared here
const SUBSET_POOL = Address.fromString("0x0000000000000000000000000000000000000002")
// the address create721Pool gives the factory
const SUBSET_POOL_FACTORY = Address.fromString("0x0000000000000000000000000000000000002020")
const SUBSET_HASH = Bytes.fromHexString("0x2263c4378b4920f0bef611a3ff22c506afa4745b3319c50b6d704a874990b8b2")

describe("ERC721PoolFactory subset pool assertions", () => {
  beforeAll(() => {
    const collateralToken = Address.fromString("0xC9bCeeEA5288b2BE0b777F4F388F125F55aB5a81")
    const quoteToken      = Address.fromString("0x10aA0Cf12AAb305bd77AD8F76c037E048B12513B")

    // the factory hashes the token ids the handler decoded
    createMockedFunction(SUBSET_POOL_FACTORY, 'getNFTSubsetHash', 'getNFTSubsetHash(uint256[]):(bytes32)')
      .withArgs([ethereum.Value.fromUnsignedBigIntArray([BigInt.fromI32(1), BigInt.fromI32(26), BigInt.fromI32(300)])])
      .returns([ethereum.Value.fromFixedBytes(SUBSET_HASH)])

    // deployPool(collateral, quote, [1, 26, 300], 0.05 * 1e18)
    const calldata = Bytes.fromHexString(
      "0xb038d2e1" +
      "000000000000000000000000c9bceeea5288b2be0b777f4f388f125f55ab5a81" +
      "00000000000000000000000010aa0cf12aab305bd77ad8f76c037e048b12513b" +
      "0000000000000000000000000000000000000000000000000000000000000080" +
      "00000000000000000000000000000000000000000000000000b1a2bc2ec50000" +
      "0000000000000000000000000000000000000000000000000000000000000003" +
      "0000000000000000000000000000000000000000000000000000000000000001" +
      "000000000000000000000000000000000000000000000000000000000000001a" +
      "000000000000000000000000000000000000000000000000000000000000012c"
    )
    create721Pool(SUBSET_POOL, collateralToken, quoteToken, FIVE_PERCENT_BI, ZERO_BI, calldata, true)
  })

  afterAll(() => {
    clearStore()
  })

  test("Pool records the token ids in the calldata", () => {
    assert.entityCount("Pool", 1)

    assert.fieldEquals("Pool", SUBSET_POOL.toHexString(), "poolType", "Subset")
    assert.fieldEquals("Pool", SUBSET_POOL.toHexString(), "tokenIdsAllowed", "[1, 26, 300]")
    assert.fieldEquals("Pool", SUBSET_POOL.toHexString(), "subsetHash", SUBSET_HASH.toHexString())
  })
})
