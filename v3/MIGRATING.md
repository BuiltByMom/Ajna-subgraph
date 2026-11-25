# Moving from the v2 subgraph

The v3 subgraph is a separate deployment with its own schema. It follows the v3 contracts, which have no liquidation auctions, no fees and no pool-wide prices, and give each borrower any number of loans. This note covers what a consumer of the v2 subgraph has to change. The [README](./README.md#differences-from-the-v2-schema) lists every field that was added or removed.

## What changes for every query

- **One subgraph per network.** It covers every pool factory on the network. Each factory has its own loan term, and `pool.loanTerm` and `pool.factory` say which a pool belongs to. A token pair can have one pool under each factory.
- **Filter on fields, do not build ids.** Ids are raw bytes joined with separators, and several changed. Every entity can be found by its fields: a bucket by `pool` and `bucketIndex`, a lend by `pool`, `bucketIndex` and `lender`, a loan by `pool` and `loanId`, a position by `positionManager` and `tokenId`.
- **Addresses are lowercase** in filters, as before.
- **State is as of the end of a block.** `Pool`, `Bucket`, `Lend`, `Loan` and `PositionLend` are read from the contracts when an event names them, and `updatedAtBlockNumber` says when. Interest accrues in between.
- **Debt is in t0 terms.** `pool.t0debt`, `bucket.t0debt` and `loan.t0debt` do not change as interest accrues. Multiply by `pool.inflator` for the debt owed. In v2, `pool.t0debt` held the debt itself; that is now `pool.debt`.

## What replaces what

| v2 | v3 |
| --- | --- |
| `pool.lup`, `hpb`, `htp` and their indexes | Gone. A loan is priced by its own bucket: `loan.bucket.bucketPrice`. |
| `pool.reserves`, `claimableReserves`, `claimableReservesRemaining` | `quoteSurplus`, `quoteSurplusClaimable`, `quoteSurplusLotRemaining`, and the same three for collateral |
| `pool.actualUtilization`, `targetUtilization` | `utilization`. The target is a constant of the rate curve. |
| `pool.borrowFeeRate`, `depositFeeRate`, `minDebtAmount`, `maxBorrower`, `totalInterestEarned` | Gone |
| `pool.reserveAuctions`, `burnEpoch`, `ReserveAuction` | `pool.surplusAuctions`, with `quoteSurplusAuction` and `collateralSurplusAuction` pointing at the latest of each kind. A `SurplusAuction` is identified by its kick time. |
| `ReserveAuctionKick`, `ReserveAuctionTake` | `SurplusAuctionKick`, `SurplusAuctionTake`, each with a `kind` |
| `pool.liquidationAuctions`, `totalBondEscrowed`, `loan.inLiquidation`, `loan.liquidationAuction` | Gone. A loan that expires or falls under 1.05 collateralization is called in one step: `LoanCalled`, and `loan.call`. |
| `Kick`, `Take`, `BucketTake`, `Settle`, `AuctionSettle`, `BondWithdrawn`, `LoanStamped`, `BucketBankruptcy` | Gone |
| One `Loan` per borrower in a pool, removed when repaid | One per loan id, kept after it closes. Filter on `status`: `Active`, `DebtFree` or `Closed`. |
| `loan.t0Np` | Gone. `loan.expiry` and `loan.bucket` decide when a loan can be called. |
| `account.pools`, `kicks`, `takes`, `settles`, `reserveAuctions` | Gone. `account.lends`, `loans`, `positions` and `exitQueuePlaces` remain or are new. |
| `position(id: <token id>)`, `position.indexes` | `positions(where: { positionManager, tokenId })`, `position.lends`. Each factory has its own PositionManager, and token ids repeat across them. |
| `position.tokenURI` | Not stored. Read it from the PositionManager. |
| Withdrawing from a bucket whose quote is lent out | New: the exit queue. `ExitQueuePlace`, the bucket's `queueHead`, `queueTail`, `escrowQuote` and `escrowCollateral`, and `isExitClaim` on `RemoveQuoteToken` and `RemoveCollateral`. |
| `lup` on `AddQuoteToken`, `MoveQuoteToken`, `RemoveQuoteToken`, `DrawDebt`, `RepayDebt` | Gone |
| ERC721 pools, the grant fund, the AJNA token, the burn wrapper | Not in this subgraph |

## Queries

Each of these runs against the v3 schema. Replace the addresses and numbers with your own.

Pools, with the term of their loans:

```graphql
{
  pools(orderBy: createdAtBlockNumber) {
    id
    loanTerm
    txCount
    collateralToken { symbol decimals }
    quoteToken { symbol decimals }
  }
}
```

One pool. `debt`, `poolSize`, the rates and the surplus are as of `updatedAtBlockNumber`:

```graphql
{
  pool(id: "0x06cd7788d77332cf1156f1e327ebc090b5ff16a3") {
    poolSize
    debt
    t0debt
    inflator
    utilization
    borrowRate
    lendRate
    loansCount
    pledgedCollateral
    lenderCollateral
    quoteSurplus
    quoteSurplusClaimable
    collateralSurplus
    totalAjnaBurned
    updatedAtBlockNumber
  }
}
```

A lender's positions in every pool, with any place they hold on an exit queue:

```graphql
{
  account(id: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8") {
    lends {
      pool { id }
      bucketIndex
      lpb
      lpbValueInQuote
      marked
      bucket { bucketPrice exchangeRate queueHead }
    }
    exitQueuePlaces {
      pool { id }
      bucketIndex
      queueStart
      lpb
    }
  }
}
```

The part of a place below the bucket's `queueHead` has been funded and can be claimed: `min(lpb, max(0, queueHead - queueStart))`.

The loans of a pool that still have debt, as a keeper needs them. A loan can be called once the block timestamp is past `expiry`, or while `collateralPledged * bucket.bucketPrice` is less than 1.05 times `t0debt * pool.inflator`:

```graphql
{
  loans(where: { pool: "0x06cd7788d77332cf1156f1e327ebc090b5ff16a3", status: Active }, orderBy: expiry) {
    loanId
    borrower
    expiry
    t0debt
    collateralPledged
    bucket { bucketIndex bucketPrice }
    pool { inflator }
  }
}
```

The same, for loans already past their term at a given time:

```graphql
{
  loans(where: { status: Active, expiry_lt: "1760000000" }) {
    pool { id }
    loanId
    expiry
  }
}
```

Everything a borrower has borrowed in a pool, open or closed, and how each loan ended:

```graphql
{
  loans(where: { pool: "0x06cd7788d77332cf1156f1e327ebc090b5ff16a3", borrower: "0x90f79bf6eb2c4f870365e785982e1f101e93b906" }, orderBy: counter) {
    loanId
    status
    bucketIndex
    t0debt
    collateralPledged
    movedFrom { loanId }
    call { caller debt lenderCollateral callerCollateral surplusCollateral }
    closedAtTimestamp
  }
}
```

A pool's latest surplus auction of each kind. Takes are accepted for 72 hours after `kickTime`, and the price halves every hour from `startingPrice`:

```graphql
{
  pool(id: "0x06cd7788d77332cf1156f1e327ebc090b5ff16a3") {
    quoteSurplusAuction { kickTime lot lotRemaining startingPrice lastTakePrice ajnaBurned }
    collateralSurplusAuction { kickTime lot lotRemaining startingPrice lastTakePrice ajnaBurned }
  }
}
```

The NFT positions an address owns, with the LP each holds:

```graphql
{
  positions(where: { owner: "0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f" }) {
    tokenId
    positionManager { id }
    pool { id }
    lends {
      bucketIndex
      lpb
      lpbValueInQuote
      depositTime
    }
  }
}
```

One position by its token id. The PositionManager's address is needed too:

```graphql
{
  positions(where: { positionManager: "0x0b306bf915c4d645ff596e518faf3f9669b97016", tokenId: "1" }) {
    owner
    pool { id }
    lends { bucketIndex lpb }
  }
}
```

A pool's most recent loan calls:

```graphql
{
  loanCalleds(where: { pool: "0x06cd7788d77332cf1156f1e327ebc090b5ff16a3" }, orderBy: blockNumber, orderDirection: desc, first: 20) {
    loan { loanId }
    borrower
    caller
    debt
    lenderCollateral
    callerCollateral
    surplusCollateral
    blockTimestamp
  }
}
```
