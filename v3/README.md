# Ajna v3 Subgraph

Subgraph for the Ajna v3 contracts ([ajna-finance/ajna-v3](https://github.com/ajna-finance/ajna-v3)). It is a separate package from the v2 subgraph in the repository root: it has its own manifest, schema, ABIs, mappings and tests, and shares no code with it.

## Status

Scaffold only. The subgraph records each `PoolCreated` event and starts indexing the new pool, but the handlers for the pool and PositionManager events are empty, so nothing else is stored yet.

## Setup

```
yarn install
yarn configure sepolia
yarn codegen
yarn build
yarn test
```

`yarn configure <network>` reads `config/<network>.json` and writes `subgraph.yaml` and `src/config/deployments.ts`. Neither file is committed, so run it after cloning and whenever you switch networks. Run `yarn codegen` again afterwards.

The tests run against whichever config was rendered last and cover every deployment in it. CI runs them with `tests/fixtures/two-factories.json`.

## Deployments

Ajna v3 has one pool factory per loan term, and each factory has its own PositionManager. A network can therefore hold several deployments, and `config/<network>.json` lists them:

```json
{
  "network": "sepolia",
  "deployments": [
    {
      "description": "30-day loan term",
      "factory": { "address": "0x...", "startBlock": 12197818 },
      "positionManager": { "address": "0x...", "startBlock": 12197821 },
      "poolInfoUtils": "0x...",
      "poolInfoUtilsMulticall": "0x..."
    }
  ]
}
```

- To support another loan term, add an entry to `deployments`.
- To support another network, add a config file.
- `description` is for readers only.

Mappings must not assume a network has one factory, PositionManager or reader contract. `src/utils/deployments.ts` finds the deployment for the address that emitted an event, and pool handlers read their factory and reader addresses from the data source context.

## ABIs

`abis/` holds the ABIs of the five contracts the subgraph reads. `abis/ajna-v3.lock.json` records the ajna-v3 commit they were built from. To move to another commit:

```
./scripts/copy-abis.sh <path to an ajna-v3 checkout at that commit>
yarn configure <network>
```

The script runs `forge build` in the checkout, so it needs Foundry and `jq`. `yarn configure` then fails if an ABI has an event without a handler in the manifest, or the manifest names an event the ABI no longer has. An event whose signature changed stops matching without any error at indexing time, so fix every mismatch it reports before deploying.

## Known issues

- On Apple silicon newer than M2, `yarn test` fails with `Unsupported platform`, because graph-cli 0.56 does not recognise the CPU. Download `binary-macos-11-m1` from the [Matchstick 0.6.0 release](https://github.com/LimeChain/matchstick/releases/tag/0.6.0), the version `yarn test` uses, and run it from this directory instead.
