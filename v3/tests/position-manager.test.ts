import { afterEach, assert, beforeEach, clearStore, describe, test } from "matchstick-as/assembly/index"
import { Address, BigInt } from "@graphprotocol/graph-ts"

import { handleIncreaseLPAllowance, handleTransferLP } from "../src/mappings/erc-20-pool"
import {
  handleApproval,
  handleApprovalForAll,
  handleBurn,
  handleMemorializePosition,
  handleMint,
  handleMoveLiquidity,
  handleRedeemPosition,
  handleTransfer
} from "../src/mappings/position-manager"
import { Deployment, allDeployments } from "../src/utils/deployments"
import { getBucketId } from "../src/utils/pool/bucket"
import { getLendId } from "../src/utils/pool/lend"
import { getPositionId, getPositionLendId } from "../src/utils/position"
import { THIRTY_DAYS, blockTimestamp, eventEntityId, testAddress, wad, wadOf } from "./utils/common"
import { createPool } from "./utils/erc-20-pool-factory-utils"
import { createIncreaseLPAllowanceEvent, createTransferLPEvent } from "./utils/erc-20-pool-utils"
import {
  BucketState,
  LenderState,
  PoolSnapshot,
  mockBucketInfo,
  mockLender,
  mockLoanTerm,
  unmarkedLender
} from "./utils/mock-contract-calls"
import {
  createApprovalEvent,
  createApprovalForAllEvent,
  createBurnEvent,
  createMemorializePositionEvent,
  createMintEvent,
  createMoveLiquidityEvent,
  createRedeemPositionEvent,
  createTransferEvent,
  mockNoPositionInfo,
  mockPositionInfo
} from "./utils/position-manager-utils"

// These tests run against whichever config `yarn configure` last rendered. Tests of one manager
// use its first deployment; the test of several managers covers every deployment in it. CI runs
// them with tests/fixtures/two-factories.json.
//
// Each test calls only the manager's handlers. On chain the pool emits its own event first in a
// call that moves LP (TransferLP, MoveQuoteToken); those handlers have their own tests.
//
// A position's LP is read from the manager once per block, so each step that changes mocked state
// uses a new block number.

const POOL = testAddress(0x1000)
const COLLATERAL = testAddress(0x7000)
const QUOTE = testAddress(0x7001)
const LENDER = testAddress(0x8001)
const OTHER_LENDER = testAddress(0x8002)
const OPERATOR = testAddress(0x8003)
const CREATED_AT = 100
const TOKEN_ID = 7
const INDEX = 2550
const OTHER_INDEX = 2600
const EMPTY_INDEX = 2700

function deployment(): Deployment {
  return allDeployments()[0]
}

function manager(): Address {
  return deployment().positionManager
}

function positionId(positionManager: Address, tokenId: i32): string {
  return getPositionId(positionManager, BigInt.fromI32(tokenId)).toHexString()
}

function positionLendId(positionManager: Address, tokenId: i32, index: i32): string {
  return getPositionLendId(getPositionId(positionManager, BigInt.fromI32(tokenId)), index).toHexString()
}

function bucketId(pool: Address, index: i32): string {
  return getBucketId(pool, index).toHexString()
}

function lendId(index: i32, lender: Address): string {
  return getLendId(getBucketId(POOL, index), lender).toHexString()
}

// what the pool holds for a lender in a bucket of POOL
function mockLenderIn(index: i32, lender: Address, state: LenderState): void {
  mockLender(deployment().poolInfoUtils, POOL, index, lender, state)
}

// a bucket holding only quote, whose LP is worth `exchangeRate` quote each
function mockBucket(index: i32, deposit: BigInt, exchangeRate: BigInt): void {
  const bucket = new BucketState()
  bucket.deposit = deposit
  bucket.lp = deposit
  bucket.exchangeRate = exchangeRate
  mockBucketInfo(deployment().poolInfoUtils, POOL, index, bucket)
}

// what the first manager holds for TOKEN_ID in a bucket
function mockPositionLp(index: i32, lp: BigInt, blockNumber: i32): void {
  mockPositionInfo(manager(), TOKEN_ID, index, lp, blockTimestamp(blockNumber))
}

// a mint emits the NFT's Transfer from the zero address, then Mint
function mint(positionManager: Address, pool: Address, tokenId: i32, lender: Address, blockNumber: i32): void {
  handleTransfer(createTransferEvent(positionManager, blockNumber, 0, Address.zero(), lender, tokenId))
  handleMint(createMintEvent(positionManager, blockNumber, 1, lender, pool, tokenId))
}

