import { afterEach, assert, beforeEach, clearStore, describe, test } from "matchstick-as/assembly/index"
import { Address, BigInt, Bytes } from "@graphprotocol/graph-ts"

import { Pool, SurplusAuction } from "../generated/schema"
import {
  handleKickCollateralSurplusAuction,
  handleKickQuoteSurplusAuction,
  handleTakeCollateralSurplus,
  handleTakeQuoteSurplus
} from "../src/mappings/erc-20-pool"
import { Deployment, allDeployments } from "../src/utils/deployments"
import { SURPLUS_COLLATERAL, SURPLUS_QUOTE, getSurplusAuctionId } from "../src/utils/pool/surplus-auction"
import { blockTimestamp, eventEntityId, testAddress, wad } from "./utils/common"
import { createPool } from "./utils/erc-20-pool-factory-utils"
import {
  createKickCollateralSurplusAuctionEvent,
  createKickQuoteSurplusAuctionEvent,
  createTakeCollateralSurplusEvent,
  createTakeQuoteSurplusEvent
} from "./utils/erc-20-pool-utils"
import { PoolSnapshot, mockPoolSnapshot, mockPoolSnapshotReverts } from "./utils/mock-contract-calls"

// These tests run against whichever config `yarn configure` last rendered, using its first
// deployment. CI runs them with tests/fixtures/two-factories.json.
//
// Handlers read contract state once per block, so each step that changes mocked state uses a
// new block number. Events placed in the same block belong to one transaction.

const POOL = testAddress(0x1000)
const COLLATERAL = testAddress(0x7000)
const QUOTE = testAddress(0x7001)
const KICKER = testAddress(0xa001)
const TAKER = testAddress(0xa002)
const CREATED_AT = 100
// blocks are 12 seconds apart in these tests, so this is five days after block 101
const FIVE_DAYS_LATER = 101 + 36000

function deployment(): Deployment {
  return allDeployments()[0]
}

function auctionId(pool: Address, kind: string, kickBlock: i32): string {
  return getSurplusAuctionId(pool, kind, blockTimestamp(kickBlock)).toHexString()
}

function storedAuction(id: string): SurplusAuction {
  return SurplusAuction.load(Bytes.fromHexString(id))!
}

// the pool as its readers report it once a quote lot of the given size is escrowed for an auction
function mockPoolWithQuoteLot(lotRemaining: BigInt): void {
  const snapshot = new PoolSnapshot()
  snapshot.quoteTokenBalance = wad(1000).plus(lotRemaining)
  snapshot.quoteSurplusLotRemaining = lotRemaining
  mockPoolSnapshot(deployment().poolInfoUtilsMulticall, POOL, snapshot)
}

// KICKER starts a quote auction of 50 in block 101. The whole lot starts at 1,000,000,000 AJNA,
// so the price is 20,000,000 AJNA per token.
function kickQuote50(): void {
  mockPoolWithQuoteLot(wad(50))
  handleKickQuoteSurplusAuction(createKickQuoteSurplusAuctionEvent(POOL, 101, 0, KICKER, wad(50), wad(0), wad(20000000)))
}

