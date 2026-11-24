import { assert, describe, test } from "matchstick-as/assembly/index"

import {
  Deployment,
  allDeployments,
  deploymentForFactory,
  deploymentForPositionManager
} from "../src/utils/deployments"
import { testAddress } from "./utils/common"

// These tests run against whichever config `yarn configure` last rendered, and cover every
// deployment in it. CI runs them with tests/fixtures/two-factories.json.

function assertSameDeployment(expected: Deployment, actual: Deployment | null): void {
  assert.assertNotNull(actual)
  assert.addressEquals(expected.factory, actual!.factory)
  assert.addressEquals(expected.positionManager, actual!.positionManager)
  assert.addressEquals(expected.poolInfoUtils, actual!.poolInfoUtils)
  assert.addressEquals(expected.poolInfoUtilsMulticall, actual!.poolInfoUtilsMulticall)
}

describe("deployments", () => {
  test("each deployment is found by its factory and by its PositionManager", () => {
    const deployments = allDeployments()
    assert.assertTrue(deployments.length > 0)

    for (let i = 0; i < deployments.length; i++) {
      const deployment = deployments[i]
      assertSameDeployment(deployment, deploymentForFactory(deployment.factory))
      assertSameDeployment(deployment, deploymentForPositionManager(deployment.positionManager))

      // the two lookups do not answer for each other's addresses
      assert.assertNull(deploymentForFactory(deployment.positionManager))
      assert.assertNull(deploymentForPositionManager(deployment.factory))
    }
  })

  test("an address that is not configured has no deployment", () => {
    assert.assertNull(deploymentForFactory(testAddress(0xdead)))
    assert.assertNull(deploymentForPositionManager(testAddress(0xdead)))
  })
})