// LENDER mints TOKEN_ID at block 101 and memorializes `lp` LP from the bucket at INDEX at block 102
function mintWithLp(lp: BigInt): void {
  mint(manager(), POOL, TOKEN_ID, LENDER, 101)
  mockBucket(INDEX, wad(1000), wad(1))
  mockPositionLp(INDEX, lp, 102)
  handleMemorializePosition(createMemorializePositionEvent(manager(), 102, 1, LENDER, TOKEN_ID, [INDEX]))
}

describe("PositionManager positions", () => {
  beforeEach(() => {
    createPool(deployment(), POOL, COLLATERAL, QUOTE, new PoolSnapshot(), CREATED_AT)
  })

  afterEach(() => {
    clearStore()
  })

  test("Mint creates the position for its pool and owner", () => {
    const transfer = createTransferEvent(manager(), 101, 0, Address.zero(), LENDER, TOKEN_ID)
    handleTransfer(transfer)
    // the pool is not known until Mint, so the Transfer alone creates nothing
    assert.entityCount("Position", 0)

    const event = createMintEvent(manager(), 101, 1, LENDER, POOL, TOKEN_ID)
    handleMint(event)

    const id = positionId(manager(), TOKEN_ID)
    assert.fieldEquals("Position", id, "positionManager", manager().toHexString())
    assert.fieldEquals("Position", id, "tokenId", "7")
    assert.fieldEquals("Position", id, "pool", POOL.toHexString())
    assert.fieldEquals("Position", id, "owner", LENDER.toHexString())
    assert.fieldEquals("Position", id, "account", LENDER.toHexString())
    assert.fieldEquals("Position", id, "createdAtBlockNumber", "101")
    assert.fieldEquals("Position", id, "createdAtTimestamp", blockTimestamp(101).toString())

    assert.fieldEquals("PositionManager", manager().toHexString(), "factory", deployment().factory.toHexString())
    assert.fieldEquals("PositionManager", manager().toHexString(), "positionCount", "1")
    assert.fieldEquals("Account", LENDER.toHexString(), "txCount", "1")
    // minting does not act on the pool
    assert.fieldEquals("Pool", POOL.toHexString(), "txCount", "0")

    const mintId = eventEntityId(event)
    assert.fieldEquals("Mint", mintId, "positionManager", manager().toHexString())
    assert.fieldEquals("Mint", mintId, "tokenId", "7")
    assert.fieldEquals("Mint", mintId, "pool", POOL.toHexString())
    assert.fieldEquals("Mint", mintId, "lender", LENDER.toHexString())
    assert.fieldEquals("Mint", mintId, "blockNumber", "101")
    assert.fieldEquals("Mint", mintId, "transactionHash", event.transaction.hash.toHexString())

    // a mint is recorded as a Mint, not as a Transfer
    assert.entityCount("Transfer", 0)
  })

  test("Transfer between holders changes the owner and leaves the position's LP alone", () => {
    mintWithLp(wad(100))

    const event = createTransferEvent(manager(), 103, 4, LENDER, OTHER_LENDER, TOKEN_ID)
    handleTransfer(event)

    const id = positionId(manager(), TOKEN_ID)
    assert.fieldEquals("Position", id, "owner", OTHER_LENDER.toHexString())
    assert.fieldEquals("Position", id, "account", OTHER_LENDER.toHexString())
    assert.fieldEquals("Position", id, "pool", POOL.toHexString())
    assert.fieldEquals("PositionLend", positionLendId(manager(), TOKEN_ID, INDEX), "lpb", "100")
    assert.fieldEquals("PositionLend", positionLendId(manager(), TOKEN_ID, INDEX), "updatedAtBlockNumber", "102")
    assert.fieldEquals("PositionManager", manager().toHexString(), "positionCount", "1")

    // the new owner has an Account for the position to point at, and has not acted
    assert.fieldEquals("Account", OTHER_LENDER.toHexString(), "txCount", "0")
    assert.fieldEquals("Account", LENDER.toHexString(), "txCount", "2")

    const transferId = eventEntityId(event)
    assert.fieldEquals("Transfer", transferId, "positionManager", manager().toHexString())
    assert.fieldEquals("Transfer", transferId, "tokenId", "7")
    assert.fieldEquals("Transfer", transferId, "pool", POOL.toHexString())
    assert.fieldEquals("Transfer", transferId, "from", LENDER.toHexString())
    assert.fieldEquals("Transfer", transferId, "to", OTHER_LENDER.toHexString())
    assert.entityCount("Transfer", 1)
  })

  test("Burn removes the position, and records who burned it and who owned it", () => {
    mint(manager(), POOL, TOKEN_ID, LENDER, 101)

    // an approved operator burns it: the NFT's Transfer to the zero address, then Burn
    handleTransfer(createTransferEvent(manager(), 102, 0, LENDER, Address.zero(), TOKEN_ID))
    // the Transfer alone leaves the position for Burn to remove
    assert.fieldEquals("Position", positionId(manager(), TOKEN_ID), "owner", LENDER.toHexString())
    const event = createBurnEvent(manager(), 102, 1, OPERATOR, TOKEN_ID)
    handleBurn(event)

    assert.notInStore("Position", positionId(manager(), TOKEN_ID))
    assert.entityCount("Position", 0)
    assert.fieldEquals("PositionManager", manager().toHexString(), "positionCount", "0")
    // the action counts for the owner of the position, whoever performed it
    assert.fieldEquals("Account", LENDER.toHexString(), "txCount", "2")
    assert.notInStore("Account", OPERATOR.toHexString())

    const burnId = eventEntityId(event)
    assert.fieldEquals("Burn", burnId, "positionManager", manager().toHexString())
    assert.fieldEquals("Burn", burnId, "tokenId", "7")
    assert.fieldEquals("Burn", burnId, "pool", POOL.toHexString())
    assert.fieldEquals("Burn", burnId, "lender", OPERATOR.toHexString())
    assert.fieldEquals("Burn", burnId, "owner", LENDER.toHexString())
    assert.entityCount("Transfer", 0)
  })

  test("Approval records who may manage a position", () => {
    mint(manager(), POOL, TOKEN_ID, LENDER, 101)

    const event = createApprovalEvent(manager(), 102, 3, LENDER, OPERATOR, TOKEN_ID)
    handleApproval(event)

    const approvalId = eventEntityId(event)
    assert.fieldEquals("Approval", approvalId, "positionManager", manager().toHexString())
    assert.fieldEquals("Approval", approvalId, "tokenId", "7")
    assert.fieldEquals("Approval", approvalId, "pool", POOL.toHexString())
    assert.fieldEquals("Approval", approvalId, "owner", LENDER.toHexString())
    assert.fieldEquals("Approval", approvalId, "approved", OPERATOR.toHexString())
    assert.fieldEquals("Position", positionId(manager(), TOKEN_ID), "owner", LENDER.toHexString())
  })

  test("ApprovalForAll is recorded before the manager's factory has deployed a pool", () => {
    // nothing has been indexed yet: no pool, and so no PoolFactory
    clearStore()
    mockLoanTerm(deployment().factory, THIRTY_DAYS)

    const event = createApprovalForAllEvent(manager(), 50, 2, LENDER, OPERATOR, true)
    handleApprovalForAll(event)

    const approvalId = eventEntityId(event)
    assert.fieldEquals("ApprovalForAll", approvalId, "positionManager", manager().toHexString())
    assert.fieldEquals("ApprovalForAll", approvalId, "owner", LENDER.toHexString())
    assert.fieldEquals("ApprovalForAll", approvalId, "operator", OPERATOR.toHexString())
    assert.fieldEquals("ApprovalForAll", approvalId, "approved", "true")

    // the manager's entity points at its factory, which is created for it
    assert.fieldEquals("PositionManager", manager().toHexString(), "factory", deployment().factory.toHexString())
    assert.fieldEquals("PositionManager", manager().toHexString(), "positionCount", "0")
    assert.fieldEquals("PoolFactory", deployment().factory.toHexString(), "loanTerm", "2592000")
    assert.fieldEquals("PoolFactory", deployment().factory.toHexString(), "poolCount", "0")

    // the factory's first pool then finds that PoolFactory
    createPool(deployment(), POOL, COLLATERAL, QUOTE, new PoolSnapshot(), CREATED_AT)
    assert.fieldEquals("PoolFactory", deployment().factory.toHexString(), "poolCount", "1")
    assert.entityCount("PoolFactory", 1)

    // taking the approval back is another event
    const revocation = createApprovalForAllEvent(manager(), 101, 0, LENDER, OPERATOR, false)
    handleApprovalForAll(revocation)
    assert.fieldEquals("ApprovalForAll", eventEntityId(revocation), "approved", "false")
    assert.fieldEquals("ApprovalForAll", approvalId, "approved", "true")
    assert.entityCount("ApprovalForAll", 2)
    assert.entityCount("PositionManager", 1)
  })

  test("every PositionManager numbers its own tokens", () => {
    const deployments = allDeployments()

    // token 1 of each configured manager, each in a pool of its own factory and with its own LP
    for (let i = 0; i < deployments.length; i++) {
      const pool = testAddress(0x2000 + i)
      const lender = testAddress(0x9000 + i)
      createPool(deployments[i], pool, COLLATERAL, QUOTE, new PoolSnapshot(), CREATED_AT)
      mint(deployments[i].positionManager, pool, 1, lender, 101)

      const bucket = new BucketState()
      bucket.deposit = wad(1000)
      bucket.lp = wad(1000)
      mockBucketInfo(deployments[i].poolInfoUtils, pool, INDEX, bucket)
      mockPositionInfo(deployments[i].positionManager, 1, INDEX, wad(10 * (i + 1)), blockTimestamp(102))
      handleMemorializePosition(
        createMemorializePositionEvent(deployments[i].positionManager, 102, i, lender, 1, [INDEX])
      )
    }

    assert.entityCount("Position", deployments.length)
    assert.entityCount("PositionLend", deployments.length)
    for (let i = 0; i < deployments.length; i++) {
      const positionManager = deployments[i].positionManager
      const pool = testAddress(0x2000 + i)
      const id = positionId(positionManager, 1)
      assert.fieldEquals("Position", id, "positionManager", positionManager.toHexString())
      assert.fieldEquals("Position", id, "tokenId", "1")
      assert.fieldEquals("Position", id, "pool", pool.toHexString())
      assert.fieldEquals("Position", id, "owner", testAddress(0x9000 + i).toHexString())
      assert.fieldEquals(
        "PositionManager",
        positionManager.toHexString(),
        "factory",
        deployments[i].factory.toHexString()
      )
      assert.fieldEquals("PositionManager", positionManager.toHexString(), "positionCount", "1")

      const lendId = positionLendId(positionManager, 1, INDEX)
      assert.fieldEquals("PositionLend", lendId, "position", id)
      assert.fieldEquals("PositionLend", lendId, "pool", pool.toHexString())
      assert.fieldEquals("PositionLend", lendId, "bucket", bucketId(pool, INDEX))
      assert.fieldEquals("PositionLend", lendId, "lpb", (10 * (i + 1)).toString())
    }

    // emptying and burning the first manager's token 1 leaves every other manager's token 1 alone
    const first = deployments[0].positionManager
    const firstLender = testAddress(0x9000)
    mockNoPositionInfo(first, 1, INDEX)
    handleRedeemPosition(createRedeemPositionEvent(first, 103, 1, firstLender, 1, [INDEX]))
    handleTransfer(createTransferEvent(first, 103, 2, firstLender, Address.zero(), 1))
    handleBurn(createBurnEvent(first, 103, 3, firstLender, 1))

    assert.notInStore("Position", positionId(first, 1))
    assert.notInStore("PositionLend", positionLendId(first, 1, INDEX))
    assert.fieldEquals("PositionManager", first.toHexString(), "positionCount", "0")
    assert.entityCount("Position", deployments.length - 1)
    assert.entityCount("PositionLend", deployments.length - 1)
    for (let i = 1; i < deployments.length; i++) {
      const positionManager = deployments[i].positionManager
      assert.fieldEquals("Position", positionId(positionManager, 1), "tokenId", "1")
      assert.fieldEquals("PositionLend", positionLendId(positionManager, 1, INDEX), "lpb", (10 * (i + 1)).toString())
      assert.fieldEquals("PositionManager", positionManager.toHexString(), "positionCount", "1")
    }
  })
})

