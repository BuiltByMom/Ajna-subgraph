# Ajna v3 Subgraph

Subgraph for the Ajna v3 contracts ([ajna-finance/ajna-v3](https://github.com/ajna-finance/ajna-v3)). It is a separate package from the v2 subgraph in the repository root: it has its own manifest, schema, ABIs, mappings and tests, and shares no code with it.

## Status

In progress. The subgraph indexes:

- pool factories, pools and their tokens
- buckets and lenders' positions in them (`AddQuoteToken`, `MoveQuoteToken`, `RemoveQuoteToken`, `AddCollateral`, `RemoveCollateral`)
- LP transfers, allowances and approved transferors
- flashloans, interest rate changes and interest update failures

The handlers for loans, the lender exit queue, surplus auctions and the PositionManager are still empty. Until they are written, a pool or bucket is not refreshed when one of those events changes it.

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

Mappings must not assume a network has one factory, PositionManager or reader contract. `src/utils/deployments.ts` finds the deployment for the address that emitted an event, or for a pool through the pool's factory.

## Design

### Where state comes from

`Pool`, `Bucket` and `Lend` are set from contract reads, not from event amounts. A read made while handling an event returns state as of the end of that event's block, so:

- these entities always hold end-of-block state, and events in the same block write the same values
- the pool and each bucket are read at most once per block
- `updatedAtBlockNumber` says which block an entity was last read at. Interest accrues between events, so a value can be older than the block you query.

The entity that records an event (`AddQuoteToken`, `RemoveQuoteToken` and so on) keeps that event's own amounts.

If the reader contracts revert for a pool, which can happen after the pool emits `InterestUpdateFailure`, the pool keeps its last state and its `updatedAtBlockNumber` does not advance.

### Retention

A `Lend` is removed when the lender has no LP left in the bucket. Pools and buckets are kept, even when empty.

### Differences from the v2 schema

This covers the entities written so far. Fields and entities that belong to the handlers not yet written, such as a pool's `t0debt`, `pledgedCollateral`, `loansCount` and `totalAjnaBurned`, are absent for now and are not listed as removed.

| Entity | Change |
| ------ | ------ |
| `PoolFactory` | Adds `loanTerm`. `pools` is derived. `poolType` and `txCount` are gone. |
| `Pool` | Adds `factory`, `loanTerm`, `debt`, `rateAtTarget`, `utilization`, `escrowedQuote`, `availableQuote`, the six surplus fields, `interestUpdateFailures` and `updatedAt*`. Prices (`hpb`, `htp`, `lup`), fees, reserves, burn epoch, bonds, liquidations, `totalInterestEarned`, `maxBorrower`, `minDebtAmount`, `actualUtilization`, `targetUtilization`, `poolType` and the ERC721 fields are gone. |
| `Pool.txCount`, `Token.txCount`, `Account.txCount` | Count actions. `UpdateInterestRate` and `InterestUpdateFailure` are emitted as part of another action and are not counted. |
| `Token` | `pools` is split into the derived `poolsAsCollateral` and `poolsAsQuote`. `tokenType` and `totalSupply` are gone. |
| `Bucket` | `lends` is derived. Adds `updatedAt*`. |
| `Lend` | Adds `account` and `updatedAt*`. `lpbValueInQuote` includes LP the exit queue has funded. |
| `Account` | `lends` is derived. `pools` and the liquidation, reserve auction and grant fields are gone. |
| `LPAllowanceList` | `allowances` is derived, and an empty list is kept. Ids are built from the raw address bytes. |
| `LPTransferorList` | Ids are built from the raw address bytes. |
| `PoolCreated` | Adds `collateralToken` and `quoteToken`. `poolType` is gone. |
| `AddQuoteToken`, `MoveQuoteToken`, `RemoveQuoteToken` | `lup` is gone. |
| `TransferLP` | Adds `pool`. |
| `Flashloan` | Adds `token` and the block and transaction fields. |
| `UpdateInterestRate` | Keeps the old and new borrow rate only. |
| `InterestUpdateFailure` | New. |

## ABIs

`abis/` holds the ABIs of the five Ajna contracts the subgraph reads. `abis/ajna-v3.lock.json` records the ajna-v3 commit they were built from. `abis/tokens/` holds two small hand-written ABIs for reading a token's name, symbol and decimals. To move the Ajna ABIs to another commit:

```
./scripts/copy-abis.sh <path to an ajna-v3 checkout at that commit>
yarn configure <network>
```

The script runs `forge build` in the checkout, so it needs Foundry and `jq`. `yarn configure` then fails if an ABI has an event without a handler in the manifest, or the manifest names an event the ABI no longer has. An event whose signature changed stops matching without any error at indexing time, so fix every mismatch it reports before deploying.

## Known issues

- On Apple silicon newer than M2, `yarn test` fails with `Unsupported platform`, because graph-cli 0.56 does not recognise the CPU. Download `binary-macos-11-m1` from the [Matchstick 0.6.0 release](https://github.com/LimeChain/matchstick/releases/tag/0.6.0), the version `yarn test` uses, and run it from this directory instead.
