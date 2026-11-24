import { afterEach, assert, clearStore, describe, test } from "matchstick-as/assembly/index"

import { handlePoolCreated } from "../src/mappings/erc-20-pool-factory"
import { allDeployments } from "../src/utils/deployments"
import { testAddress } from "./utils/common"
import { createPoolCreatedEvent } from "./utils/erc-20-pool-factory-utils"

// These tests run against whichever config `yarn configure` last rendered, and cover every
// deployment in it. CI runs them with tests/fixtures/two-factories.json.

const COLLATERAL = testAddress(0xc0)
const QUOTE = testAddress(0xc1)

describe("handlePoolCreated", () => {
  afterEach(() => {
    clearStore()
  })

  test("records the pool created by each configured factory and starts indexing it", () => {
    const deployments = allDeployments()

    for (let i = 0; i < deployments.length; i++) {
      const pool = testAddress(0x1000 + i)
      const event = createPoolCreatedEvent(deployments[i].factory, pool, COLLATERAL, QUOTE, i)
      handlePoolCreated(event)

      const id = event.transaction.hash.concatI32(i).toHexString()
      assert.fieldEquals("PoolCreated", id, "pool", pool.toHexString())
      assert.fieldEquals("PoolCreated", id, "factory", deployments[i].factory.toHexString())
      assert.fieldEquals("PoolCreated", id, "collateralToken", COLLATERAL.toHexString())
      assert.fieldEquals("PoolCreated", id, "quoteToken", QUOTE.toHexString())
      assert.dataSourceExists("ERC20Pool", pool.toHexString())
    }

    assert.entityCount("PoolCreated", deployments.length)
    assert.dataSourceCount("ERC20Pool", deployments.length)
  })

  // A PoolCreated from a factory that is not configured ends in log.critical, which Matchstick
  // turns into a panic of the whole test run, so that path has no test here. The lookup it depends
  // on is covered in deployments.test.ts.
})