describe("ERC20Pool surplus auctions", () => {
  beforeEach(() => {
    createPool(deployment(), POOL, COLLATERAL, QUOTE, new PoolSnapshot(), CREATED_AT)
  })

  afterEach(() => {
    clearStore()
  })

  test("KickQuoteSurplusAuction starts an auction of the pool's quote token", () => {
    mockPoolWithQuoteLot(wad(50))
    const event = createKickQuoteSurplusAuctionEvent(POOL, 101, 2, KICKER, wad(50), wad(0), wad(20000000))
    handleKickQuoteSurplusAuction(event)

    const id = auctionId(POOL, SURPLUS_QUOTE, 101)
    const kickId = eventEntityId(event)
    assert.fieldEquals("SurplusAuction", id, "pool", POOL.toHexString())
    assert.fieldEquals("SurplusAuction", id, "kind", "Quote")
    assert.fieldEquals("SurplusAuction", id, "token", QUOTE.toHexString())
    assert.fieldEquals("SurplusAuction", id, "kick", kickId)
    assert.fieldEquals("SurplusAuction", id, "kicker", KICKER.toHexString())
    assert.fieldEquals("SurplusAuction", id, "kickTime", blockTimestamp(101).toString())
    assert.fieldEquals("SurplusAuction", id, "lot", "50")
    assert.fieldEquals("SurplusAuction", id, "rolledOver", "0")
    assert.fieldEquals("SurplusAuction", id, "startingPrice", "20000000")
    assert.fieldEquals("SurplusAuction", id, "lotRemaining", "50")
    assert.fieldEquals("SurplusAuction", id, "ajnaBurned", "0")
    assert.assertTrue(storedAuction(id).lastTakePrice === null)

    assert.fieldEquals("SurplusAuctionKick", kickId, "pool", POOL.toHexString())
    assert.fieldEquals("SurplusAuctionKick", kickId, "auction", id)
    assert.fieldEquals("SurplusAuctionKick", kickId, "kind", "Quote")
    assert.fieldEquals("SurplusAuctionKick", kickId, "kicker", KICKER.toHexString())
    assert.fieldEquals("SurplusAuctionKick", kickId, "lot", "50")
    assert.fieldEquals("SurplusAuctionKick", kickId, "rolledOver", "0")
    assert.fieldEquals("SurplusAuctionKick", kickId, "auctionPrice", "20000000")
    assert.fieldEquals("SurplusAuctionKick", kickId, "blockNumber", "101")

    assert.fieldEquals("Pool", POOL.toHexString(), "quoteSurplusAuction", id)
    assert.assertTrue(Pool.load(POOL)!.collateralSurplusAuction === null)
    // the pool is refreshed: the lot is now escrowed for the auction
    assert.fieldEquals("Pool", POOL.toHexString(), "quoteSurplusLotRemaining", "50")
    assert.fieldEquals("Pool", POOL.toHexString(), "updatedAtBlockNumber", "101")
    assert.fieldEquals("Pool", POOL.toHexString(), "totalAjnaBurned", "0")
    // a kick is an action of the kicker's
    assert.fieldEquals("Pool", POOL.toHexString(), "txCount", "1")
    assert.fieldEquals("Account", KICKER.toHexString(), "txCount", "1")
    assert.fieldEquals("Token", QUOTE.toHexString(), "txCount", "1")
  })

  test("takes reduce the lot and burn AJNA", () => {
    kickQuote50()
    const id = auctionId(POOL, SURPLUS_QUOTE, 101)

    // an hour in, at half the starting price: 20 of the lot for 200,000,000 AJNA
    mockPoolWithQuoteLot(wad(30))
    const first = createTakeQuoteSurplusEvent(POOL, 401, 0, TAKER, wad(20), wad(200000000), wad(30), wad(10000000))
    handleTakeQuoteSurplus(first)

    const firstId = eventEntityId(first)
    assert.fieldEquals("SurplusAuctionTake", firstId, "pool", POOL.toHexString())
    assert.fieldEquals("SurplusAuctionTake", firstId, "auction", id)
    assert.fieldEquals("SurplusAuctionTake", firstId, "kind", "Quote")
    assert.fieldEquals("SurplusAuctionTake", firstId, "taker", TAKER.toHexString())
    assert.fieldEquals("SurplusAuctionTake", firstId, "amount", "20")
    assert.fieldEquals("SurplusAuctionTake", firstId, "ajnaBurned", "200000000")
    assert.fieldEquals("SurplusAuctionTake", firstId, "lotRemaining", "30")
    assert.fieldEquals("SurplusAuctionTake", firstId, "auctionPrice", "10000000")
    assert.fieldEquals("SurplusAuction", id, "lotRemaining", "30")
    assert.fieldEquals("SurplusAuction", id, "lastTakePrice", "10000000")
    assert.fieldEquals("SurplusAuction", id, "ajnaBurned", "200000000")
    assert.fieldEquals("Pool", POOL.toHexString(), "totalAjnaBurned", "200000000")
    assert.fieldEquals("Pool", POOL.toHexString(), "quoteSurplusLotRemaining", "30")

    // another hour in: the rest of the lot for 150,000,000 AJNA
    mockPoolWithQuoteLot(wad(0))
    handleTakeQuoteSurplus(createTakeQuoteSurplusEvent(POOL, 701, 0, TAKER, wad(30), wad(150000000), wad(0), wad(5000000)))

    assert.entityCount("SurplusAuctionTake", 2)
    assert.fieldEquals("SurplusAuction", id, "lotRemaining", "0")
    assert.fieldEquals("SurplusAuction", id, "lastTakePrice", "5000000")
    assert.fieldEquals("SurplusAuction", id, "ajnaBurned", "350000000")
    // what the kick fixed does not change
    assert.fieldEquals("SurplusAuction", id, "lot", "50")
    assert.fieldEquals("SurplusAuction", id, "startingPrice", "20000000")
    assert.fieldEquals("Pool", POOL.toHexString(), "totalAjnaBurned", "350000000")
    assert.fieldEquals("Pool", POOL.toHexString(), "txCount", "3")
    assert.fieldEquals("Account", TAKER.toHexString(), "txCount", "2")
    assert.fieldEquals("Account", KICKER.toHexString(), "txCount", "1")
  })

  test("the quote and collateral auctions run side by side", () => {
    // both are kicked in one transaction, so they share a kick time
    kickQuote50()
    const collateralKick = createKickCollateralSurplusAuctionEvent(POOL, 101, 1, KICKER, wad(4), wad(0), wad(250000000))
    handleKickCollateralSurplusAuction(collateralKick)

    const quoteId = auctionId(POOL, SURPLUS_QUOTE, 101)
    const collateralId = auctionId(POOL, SURPLUS_COLLATERAL, 101)
    assert.assertTrue(quoteId != collateralId)
    assert.entityCount("SurplusAuction", 2)
    assert.fieldEquals("SurplusAuction", collateralId, "kind", "Collateral")
    assert.fieldEquals("SurplusAuction", collateralId, "token", COLLATERAL.toHexString())
    assert.fieldEquals("SurplusAuction", collateralId, "lot", "4")
    assert.fieldEquals("SurplusAuctionKick", eventEntityId(collateralKick), "kind", "Collateral")
    assert.fieldEquals("Pool", POOL.toHexString(), "quoteSurplusAuction", quoteId)
    assert.fieldEquals("Pool", POOL.toHexString(), "collateralSurplusAuction", collateralId)

    // a collateral take belongs to the collateral auction, and leaves the quote auction alone
    const collateralTake = createTakeCollateralSurplusEvent(POOL, 103, 0, TAKER, wad(1), wad(250000000), wad(3), wad(250000000))
    handleTakeCollateralSurplus(collateralTake)

    assert.fieldEquals("SurplusAuctionTake", eventEntityId(collateralTake), "auction", collateralId)
    assert.fieldEquals("SurplusAuctionTake", eventEntityId(collateralTake), "kind", "Collateral")
    assert.fieldEquals("SurplusAuction", collateralId, "lotRemaining", "3")
    assert.fieldEquals("SurplusAuction", collateralId, "ajnaBurned", "250000000")
    assert.fieldEquals("SurplusAuction", quoteId, "lotRemaining", "50")
    assert.fieldEquals("SurplusAuction", quoteId, "ajnaBurned", "0")
    assert.assertTrue(storedAuction(quoteId).lastTakePrice === null)

    // and a quote take the other way round
    handleTakeQuoteSurplus(createTakeQuoteSurplusEvent(POOL, 104, 0, TAKER, wad(10), wad(200000000), wad(40), wad(20000000)))

    assert.fieldEquals("SurplusAuction", quoteId, "lotRemaining", "40")
    assert.fieldEquals("SurplusAuction", collateralId, "lotRemaining", "3")
    // the pool's total covers both auctions
    assert.fieldEquals("Pool", POOL.toHexString(), "totalAjnaBurned", "450000000")
  })

  test("a later kick starts a new auction that carries over what the last one left unsold", () => {
    kickQuote50()
    handleTakeQuoteSurplus(createTakeQuoteSurplusEvent(POOL, 401, 0, TAKER, wad(20), wad(200000000), wad(30), wad(10000000)))
    const firstId = auctionId(POOL, SURPLUS_QUOTE, 101)

    // five days on: the 30 left unsold joins 15 of new surplus
    const kick = createKickQuoteSurplusAuctionEvent(
      POOL,
      FIVE_DAYS_LATER,
      0,
      TAKER,
      wad(45),
      wad(30),
      BigInt.fromString("22222222222222222222222222")
    )
    handleKickQuoteSurplusAuction(kick)

    const secondId = auctionId(POOL, SURPLUS_QUOTE, FIVE_DAYS_LATER)
    assert.assertTrue(firstId != secondId)
    assert.entityCount("SurplusAuction", 2)
    assert.fieldEquals("SurplusAuction", secondId, "lot", "45")
    assert.fieldEquals("SurplusAuction", secondId, "rolledOver", "30")
    assert.fieldEquals("SurplusAuction", secondId, "lotRemaining", "45")
    assert.fieldEquals("SurplusAuction", secondId, "kicker", TAKER.toHexString())
    assert.fieldEquals("SurplusAuction", secondId, "startingPrice", "22222222.222222222222222222")
    assert.fieldEquals("Pool", POOL.toHexString(), "quoteSurplusAuction", secondId)

    // a take now belongs to the new auction; the old one stays as it ended
    handleTakeQuoteSurplus(
      createTakeQuoteSurplusEvent(POOL, FIVE_DAYS_LATER + 1, 0, TAKER, wad(45), wad(1000000000), wad(0), BigInt.fromString("22222222222222222222222222"))
    )

    assert.fieldEquals("SurplusAuction", secondId, "lotRemaining", "0")
    assert.fieldEquals("SurplusAuction", secondId, "ajnaBurned", "1000000000")
    assert.fieldEquals("SurplusAuction", firstId, "lotRemaining", "30")
    assert.fieldEquals("SurplusAuction", firstId, "ajnaBurned", "200000000")
    assert.fieldEquals("SurplusAuction", firstId, "lastTakePrice", "10000000")
    assert.fieldEquals("Pool", POOL.toHexString(), "totalAjnaBurned", "1200000000")
  })

  test("a kick and a take in one transaction", () => {
    mockPoolWithQuoteLot(wad(0))
    handleKickQuoteSurplusAuction(createKickQuoteSurplusAuctionEvent(POOL, 101, 0, KICKER, wad(50), wad(0), wad(20000000)))
    const take = createTakeQuoteSurplusEvent(POOL, 101, 1, KICKER, wad(50), wad(1000000000), wad(0), wad(20000000))
    handleTakeQuoteSurplus(take)

    const id = auctionId(POOL, SURPLUS_QUOTE, 101)
    assert.fieldEquals("SurplusAuctionTake", eventEntityId(take), "auction", id)
    assert.fieldEquals("SurplusAuction", id, "lot", "50")
    assert.fieldEquals("SurplusAuction", id, "lotRemaining", "0")
    assert.fieldEquals("SurplusAuction", id, "ajnaBurned", "1000000000")
    assert.fieldEquals("Pool", POOL.toHexString(), "txCount", "2")
    assert.fieldEquals("Account", KICKER.toHexString(), "txCount", "2")
  })

  test("records a kick and a take while the pool cannot be read", () => {
    mockPoolSnapshotReverts(deployment().poolInfoUtilsMulticall, POOL)
    handleKickQuoteSurplusAuction(createKickQuoteSurplusAuctionEvent(POOL, 101, 0, KICKER, wad(50), wad(0), wad(20000000)))
    handleTakeQuoteSurplus(createTakeQuoteSurplusEvent(POOL, 102, 0, TAKER, wad(5), wad(100000000), wad(45), wad(20000000)))

    const id = auctionId(POOL, SURPLUS_QUOTE, 101)
    assert.fieldEquals("SurplusAuction", id, "lotRemaining", "45")
    assert.fieldEquals("Pool", POOL.toHexString(), "quoteSurplusAuction", id)
    assert.fieldEquals("Pool", POOL.toHexString(), "totalAjnaBurned", "100000000")
    // the pool's own reading is from before the kick, and says so
    assert.fieldEquals("Pool", POOL.toHexString(), "quoteSurplusLotRemaining", "0")
    assert.fieldEquals("Pool", POOL.toHexString(), "updatedAtBlockNumber", "100")
  })

  test("auctions kicked at the same moment in two pools are separate", () => {
    const otherPool = testAddress(0x1001)
    createPool(deployment(), otherPool, COLLATERAL, testAddress(0x7002), new PoolSnapshot(), CREATED_AT)
    kickQuote50()
    handleKickQuoteSurplusAuction(createKickQuoteSurplusAuctionEvent(otherPool, 101, 1, KICKER, wad(8), wad(0), wad(125000000)))
    handleTakeQuoteSurplus(createTakeQuoteSurplusEvent(otherPool, 102, 0, TAKER, wad(8), wad(1000000000), wad(0), wad(125000000)))

    assert.entityCount("SurplusAuction", 2)
    assert.fieldEquals("SurplusAuction", auctionId(POOL, SURPLUS_QUOTE, 101), "lotRemaining", "50")
    assert.fieldEquals("SurplusAuction", auctionId(otherPool, SURPLUS_QUOTE, 101), "lot", "8")
    assert.fieldEquals("SurplusAuction", auctionId(otherPool, SURPLUS_QUOTE, 101), "lotRemaining", "0")
    assert.fieldEquals("Pool", POOL.toHexString(), "totalAjnaBurned", "0")
    assert.fieldEquals("Pool", otherPool.toHexString(), "totalAjnaBurned", "1000000000")
  })
})
