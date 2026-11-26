# Ajna v3 Subgraph

Subgraph for the Ajna v3 contracts ([ajna-finance/ajna-v3](https://github.com/ajna-finance/ajna-v3)). It is a separate package from the v2 subgraph in the repository root: it has its own manifest, schema, ABIs, mappings and tests, and shares no code with it.

If you query the v2 subgraph today, [MIGRATING.md](./MIGRATING.md) says what changes.

## Status

The subgraph indexes:

- pool factories, pools and their tokens
- buckets and lenders' positions in them (`AddQuoteToken`, `MoveQuoteToken`, `RemoveQuoteToken`, `AddCollateral`, `RemoveCollateral`)
- LP transfers, allowances and approved transferors
- loans (`DrawDebt`, `RepayDebt`, `MoveLoan`, `ImproveLoan`, `LoanClosed`, `LoanCalled`) and borrower delegates
- the lender exit queue (`MarkQuoteForWithdrawal`, `ExitQueueFunded`, and claims from escrow)
- surplus auctions of quote and of collateral (`KickQuoteSurplusAuction`, `TakeQuoteSurplus`, `KickCollateralSurplusAuction`, `TakeCollateralSurplus`)
- flashloans, interest rate changes and interest update failures
- PositionManager positions and the LP they hold in each bucket (`Mint`, `MemorializePosition`, `MoveLiquidity`, `RedeemPosition`, `Burn`), with the NFT's transfers and approvals

Every event of the pool factory, the pool and the PositionManager is handled. graph-node v0.45.0 has indexed the subgraph twice, and both times what it served matched the chain:

- over a local chain that drives the contracts through every event, and then attacks the indexer with hostile tokens and arguments: see [Integration](#integration)
- over the Sepolia deployment in `config/sepolia.json`, which by then had three deposits and two loans: see [Deploying](#deploying)

Both ran on a graph-node on a development machine. The subgraph is not hosted anywhere yet.

## Setup

```
yarn install
yarn configure sepolia
yarn codegen
yarn build
yarn test
```

`yarn configure <network>` reads `config/<network>.json` and writes `subgraph.yaml` and `src/config/deployments.ts`. Neither file is committed, so run it after cloning and whenever you switch networks. Run `yarn codegen` again afterwards.

The tests run against whichever config was rendered last and cover every deployment in it. CI runs them with `tests/fixtures/two-factories.json`. The recorded chain in `tests/recorded/` needs that fixture's two deployments, and skips itself under any other config.

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
- Deploy the two reader contracts before the factory. A pool event indexed in a block where a reader has no code yet does not stop the subgraph, but what it would have read is missing until a later event: see [When a reader cannot be read](#when-a-reader-cannot-be-read). `yarn configure` does not check the order.

Mappings must not assume a network has one factory, PositionManager or reader contract. `src/utils/deployments.ts` finds the deployment for the address that emitted an event, or for a pool through the pool's factory.

## Design

### Where state comes from

`Pool`, `Bucket`, `Lend`, `Loan` and `PositionLend` are set from contract reads, not from event amounts. A read made while handling an event returns state as of the end of that event's block, so:

- these entities always hold end-of-block state, and events in the same block write the same values
- the pool, each bucket, each loan and each position's LP in a bucket are read at most once per block
- a loan that is repaid, moved or called later in the block it opens in already reads as closed when its `DrawDebt` is handled
- `updatedAtBlockNumber` says which block an entity was last read at. Interest accrues between events, so a value can be older than the block you query.

The entity that records an event (`AddQuoteToken`, `DrawDebt` and so on) keeps that event's own amounts.

Some values are added up from events instead, because the contract changes them by exactly an event's amount and nowhere else:

- on the pool: `txCount`, the flashloan totals, `interestUpdateFailures`, `pledgedCollateral`, `lenderCollateral` and `totalAjnaBurned`. `loansCount` follows the loans' status. The two collateral totals are tested against the contracts: see [Event totals](#event-totals).
- surplus auctions: every `SurplusAuction`.
- the exit queue: a bucket's `queueHead`, `queueTail`, `escrowQuote` and `escrowCollateral`, and every `ExitQueuePlace`. These are right after each event, not only at the end of the block.
- LP allowances.
- positions: a `Position`'s pool and owner, and a `PositionManager`'s `positionCount`.

### Precision

`BigDecimal` keeps 34 significant digits, which is exact for any amount below 1e16 whole units. Where the subgraph itself must tell when an amount reaches zero, it also stores the contract's exact integer (1e18 per unit) in a field ending in `Wad` and does its arithmetic on that: `ExitQueuePlace.lpbWad` and `queueStartWad`, and `LPAllowance.amountWad`. Totals added up from events in `BigDecimal`, such as a bucket's escrow, can be off in the last digit only when amounts exceed that size.

### When a reader cannot be read

Pools, buckets and lends are read through the `PoolInfoUtils` contracts. A read can fail in two cases: after the pool emits `InterestUpdateFailure`, when the readers' interest projection can revert for that pool, and in a block before the reader was deployed. The event is always recorded, and no handler stops, because the subgraph could not get past that block.

- **Pool.** Keeps its last state, and its `updatedAtBlockNumber` does not advance. Two things still move: `t0debt`, which is read from the pool itself, and the borrow and lend rates when an `UpdateInterestRate` arrives.
- **Bucket.** Keeps its last state apart from `t0debt`, which is also read from the pool itself. A bucket that did not exist yet is created with a zero price, deposit, collateral, LP and exchange rate, and an `updatedAtBlockNumber` of 0, because the event's entity points at it.
- **Lend.** Left as it is. One that did not exist yet is not created.

Each catches up at the next event that names it. Loans and positions are read from the pool and the PositionManager themselves, and are not affected.

### Tokens

Anyone can deploy a pool for any token, so a token is a contract that may answer anything. A handler that aborts on an answer stops the subgraph, for every pool. So a `Token` holds:

- **`decimals`**: those the token reported to the factory, worked out from the scale its first pool keeps for it. Always 0 to 18. The token itself is not asked: asked again, it can say something else, including a number too large to convert, which aborts the handler.
- **`name` and `symbol`**: what the token answered in the block its first pool was created in, as a string or as a bytes32, cut to 128 characters. A token can return megabytes, which would be stored and served with every pool that names it. `unknown` if it gave neither.

A token can also make the reader contracts revert for its own pool, by reverting on `balanceOf` for example. That pool is then one whose readers cannot be read, as above. No other pool is affected.

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

### Surplus auctions

A pool sells its surplus quote and its surplus collateral in two separate auctions, each for AJNA that is burned. A `SurplusAuction` has a `kind` of `Quote` or `Collateral`, and the two kinds run independently.

- **Kick.** Anyone can kick an auction of a kind once five days have passed since that kind's last kick. The kick fixes the `lot`: the surplus claimable at that moment plus `rolledOver`, what the previous auction of the kind left unsold.
- **Price.** The whole lot starts at 1,000,000,000 AJNA, so `startingPrice` is that divided by the lot, and the price halves every hour.
- **Takes.** Takes are accepted for 72 hours after the kick. Each one lowers `lotRemaining` and adds to `ajnaBurned`. Whether an auction is still open depends on the time, so it is not stored: compare `kickTime` with the block timestamp.
- **Identity.** An auction's id is the pool address, its kind and its kick time. `Pool.quoteSurplusAuction` and `Pool.collateralSurplusAuction` point at the latest of each kind, and every take belongs to the latest kick of its kind.

`Pool.quoteSurplus`, `quoteSurplusClaimable` and `quoteSurplusLotRemaining`, and the three collateral fields, are the pool's own reading of its surplus when it was last refreshed.

The kick and take events of the two kinds have the same shape and are stored as `SurplusAuctionKick` and `SurplusAuctionTake`, with a `kind`.

### Positions

A PositionManager issues NFTs that hold LP for their owners. Each pool factory has its own manager, and each manager numbers its tokens from 1, so a `Position`'s id is the manager's address, `|`, and the token id. A position holds LP in one pool only: the pool named when it was minted.

- **Whose LP it is.** In the pool, the LP belongs to the manager. The manager's address has a `Lend` in every bucket where its positions hold LP, for all of them together. A `PositionLend` is one position's part of it.
- **Memorialize, redeem, move.** `MemorializePosition` moves all of the owner's LP in the buckets named into the position. `RedeemPosition` returns all of the position's LP in the buckets named to the owner. `MoveLiquidity` moves the position's quote from one bucket to another.
  - A memorialize lists every bucket passed to the call. A bucket where the owner held no LP is listed too, and changes nothing.
  - A move takes only quote that is not lent out, so it can leave LP in the bucket it moves from.
- **How LP is read.** None of these events says how much LP the position holds afterwards. Each `PositionLend` an event names is read from the manager, at most once per block, and removed when the position has no LP left in the bucket.
- **Value.** `lpbValueInQuote` is `lpb` times the bucket's `exchangeRate` when the `PositionLend` was last refreshed, rounded down, and zero if the bucket held neither quote nor collateral. The bucket is refreshed more often than the `PositionLend`, so multiply `lpb` by `bucket.exchangeRate` for a newer value.
- **Owner.** `Position.owner` follows the NFT's transfers. A mint and a burn emit an ERC721 `Transfer` as well; they are recorded as `Mint` and `Burn`, and a `Transfer` entity is always a transfer from one holder to another.
- **Burn.** A burned position is removed. The events about it stay, and name it by `positionManager` and `tokenId`. `Burn.lender` is the address that burned it, which can be an address approved for it, and `Burn.owner` is its owner.
- **Approvals.** `Approval` and `ApprovalForAll` are recorded as events only. Who may manage a position now is not stored, because a transfer or a burn clears a position's approved address without an event: read `getApproved` and `isApprovedForAll` from the manager.
- **Token URI.** Not stored. The manager builds it on chain from the owner and the pool's token symbols: read `tokenURI` from the manager.

The pool emits its own events in the same calls, with the manager as the lender (`TransferLP`, `MoveQuoteToken`, `IncreaseLPAllowance`). `Pool.txCount` counts those, and `Mint`, `MemorializePosition`, `MoveLiquidity`, `RedeemPosition` and `Burn` count for the owner's `Account.txCount`. A transfer or an approval of the token changes who holds or may use it and is not counted.

### Retention

A `Lend` is removed when the lender has no LP left in the bucket, and an `ExitQueuePlace` when its last LP is claimed. A `BorrowerDelegate`, `LPAllowance` or `LPTransferorList` is removed when it is revoked or used up. A `PositionLend` is removed when the position has no LP left in the bucket, and a `Position` when its NFT is burned. Pools, buckets, loans and surplus auctions are kept: a closed loan stays, with the bucket and expiry it had.

### Differences from the v2 schema

The v2 subgraph's Ajna token, grant fund and burn wrapper entities are not part of this subgraph.

| Entity | Change |
| ------ | ------ |
| `PoolFactory` | Adds `loanTerm` and the derived `positionManagers`. `pools` is derived. `poolType` and `txCount` are gone. |
| `Pool` | Adds `factory`, `loanTerm`, `debt`, `rateAtTarget`, `utilization`, `escrowedQuote`, `availableQuote`, `lenderCollateral`, the six surplus fields, `interestUpdateFailures` and `updatedAt*`. `t0debt` now holds t0 debt (v2 stored the debt there). `loansCount` counts loans with debt. `reserveAuctions` is replaced by `surplusAuctions`, `quoteSurplusAuction` and `collateralSurplusAuction`. Prices (`hpb`, `htp`, `lup`), fees, reserves, burn epoch, bonds, liquidations, `totalInterestEarned`, `maxBorrower`, `minDebtAmount`, `actualUtilization`, `targetUtilization`, `poolType` and the ERC721 fields are gone. |
| `Pool.txCount`, `Token.txCount`, `Account.txCount` | Count actions. `UpdateInterestRate`, `InterestUpdateFailure`, `LoanClosed`, `ImproveLoan` and `ExitQueueFunded` are emitted as part of another action and are not counted. An account's count covers its actions as a lender, kicker or taker, and every action on its loans and positions, including a call, a move or a burn by someone else, but not a position's transfers and approvals. A lender's actions include setting LP allowances and transferors. `TransferLP` counts for the pool but for no account: the event names the two lenders, not the caller. Position events do not add to a pool's or a token's count: the pool's own events in the same call do. |
| `Token` | `pools` is split into the derived `poolsAsCollateral` and `poolsAsQuote`. `tokenType` and `totalSupply` are gone. `decimals` comes from the pool and is always 0 to 18; `name` and `symbol` are cut to 128 characters: see [Tokens](#tokens). |
| `Bucket` | `lends` and `positionLends` are derived. Adds `t0debt`, `loans`, `queueHead`, `queueTail`, `escrowQuote`, `escrowCollateral`, `exitQueuePlaces` and `updatedAt*`. `deposit`, `collateral` and `lpb` exclude what the exit queue has moved to escrow. |
| `Lend` | Adds `account`, `marked`, `liveLpb`, `fundedValueInQuote` and `updatedAt*`. `lpbValueInQuote` includes LP the exit queue has funded. |
| `ExitQueuePlace` | New. |
| `Loan` | One per loan id, no longer one per borrower, and kept after it closes. The id is the pool address, `|`, and the loan id. Adds `loanId`, `counter`, `account`, `bucket`, `bucketIndex`, `status`, `t0Tp`, `inflatorAtDraw`, `expiry`, `movedFrom`, `movedTo`, `call` and the created, closed and updated blocks. `inLiquidation`, `liquidationAuction`, `t0Np` and `tokenIdsPledged` are gone. |
| `Account` | `lends`, `loans`, `exitQueuePlaces` and `positions` are derived. `pools` and the liquidation, reserve auction and grant fields are gone. |
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
| `SurplusAuction` | Replaces `ReserveAuction`. One per kick, of either kind, identified by its kick time instead of a burn epoch. Has `kind`, `token`, `kicker`, `kickTime`, `lot`, `rolledOver`, `startingPrice`, `lotRemaining`, `lastTakePrice` and `ajnaBurned`; `takes` is derived. |
| `SurplusAuctionKick`, `SurplusAuctionTake` | Replace `ReserveAuctionKick` and `ReserveAuctionTake`. Their ids are the transaction hash and log index, so several in one transaction no longer collide. The kicker and taker come from the event, not from the transaction's sender. |
| `PositionManager` | New, one per manager, with its `factory` and `positionCount`. v2 kept a `Token` for its single manager. |
| `Position` | The id is the manager's address, `|`, and the token id; v2 used the token id alone. Adds `positionManager`, `account` and the created block. `lends` is derived and replaces the `indexes` array. `token` and `tokenURI` are gone. |
| `PositionLend` | The id is the position's id, `|`, and the bucket index. Adds `position`, `pool` and `updatedAt*`. `tokenId` is gone: use `position`. `lpbValueInQuote` is worked out from the bucket's exchange rate, not read from the pool. |
| `Mint`, `Burn`, `MemorializePosition`, `RedeemPosition`, `MoveLiquidity`, `Approval`, `ApprovalForAll` | Add `positionManager`. `Burn` and `Approval` add `pool`, and `Burn` adds `owner`. `MoveLiquidity` adds `from`, `to`, `lpRedeemedFrom` and `lpAwardedTo`. `MemorializePosition.indexes` includes buckets where nothing was memorialized. |
| `Transfer` | Adds `positionManager`. `token` is gone. Only transfers between holders are stored: v2 also stored the transfer of a mint and of a burn. |

## Deploying

To a graph-node that indexes the network, with its admin and IPFS endpoints:

```
yarn configure <network>
yarn codegen
yarn build
yarn graph create --node <admin URL> ajna-v3
yarn graph deploy --node <admin URL> --ipfs <IPFS URL> ajna-v3
```

- **The graph-node's network name** must be the `network` in `config/<network>.json`.
- **The endpoint must be an archive node.** Every handler reads the contracts at the block of its event. An endpoint that has pruned that block's state answers with an error, not a revert, and graph-node retries the read for ever: the subgraph stays healthy and never advances. A public Sepolia endpoint that keeps about 10,000 blocks of state did exactly that at the pool's first event.
- **Check the result against the chain:**

  ```
  RPC_URL=<archive endpoint> node integration/reconcile.js <subgraph query URL> config/<network>.json
  ```

  This makes the checks described under [A graph-node](#a-graph-node), at the last block the subgraph has indexed. On Sepolia, after three deposits and two loans, 120 final-state checks and 61 refreshed fields agreed.

To try a network on a local graph-node first, start the one in `integration/docker-compose.yml` pointed at it, then deploy as above with `http://localhost:8020` and `http://localhost:5001`:

```
CHAIN_NETWORK=<network> CHAIN_RPC=<archive endpoint> ./scripts/local-graph-node.sh up
```

### Contract reads

Indexing costs one `eth_call` for each contract read, and reads decide how fast the subgraph syncs. Over the local chain's 175 events graph-node made 411, about 2.3 an event:

| Reads | Share | Made |
| --- | --- | --- |
| A pool's totals, rates, balances and surplus | 37% | three reads, once a block for each pool with an event |
| A bucket | 30% | two reads, once a block for each bucket an event names |
| A lender's position in a bucket | 20% | one or two reads, once a block for each lender an event names |
| A loan | 6% | one read, once a block for each loan an event names |
| A position's LP in a bucket | 3% | one read for each bucket a position event names |
| Tokens, their scales in the pool, and loan terms | 3% | once each |

Nothing is read twice in a block, and a `TransferLP` that moved no LP reads nothing. The next step, if syncing a busy network proves slow, is to declare these reads in the manifest so that graph-node makes them in parallel before the handler runs. That needs a newer `specVersion` and graph-cli than this package pins, and a pool template for each factory, because a declared read's contract address is fixed in the manifest and each factory has its own readers.

## ABIs

`abis/` holds the ABIs of the five Ajna contracts the subgraph reads. `abis/ajna-v3.lock.json` records the ajna-v3 commit they were built from. `abis/tokens/` holds two small hand-written ABIs for reading a token's name, symbol and decimals. To move the Ajna ABIs to another commit:

```
./scripts/copy-abis.sh <path to an ajna-v3 checkout at that commit>
yarn configure <network>
```

The script runs `forge build` in the checkout, so it needs Foundry and `jq`. `yarn configure` then fails if an ABI has an event without a handler in the manifest, or the manifest names an event the ABI no longer has. An event whose signature changed stops matching without any error at indexing time, so fix every mismatch it reports before deploying.

## Event totals

`Pool.pledgedCollateral` and `Pool.lenderCollateral` are added up from five events and never read from chain:

| Event | `pledgedCollateral` | `lenderCollateral` |
| --- | --- | --- |
| `DrawDebt` | plus `collateralPledged` | |
| `RepayDebt` | minus `collateralPulled` | |
| `LoanCalled` | minus `lenderCollateral`, `callerCollateral` and `surplusCollateral` | plus `lenderCollateral` |
| `AddCollateral` | | plus `amount` |
| `RemoveCollateral` | | minus `amount` |

That is right only if the pool changes its own two totals by exactly those amounts and nowhere else. `contract-checks/SubgraphReplayInvariants.t.sol` tests it in the contracts' Foundry suite. It drives a pool through every call that touches collateral, including loan calls, loan moves, claims from exit escrow and collateral surplus auctions, with random arguments. After each call it replays the call's events with the rules above and requires both totals to equal the pool's `pledgedCollateral()` and `lenderCollateral()`.

```
./scripts/check-event-totals.sh <path to an ajna-v3 checkout at the commit in abis/ajna-v3.lock.json>
```

The script needs Foundry and `jq`, and runs the test for several quote and collateral token precisions. CI does not run it. Run it:

- after moving the ABIs to another commit
- after changing how the mappings compute either total. The test holds its own copy of the rules, so change both.

## Integration

The unit tests mock every contract read with values written by hand. Three things check the subgraph against the contracts themselves: a local chain, a recording of it that runs with the unit tests, and a graph-node indexing it.

### A local chain

`./scripts/local-chain.sh start <ajna-v3 checkout>` starts an anvil node, deploys the contracts from the checkout's build output and runs `integration/scenario.js`, which drives them through every event the subgraph handles. The checkout must be at the commit in `abis/ajna-v3.lock.json`. The scenario includes the cases the mappings were designed around:

- two factories with different loan terms, each with its own PositionManager, and the same token pair under both
- tokens of 6, 8 and 18 decimals
- a deposit made before its factory's reader contracts are deployed
- an exit queue place funded by a mark, a repayment, a loan move and a loan call, and claimed in collateral and in quote
- loans repaid, redrawn on a debt-free loan's collateral, moved, improved, and called both with and without collateral to spare
- a deposit and its withdrawal, a loan's whole life, and a position's whole life, each inside one transaction
- both surplus auctions kicked in one transaction, a partial take, and a later kick that rolls the rest over
- an LP allowance at an index that is not a bucket, and LP transfers that move nothing
- a pool whose interest can no longer be accrued, which emits `InterestUpdateFailure`

The node starts at a fixed time and the scenario fixes the time between blocks, so every run builds the same chain. The scenario fails if any event the subgraph has a handler for was not emitted.

`start` then runs `integration/hostile.js`, which does what a stranger could do to stop an indexer, for the price of a transaction each:

- a token that answers `decimals()` with 2^255 once its pool exists, and one whose name, symbol and decimals cannot be read at all
- a megabyte of name, and a symbol with a two-unit character where a careless cut would fall
- a name and a symbol that are not text
- a quote token whose `balanceOf` reverts from its pool's first deposit on
- LP allowances at indexes far past the last bucket

The token is `integration/hostile/src/HostileToken.sol`. These transactions come after the scenario's last block, so they are not in the recording; the unit tests cover the same cases with mocks. One attack is left out: a token whose calls burn all their gas. graph-node takes a node's out-of-gas error for a revert when it comes from geth, reth or nethermind, but it does not know anvil's wording, and would wait on this chain for ever.

### The recorded chain

`./scripts/local-chain.sh record <ajna-v3 checkout>` builds that chain and writes `tests/recorded/local-chain.test.ts`, a Matchstick test that needs no chain to run:

- every event, in order, with its real block, timestamp, transaction hash and log index
- every contract read a handler can make, mocked with what the chain returned at the end of the event's block, which is what a handler's read sees on a graph-node. A read that reverted, or whose contract had no code yet, reverts.
- checks of the entities against the chain's final state, worked out by `integration/expected.js` from the chain's logs and the contracts' own getters, not from the mappings

The checks cover what does not depend on when an entity was last refreshed: which entities exist, how many events were recorded, and the fields that change only through events naming the entity. That includes every value the subgraph adds up from events: the two collateral totals, the exit queue and its places, LP allowances and transferors, borrower delegates, surplus auctions and the AJNA they burned, loan status and the count of loans with debt, and positions with the LP they hold.

The recording is committed and runs with the other tests. Record it again after changing the contracts' commit or the scenario; an unchanged chain produces the same file.

### A graph-node

Matchstick does not check everything a graph-node does: that each data source lists the ABIs its handlers call, that the schema loads, or how entities are stored and queried. `scripts/local-graph-node.sh` runs graph-node v0.45.0 with the IPFS node and the Postgres it needs in Docker (`integration/docker-compose.yml`), deploys the subgraph, and compares what it serves with the chain:

```
./scripts/local-chain.sh start <ajna-v3 checkout>
./scripts/local-graph-node.sh up
./scripts/local-graph-node.sh deploy
./scripts/local-graph-node.sh reconcile
./scripts/local-graph-node.sh down
./scripts/local-chain.sh stop
```

`deploy` renders the subgraph for the local chain, builds it, deploys it and waits until it has indexed every block and is healthy. It fails, with graph-node's reason, if indexing does. `reconcile` (`integration/reconcile.js`) then makes three kinds of check:

- the recorded test's checks of the chain's final state, against the entities the graph-node serves
- for every `Pool`, `Bucket`, `Lend`, `Loan` and `PositionLend`, the fields read from the contracts, against the chain at the block the entity says it was refreshed in. These drift between events, so the recorded test cannot check them. Where the contracts offer another way to a value than the reader the mappings use, that way is taken: a token's `balanceOf` for a pool's balances, the pool's own `bucketInfo` for a bucket.
- what the subgraph must hold after the hostile transactions: each hostile token's name, symbol and decimals, the pool whose readers its token broke, and the allowances

`deploy` leaves the package configured for the local chain. Run `yarn configure <network>` and `yarn codegen` again before building for a real network or running the tests.

The IPFS node runs offline. By default it would join the public IPFS network and offer the files of every subgraph deployed to it. The containers' ports are published on this machine only: graph-node's admin port deploys subgraphs for whoever can reach it.

The graph-node container must be able to reach the chain. The default address suits Docker Desktop, and a Lima VM is described below. With Docker Engine on Linux the container reaches the host at the Docker bridge's address, where anvil does not listen unless the chain is started with `ANVIL_IP_ADDR=0.0.0.0`. That has not been run, and it opens the chain to everything that can reach the machine.

CI does not run this: it needs Docker, Foundry and the contract repository.

#### Docker in a Lima VM

On a Mac without Docker Desktop, [Lima](https://lima-vm.io) can run the Docker engine in a VM:

```
limactl start --name=ajna-graph --mount-none --rosetta template://docker
export DOCKER_HOST=unix://$HOME/.lima/ajna-graph/sock/docker.sock
export CHAIN_RPC=http://192.168.5.2:8545
```

- `--rosetta` is needed on Apple silicon: the graph-node image is published for amd64 only.
- `--mount-none` keeps the VM from seeing the Mac's files. Nothing here needs them.
- `192.168.5.2` is the Mac as a Lima VM sees it, where the local chain listens.

`limactl stop ajna-graph` stops the VM, and `limactl delete ajna-graph` removes it.

## Known issues

- A token can slow indexing down, though not stop it. Every event of its pool has the readers call it, and a call can be made to use all the gas graph-node allows a read. A node that gives up on such a call with a timeout, where geth reports it out of gas, would stall the subgraph: graph-node takes a timeout for a failure to reach the node, and asks again.
- A `TransferLP` that names thousands of buckets and moves LP costs several reads for each bucket.
- On Linux, `yarn test` works on Ubuntu 22.04 only. graph-cli 0.56 asks for the Matchstick binary built for the Ubuntu version it runs on, and Matchstick 0.6.0 is published for Ubuntu 22 alone. On another version, download `binary-linux-22` from the release below and run it from this directory.
- On Apple silicon newer than M2, `yarn test` fails with `Unsupported platform`, because graph-cli 0.56 does not recognise the CPU. Download `binary-macos-11-m1` from the [Matchstick 0.6.0 release](https://github.com/LimeChain/matchstick/releases/tag/0.6.0), the version `yarn test` uses, and run it from this directory instead.