describe("PositionManager LP", () => {
  beforeEach(() => {
    createPool(deployment(), POOL, COLLATERAL, QUOTE, new PoolSnapshot(), CREATED_AT)
  })

  afterEach(() => {
    clearStore()
  })

  test("MemorializePosition adds the owner's LP, and skips a bucket where they held none", () => {
    mint(manager(), POOL, TOKEN_ID, LENDER, 101)

    mockBucket(INDEX, wad(1000), wad(1))
    mockBucket(OTHER_INDEX, wad(500), wadOf("1.25"))
    mockPositionLp(INDEX, wad(100), 90)
    mockPositionLp(OTHER_INDEX, wadOf("40.5"), 95)
    // The owner had no LP in the third bucket, which the event lists all the same. Its bucket is
    // not mocked: nothing is read for it.
    mockNoPositionInfo(manager(), TOKEN_ID, EMPTY_INDEX)

    const event = createMemorializePositionEvent(manager(), 102, 5, LENDER, TOKEN_ID, [INDEX, OTHER_INDEX, EMPTY_INDEX])
    handleMemorializePosition(event)

    const id = positionId(manager(), TOKEN_ID)
    const lendId = positionLendId(manager(), TOKEN_ID, INDEX)
    assert.fieldEquals("PositionLend", lendId, "position", id)
    assert.fieldEquals("PositionLend", lendId, "pool", POOL.toHexString())
    assert.fieldEquals("PositionLend", lendId, "bucket", bucketId(POOL, INDEX))
    assert.fieldEquals("PositionLend", lendId, "bucketIndex", "2550")
    assert.fieldEquals("PositionLend", lendId, "lpb", "100")
    assert.fieldEquals("PositionLend", lendId, "lpbValueInQuote", "100")
    // the deposit time is the one the manager took over from the owner, not the time of the event
    assert.fieldEquals("PositionLend", lendId, "depositTime", blockTimestamp(90).toString())
    assert.fieldEquals("PositionLend", lendId, "updatedAtBlockNumber", "102")
    assert.fieldEquals("PositionLend", lendId, "updatedAtTimestamp", blockTimestamp(102).toString())

    const otherLendId = positionLendId(manager(), TOKEN_ID, OTHER_INDEX)
    assert.fieldEquals("PositionLend", otherLendId, "bucket", bucketId(POOL, OTHER_INDEX))
    assert.fieldEquals("PositionLend", otherLendId, "lpb", "40.5")
    assert.fieldEquals("PositionLend", otherLendId, "lpbValueInQuote", "50.625")
    assert.fieldEquals("PositionLend", otherLendId, "depositTime", blockTimestamp(95).toString())

    assert.notInStore("PositionLend", positionLendId(manager(), TOKEN_ID, EMPTY_INDEX))
    assert.entityCount("PositionLend", 2)
    assert.notInStore("Bucket", bucketId(POOL, EMPTY_INDEX))

    const memorializeId = eventEntityId(event)
    assert.fieldEquals("MemorializePosition", memorializeId, "positionManager", manager().toHexString())
    assert.fieldEquals("MemorializePosition", memorializeId, "tokenId", "7")
    assert.fieldEquals("MemorializePosition", memorializeId, "pool", POOL.toHexString())
    assert.fieldEquals("MemorializePosition", memorializeId, "lender", LENDER.toHexString())
    assert.fieldEquals("MemorializePosition", memorializeId, "indexes", "[2550, 2600, 2700]")

    // the mint and the memorialize are the owner's actions; the pool counts its own TransferLP
    assert.fieldEquals("Account", LENDER.toHexString(), "txCount", "2")
    assert.fieldEquals("Pool", POOL.toHexString(), "txCount", "0")
  })

  test("memorializing into a bucket again adds to the position's LP there", () => {
    mintWithLp(wad(100))

    // the owner deposits again and memorializes: the manager now holds 150 LP for the position,
    // under the deposit time of the LP that joined
    mockBucket(INDEX, wad(2000), wadOf("1.1"))
    mockPositionLp(INDEX, wad(150), 103)
    handleMemorializePosition(createMemorializePositionEvent(manager(), 104, 1, LENDER, TOKEN_ID, [INDEX]))

    const lendId = positionLendId(manager(), TOKEN_ID, INDEX)
    assert.fieldEquals("PositionLend", lendId, "lpb", "150")
    assert.fieldEquals("PositionLend", lendId, "lpbValueInQuote", "165")
    assert.fieldEquals("PositionLend", lendId, "depositTime", blockTimestamp(103).toString())
    assert.fieldEquals("PositionLend", lendId, "updatedAtBlockNumber", "104")
    assert.entityCount("PositionLend", 1)
    assert.entityCount("MemorializePosition", 2)
  })

  test("MoveLiquidity can leave LP behind in the bucket it moves from", () => {
    mintWithLp(wad(100))

    // 60 of the position's 100 LP could be moved; the quote behind the other 40 is lent out
    mockBucket(INDEX, wad(940), wad(1))
    mockBucket(OTHER_INDEX, wad(60), wadOf("1.2"))
    mockPositionLp(INDEX, wad(40), 102)
    mockPositionLp(OTHER_INDEX, wad(50), 103)
    const event = createMoveLiquidityEvent(manager(), 103, 6, LENDER, TOKEN_ID, INDEX, OTHER_INDEX, wad(60), wad(50))
    handleMoveLiquidity(event)

    const fromLendId = positionLendId(manager(), TOKEN_ID, INDEX)
    assert.fieldEquals("PositionLend", fromLendId, "lpb", "40")
    assert.fieldEquals("PositionLend", fromLendId, "lpbValueInQuote", "40")
    assert.fieldEquals("PositionLend", fromLendId, "updatedAtBlockNumber", "103")
    const toLendId = positionLendId(manager(), TOKEN_ID, OTHER_INDEX)
    assert.fieldEquals("PositionLend", toLendId, "bucket", bucketId(POOL, OTHER_INDEX))
    assert.fieldEquals("PositionLend", toLendId, "lpb", "50")
    assert.fieldEquals("PositionLend", toLendId, "lpbValueInQuote", "60")
    assert.fieldEquals("PositionLend", toLendId, "depositTime", blockTimestamp(103).toString())
    assert.entityCount("PositionLend", 2)

    const moveId = eventEntityId(event)
    assert.fieldEquals("MoveLiquidity", moveId, "positionManager", manager().toHexString())
    assert.fieldEquals("MoveLiquidity", moveId, "tokenId", "7")
    assert.fieldEquals("MoveLiquidity", moveId, "pool", POOL.toHexString())
    assert.fieldEquals("MoveLiquidity", moveId, "lender", LENDER.toHexString())
    assert.fieldEquals("MoveLiquidity", moveId, "from", bucketId(POOL, INDEX))
    assert.fieldEquals("MoveLiquidity", moveId, "to", bucketId(POOL, OTHER_INDEX))
    assert.fieldEquals("MoveLiquidity", moveId, "fromIndex", "2550")
    assert.fieldEquals("MoveLiquidity", moveId, "toIndex", "2600")
    assert.fieldEquals("MoveLiquidity", moveId, "lpRedeemedFrom", "60")
    assert.fieldEquals("MoveLiquidity", moveId, "lpAwardedTo", "50")
    assert.fieldEquals("Account", LENDER.toHexString(), "txCount", "3")
  })

  test("MoveLiquidity removes the PositionLend of a bucket it empties", () => {
    mintWithLp(wad(100))

    mockBucket(INDEX, wad(900), wad(1))
    mockBucket(OTHER_INDEX, wad(100), wad(1))
    mockNoPositionInfo(manager(), TOKEN_ID, INDEX)
    mockPositionLp(OTHER_INDEX, wad(100), 103)
    handleMoveLiquidity(
      createMoveLiquidityEvent(manager(), 103, 6, LENDER, TOKEN_ID, INDEX, OTHER_INDEX, wad(100), wad(100))
    )

    assert.notInStore("PositionLend", positionLendId(manager(), TOKEN_ID, INDEX))
    assert.fieldEquals("PositionLend", positionLendId(manager(), TOKEN_ID, OTHER_INDEX), "lpb", "100")
    assert.entityCount("PositionLend", 1)
    // the bucket moved from is still what the event points at
    assert.fieldEquals("Bucket", bucketId(POOL, INDEX), "deposit", "900")
  })

  test("RedeemPosition returns the LP of the buckets named and keeps the rest", () => {
    mint(manager(), POOL, TOKEN_ID, LENDER, 101)
    mockBucket(INDEX, wad(1000), wad(1))
    mockBucket(OTHER_INDEX, wad(1000), wad(1))
    mockPositionLp(INDEX, wad(100), 102)
    mockPositionLp(OTHER_INDEX, wad(30), 102)
    handleMemorializePosition(createMemorializePositionEvent(manager(), 102, 1, LENDER, TOKEN_ID, [INDEX, OTHER_INDEX]))
    assert.entityCount("PositionLend", 2)

    mockNoPositionInfo(manager(), TOKEN_ID, INDEX)
    const event = createRedeemPositionEvent(manager(), 103, 9, LENDER, TOKEN_ID, [INDEX])
    handleRedeemPosition(event)

    assert.notInStore("PositionLend", positionLendId(manager(), TOKEN_ID, INDEX))
    assert.fieldEquals("PositionLend", positionLendId(manager(), TOKEN_ID, OTHER_INDEX), "lpb", "30")
    assert.fieldEquals("PositionLend", positionLendId(manager(), TOKEN_ID, OTHER_INDEX), "updatedAtBlockNumber", "102")
    assert.entityCount("PositionLend", 1)
    // the position stays until it is burned
    assert.fieldEquals("Position", positionId(manager(), TOKEN_ID), "owner", LENDER.toHexString())

    const redeemId = eventEntityId(event)
    assert.fieldEquals("RedeemPosition", redeemId, "positionManager", manager().toHexString())
    assert.fieldEquals("RedeemPosition", redeemId, "tokenId", "7")
    assert.fieldEquals("RedeemPosition", redeemId, "pool", POOL.toHexString())
    assert.fieldEquals("RedeemPosition", redeemId, "lender", LENDER.toHexString())
    assert.fieldEquals("RedeemPosition", redeemId, "indexes", "[2550]")
    assert.fieldEquals("Account", LENDER.toHexString(), "txCount", "3")
  })

  test("values LP at the bucket's exchange rate, rounded down to 1e-18", () => {
    mint(manager(), POOL, TOKEN_ID, LENDER, 101)
    mockBucket(INDEX, wad(1000), wadOf("1.5"))
    mockPositionLp(INDEX, wadOf("1.000000000000000001"), 102)
    handleMemorializePosition(createMemorializePositionEvent(manager(), 102, 1, LENDER, TOKEN_ID, [INDEX]))

    const lendId = positionLendId(manager(), TOKEN_ID, INDEX)
    assert.fieldEquals("PositionLend", lendId, "lpb", "1.000000000000000001")
    // 1.5000000000000000015, without its nineteenth decimal
    assert.fieldEquals("PositionLend", lendId, "lpbValueInQuote", "1.500000000000000001")
  })

  test("values LP in a bucket that holds nothing at zero", () => {
    mint(manager(), POOL, TOKEN_ID, LENDER, 101)
    // LP is outstanding, but the bucket has neither quote nor collateral; the pool reports a rate of 1
    const bucket = new BucketState()
    bucket.lp = wad(10)
    mockBucketInfo(deployment().poolInfoUtils, POOL, INDEX, bucket)
    mockPositionLp(INDEX, wad(10), 102)
    handleMemorializePosition(createMemorializePositionEvent(manager(), 102, 1, LENDER, TOKEN_ID, [INDEX]))

    const lendId = positionLendId(manager(), TOKEN_ID, INDEX)
    assert.fieldEquals("Bucket", bucketId(POOL, INDEX), "exchangeRate", "1")
    assert.fieldEquals("PositionLend", lendId, "lpb", "10")
    assert.fieldEquals("PositionLend", lendId, "lpbValueInQuote", "0")
  })

  test("values LP in a bucket that holds only collateral", () => {
    mint(manager(), POOL, TOKEN_ID, LENDER, 101)
    // all of the bucket's quote has been swapped for collateral: 10 LP over 0.2 collateral at a price of 100
    const bucket = new BucketState()
    bucket.price = wad(100)
    bucket.collateral = wadOf("0.2")
    bucket.lp = wad(10)
    bucket.exchangeRate = wad(2)
    mockBucketInfo(deployment().poolInfoUtils, POOL, INDEX, bucket)
    mockPositionLp(INDEX, wad(10), 102)
    handleMemorializePosition(createMemorializePositionEvent(manager(), 102, 1, LENDER, TOKEN_ID, [INDEX]))

    assert.fieldEquals("Bucket", bucketId(POOL, INDEX), "deposit", "0")
    assert.fieldEquals("PositionLend", positionLendId(manager(), TOKEN_ID, INDEX), "lpbValueInQuote", "20")
  })

  test("reads a position's LP in a bucket once per block", () => {
    mintWithLp(wad(100))

    // two events of block 103 name the bucket; the manager's answer is that block's final state
    mockBucket(INDEX, wad(1000), wad(1))
    mockBucket(OTHER_INDEX, wad(1000), wad(1))
    mockPositionLp(INDEX, wad(70), 102)
    mockPositionLp(OTHER_INDEX, wad(30), 103)
    handleMoveLiquidity(
      createMoveLiquidityEvent(manager(), 103, 1, LENDER, TOKEN_ID, INDEX, OTHER_INDEX, wad(30), wad(30))
    )
    assert.fieldEquals("PositionLend", positionLendId(manager(), TOKEN_ID, INDEX), "lpb", "70")

    // a different answer within the block would mean a second read
    mockPositionLp(INDEX, wad(5), 102)
    handleMemorializePosition(createMemorializePositionEvent(manager(), 103, 2, LENDER, TOKEN_ID, [INDEX]))
    assert.fieldEquals("PositionLend", positionLendId(manager(), TOKEN_ID, INDEX), "lpb", "70")

    // the next block reads again
    handleMemorializePosition(createMemorializePositionEvent(manager(), 104, 1, LENDER, TOKEN_ID, [INDEX]))
    assert.fieldEquals("PositionLend", positionLendId(manager(), TOKEN_ID, INDEX), "lpb", "5")
    assert.fieldEquals("PositionLend", positionLendId(manager(), TOKEN_ID, INDEX), "updatedAtBlockNumber", "104")
  })

  test("the pool's handlers keep the manager's Lend, and the manager's keep each position's part of it", () => {
    // Two positions of two owners in the same bucket. In the pool, all of their LP is the manager's.
    const otherToken = TOKEN_ID + 1
    mint(manager(), POOL, TOKEN_ID, LENDER, 101)
    mint(manager(), POOL, otherToken, OTHER_LENDER, 101)

    // LENDER memorializes 100 LP: the pool's TransferLP to the manager, then MemorializePosition
    mockBucket(INDEX, wad(1000), wad(1))
    mockLenderIn(INDEX, LENDER, new LenderState())
    mockLenderIn(INDEX, manager(), unmarkedLender(wad(100), wad(100), blockTimestamp(90)))
    mockPositionLp(INDEX, wad(100), 90)
    handleTransferLP(createTransferLPEvent(POOL, 102, 0, LENDER, manager(), [INDEX], wad(100)))
    handleMemorializePosition(createMemorializePositionEvent(manager(), 102, 1, LENDER, TOKEN_ID, [INDEX]))

    // OTHER_LENDER memorializes 50 LP into the same bucket
    mockLenderIn(INDEX, OTHER_LENDER, new LenderState())
    mockLenderIn(INDEX, manager(), unmarkedLender(wad(150), wad(150), blockTimestamp(95)))
    mockPositionInfo(manager(), otherToken, INDEX, wad(50), blockTimestamp(95))
    handleTransferLP(createTransferLPEvent(POOL, 103, 0, OTHER_LENDER, manager(), [INDEX], wad(50)))
    handleMemorializePosition(createMemorializePositionEvent(manager(), 103, 1, OTHER_LENDER, otherToken, [INDEX]))

    assert.fieldEquals("Lend", lendId(INDEX, manager()), "lpb", "150")
    assert.fieldEquals("Lend", lendId(INDEX, manager()), "account", manager().toHexString())
    assert.fieldEquals("PositionLend", positionLendId(manager(), TOKEN_ID, INDEX), "lpb", "100")
    const otherLendId = positionLendId(manager(), otherToken, INDEX)
    assert.fieldEquals("PositionLend", otherLendId, "lpb", "50")
    assert.fieldEquals("PositionLend", otherLendId, "depositTime", blockTimestamp(95).toString())
    assert.entityCount("Lend", 1)
    assert.entityCount("PositionLend", 2)

    // LENDER redeems: the manager's allowance to the owner, the pool's TransferLP back, then RedeemPosition
    mockLenderIn(INDEX, LENDER, unmarkedLender(wad(100), wad(100), blockTimestamp(95)))
    mockLenderIn(INDEX, manager(), unmarkedLender(wad(50), wad(50), blockTimestamp(95)))
    mockNoPositionInfo(manager(), TOKEN_ID, INDEX)
    handleIncreaseLPAllowance(createIncreaseLPAllowanceEvent(POOL, 104, 0, manager(), LENDER, [INDEX], [wad(100)]))
    handleTransferLP(createTransferLPEvent(POOL, 104, 1, manager(), LENDER, [INDEX], wad(100)))
    handleRedeemPosition(createRedeemPositionEvent(manager(), 104, 2, LENDER, TOKEN_ID, [INDEX]))

    assert.fieldEquals("Lend", lendId(INDEX, LENDER), "lpb", "100")
    assert.fieldEquals("Lend", lendId(INDEX, manager()), "lpb", "50")
    assert.notInStore("PositionLend", positionLendId(manager(), TOKEN_ID, INDEX))
    assert.fieldEquals("PositionLend", positionLendId(manager(), otherToken, INDEX), "lpb", "50")
    // the transfer used up the allowance the manager gave the owner
    assert.entityCount("LPAllowance", 0)

    // The pool counts its own calls: two transfers in, an allowance and a transfer out. The
    // owners' accounts count their mints, memorializes and the redeem, and the manager's account
    // the allowance it gave: in the pool, the manager is the lender who made that call.
    assert.fieldEquals("Pool", POOL.toHexString(), "txCount", "4")
    assert.fieldEquals("Account", LENDER.toHexString(), "txCount", "3")
    assert.fieldEquals("Account", OTHER_LENDER.toHexString(), "txCount", "2")
    assert.fieldEquals("Account", manager().toHexString(), "txCount", "1")
  })

  test("a position minted, filled, emptied and burned in one block leaves nothing behind", () => {
    // Reads return the state at the end of the block, when the token no longer exists: zeros for
    // every bucket. No bucket is mocked, because none is read.
    mockNoPositionInfo(manager(), TOKEN_ID, INDEX)
    mockNoPositionInfo(manager(), TOKEN_ID, OTHER_INDEX)

    mint(manager(), POOL, TOKEN_ID, LENDER, 101)
    handleMemorializePosition(createMemorializePositionEvent(manager(), 101, 2, LENDER, TOKEN_ID, [INDEX]))
    assert.entityCount("PositionLend", 0)
    handleRedeemPosition(createRedeemPositionEvent(manager(), 101, 3, LENDER, TOKEN_ID, [INDEX]))
    handleTransfer(createTransferEvent(manager(), 101, 4, LENDER, Address.zero(), TOKEN_ID))
    handleBurn(createBurnEvent(manager(), 101, 5, LENDER, TOKEN_ID))

    assert.entityCount("Position", 0)
    assert.entityCount("PositionLend", 0)
    assert.fieldEquals("PositionManager", manager().toHexString(), "positionCount", "0")
    // every event is still recorded
    assert.entityCount("Mint", 1)
    assert.entityCount("MemorializePosition", 1)
    assert.entityCount("RedeemPosition", 1)
    assert.entityCount("Burn", 1)
    assert.fieldEquals("Account", LENDER.toHexString(), "txCount", "4")
  })
})
