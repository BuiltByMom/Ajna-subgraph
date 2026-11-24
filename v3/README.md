# Ajna v3 Subgraph

Subgraph for the Ajna v3 contracts ([ajna-finance/ajna-v3](https://github.com/ajna-finance/ajna-v3)). It is a separate package from the v2 subgraph in the repository root: it has its own manifest, schema, ABIs, mappings and tests, and shares no code with it.

## Status

In progress. The subgraph indexes:

- pool factories, pools and their tokens
- buckets and lenders' positions in them (`AddQuoteToken`, `MoveQuoteToken`, `RemoveQuoteToken`, `AddCollateral`, `RemoveCollateral`)
- LP transfers, allowances and approved transferors
- loans (`DrawDebt`, `RepayDebt`, `MoveLoan`, `ImproveLoan`, `LoanClosed`, `LoanCalled`) and borrower delegates
- the lender exit queue (`MarkQuoteForWithdrawal`, `ExitQueueFunded`, and claims from escrow)
- flashloans, interest rate changes and interest update failures

The handlers for surplus auctions and the PositionManager are still empty. Until they are written, a pool is not refreshed when a surplus auction event changes it.

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
- The two reader contracts must be deployed before the factory creates its first pool. Bucket, lend and loan reads go to them from that pool's first event, and a read of an address with no code yet stops the subgraph. `yarn configure` does not check this.

Mappings must not assume a network has one factory, PositionManager or reader contract. `src/utils/deployments.ts` finds the deployment for the address that emitted an event, or for a pool through the pool's factory.

## Design

### Where state comes from

`Pool`, `Bucket`, `Lend` and `Loan` are set from contract reads, not from event amounts. A read made while handling an event returns state as of the end of that event's block, so:

- these entities always hold end-of-block state, and events in the same block write the same values
- the pool, each bucket and each loan are read at most once per block
- a loan that is repaid, moved or called later in the block it opens in already reads as closed when its `DrawDebt` is handled
- `updatedAtBlockNumber` says which block an entity was last read at. Interest accrues between events, so a value can be older than the block you query.

The entity that records an event (`AddQuoteToken`, `DrawDebt` and so on) keeps that event's own amounts.

Some values are added up from events instead, because the contract changes them by exactly an event's amount and nowhere else:

- on the pool: `txCount`, the flashloan totals, `interestUpdateFailures`, `pledgedCollateral` and `lenderCollateral`. `loansCount` follows the loans' status.
- the exit queue: a bucket's `queueHead`, `queueTail`, `escrowQuote` and `escrowCollateral`, and every `ExitQueuePlace`. These are right after each event, not only at the end of the block.
- LP allowances.

### Precision

`BigDecimal` keeps 34 significant digits, which is exact for any amount below 1e16 whole units. Where the subgraph itself must tell when an amount reaches zero, it also stores the contract's exact integer (1e18 per unit) in a field ending in `Wad` and does its arithmetic on that: `ExitQueuePlace.lpbWad` and `queueStartWad`, and `LPAllowance.amountWad`. Totals added up from events in `BigDecimal`, such as a bucket's escrow, can be off in the last digit only when amounts exceed that size.

If the reader contracts revert for a pool, which can happen after the pool emits `InterestUpdateFailure`, the pool keeps its last state and its `updatedAtBlockNumber` does not advance. Two things still move: `t0debt`, which is read from the pool itself, and the borrow and lend rates when an `UpdateInterestRate` arrives.

### Debt

Debts are stored in t0 terms (`Pool.t0debt`, `Bucket.t0debt`, `Loan.t0debt`), which do not change as interest accrues. Multiply by the pool's current inflator for the debt owed. `Pool.debt` and `Pool.inflator` are the values at `updatedAtBlockNumber`.

### Loans

A borrower can hold any number of loans in a pool. Each has its own id, bucket, collateral, debt and expiry, and its entity id is the pool address, `|`, and the pool's loan id. A loan never takes on more debt and never changes bucket: `moveLoan` and `improveLoan` open a new loan, which points back with `movedFrom`.

`Loan.status` is `Active` while the loan has debt, `DebtFree` when it has none but still holds collateral, and `Closed` once the pool has deleted it.

A loan with debt can be called once the block timestamp is past `expiry`, or while its collateral at the bucket price is worth less than 1.05 times its debt. Work that out from `t0debt`, `collateralPledged`, `bucket.bucketPrice`, `expiry` and the pool's current inflator. `thresholdPrice` rounds differently from the pool's check, so do not compare it with the bucket price to decide.

### Exit queue

A lender who calls `markQuoteForWithdrawal` puts all of their LP in a bucket on that bucket's exit queue. Until their claims have redeemed all of it, they cannot add, move or transfer LP there.

- **Places.** An `ExitQueuePlace` is the lender's place on the queue, from `queueStart` to `queueStart + lpb`, measured in LP. It has the same id as the lender's `Lend`, and is removed when its last LP is claimed.
- **Funding.** Quote or collateral that reaches the bucket funds the front of the queue. Each `ExitQueueFunded` moves the bucket's `queueHead` forward and adds what paid for the LP to `escrowQuote` or `escrowCollateral`. The funded LP leaves the bucket's `lpb`, but the lender still holds it until they claim. An event with `isGiveUp` set escrowed nothing: LP worth less than one quote token unit was dropped from the queue for no payment.
- **How much of a place is funded.** `ExitQueueFunded` does not name the lenders it funds, so a `Lend` is not refreshed by it and its `liveLpb` and `fundedValueInQuote` can be out of date. The part of a place below the bucket's `queueHead` is funded: `min(lpb, max(0, queueHead - queueStart))`.
- **Claims.** A marked lender's `RemoveQuoteToken` or `RemoveCollateral` is a claim from escrow and has `isExitClaim` set. It redeems LP from the front of the place and can pay either token. `amount` can be zero, when the claim only clears funded LP too small to pay out.

`isExitClaim` is decided by whether the lender had a place when the event was handled, not by a contract read, because a lender can mark and claim everything within one block.

Deposit maturity is not indexed. `PoolInfoUtils.bucketLendable` gives how much of a bucket's deposit can fund loans now.

### Retention

A `Lend` is removed when the lender has no LP left in the bucket, and an `ExitQueuePlace` when its last LP is claimed. A `BorrowerDelegate`, `LPAllowance` or `LPTransferorList` is removed when it is revoked or used up. Pools, buckets and loans are kept: a closed loan stays, with the bucket and expiry it had.

### Differences from the v2 schema

This covers the entities written so far. Fields and entities that belong to the handlers not yet written, such as a pool's `totalAjnaBurned` and a bucket's `positionLends`, are absent for now and are not listed as removed.

| Entity | Change |
| ------ | ------ |
| `PoolFactory` | Adds `loanTerm`. `pools` is derived. `poolType` and `txCount` are gone. |
| `Pool` | Adds `factory`, `loanTerm`, `debt`, `rateAtTarget`, `utilization`, `escrowedQuote`, `availableQuote`, `lenderCollateral`, the six surplus fields, `interestUpdateFailures` and `updatedAt*`. `t0debt` now holds t0 debt (v2 stored the debt there). `loansCount` counts loans with debt. Prices (`hpb`, `htp`, `lup`), fees, reserves, burn epoch, bonds, liquidations, `totalInterestEarned`, `maxBorrower`, `minDebtAmount`, `actualUtilization`, `targetUtilization`, `poolType` and the ERC721 fields are gone. |
| `Pool.txCount`, `Token.txCount`, `Account.txCount` | Count actions. `UpdateInterestRate`, `InterestUpdateFailure`, `LoanClosed`, `ImproveLoan` and `ExitQueueFunded` are emitted as part of another action and are not counted. An account's count covers its lender actions and every action on its loans, including a call or a move by someone else. |
| `Token` | `pools` is split into the derived `poolsAsCollateral` and `poolsAsQuote`. `tokenType` and `totalSupply` are gone. |
| `Bucket` | `lends` is derived. Adds `t0debt`, `loans`, `queueHead`, `queueTail`, `escrowQuote`, `escrowCollateral`, `exitQueuePlaces` and `updatedAt*`. `deposit`, `collateral` and `lpb` exclude what the exit queue has moved to escrow. |
| `Lend` | Adds `account`, `marked`, `liveLpb`, `fundedValueInQuote` and `updatedAt*`. `lpbValueInQuote` includes LP the exit queue has funded. |
| `ExitQueuePlace` | New. |
| `Loan` | One per loan id, no longer one per borrower, and kept after it closes. The id is the pool address, `|`, and the loan id. Adds `loanId`, `counter`, `account`, `bucket`, `bucketIndex`, `status`, `t0Tp`, `inflatorAtDraw`, `expiry`, `movedFrom`, `movedTo`, `call` and the created, closed and updated blocks. `inLiquidation`, `liquidationAuction`, `t0Np` and `tokenIdsPledged` are gone. |
| `Account` | `lends`, `loans` and `exitQueuePlaces` are derived. `pools` and the liquidation, reserve auction and grant fields are gone. |
| `BorrowerDelegate` | New. |
| `LPAllowanceList` | `allowances` is derived, and an empty list is kept. Ids are built from the raw address bytes. |
| `LPAllowance` | Adds `allowanceList` and `amountWad`. An allowance for an index that is not a bucket, which the pool accepts, is not stored. |
| `LPTransferorList` | Ids are built from the raw address bytes. |
| `PoolCreated` | Adds `collateralToken` and `quoteToken`. `poolType` is gone. |
| `AddQuoteToken`, `MoveQuoteToken`, `RemoveQuoteToken` | `lup` is gone. |
| `RemoveQuoteToken`, `RemoveCollateral` | Add `isExitClaim`. `amount` can be zero. |
| `MarkQuoteForWithdrawal`, `ExitQueueFunded` | New. |
| `DrawDebt`, `RepayDebt` | Add `loan` and `bucket`. `lup` is gone. |
| `MoveLoan`, `ImproveLoan`, `LoanClosed`, `LoanCalled`, `SetBorrowerDelegates` | New. They replace `Kick`, `Take`, `BucketTake`, `BucketTakeLPAwarded`, `Settle`, `AuctionSettle`, `BondWithdrawn`, `LoanStamped`, `BucketBankruptcy` and `LiquidationAuction`. |
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

- On Linux, `yarn test` works on Ubuntu 22.04 only. graph-cli 0.56 asks for the Matchstick binary built for the Ubuntu version it runs on, and Matchstick 0.6.0 is published for Ubuntu 22 alone. On another version, download `binary-linux-22` from the release below and run it from this directory.
- On Apple silicon newer than M2, `yarn test` fails with `Unsupported platform`, because graph-cli 0.56 does not recognise the CPU. Download `binary-macos-11-m1` from the [Matchstick 0.6.0 release](https://github.com/LimeChain/matchstick/releases/tag/0.6.0), the version `yarn test` uses, and run it from this directory instead.
