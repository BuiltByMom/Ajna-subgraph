// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import { Test, Vm }     from '@std/Test.sol';
import { StdInvariant } from '@std/StdInvariant.sol';

import { ERC20Pool }              from 'src/ERC20Pool.sol';
import { ERC20PoolFactory }       from 'src/ERC20PoolFactory.sol';
import { PoolInfoUtils }          from 'src/PoolInfoUtils.sol';
import { DEPOSIT_MATURITY_EPOCH } from 'src/libraries/helpers/PoolHelper.sol';

import { Token, TokenWithNDecimals } from '../../utils/Tokens.sol';

/**
 *  @dev Checks the Ajna v3 subgraph's event accounting against the pool.
 *
 *       The subgraph does not read `Pool.pledgedCollateral` and `Pool.lenderCollateral` from the chain. It adds them
 *       up from five events (v3/src/mappings/erc-20-pool.ts in the Ajna-subgraph repository):
 *
 *         AddCollateral     lenderCollateral  += amount
 *         RemoveCollateral  lenderCollateral  -= amount
 *         DrawDebt          pledgedCollateral += collateralPledged
 *         RepayDebt         pledgedCollateral -= collateralPulled
 *         LoanCalled        pledgedCollateral -= lenderCollateral + callerCollateral + surplusCollateral
 *                           lenderCollateral  += lenderCollateral
 *
 *       This handler drives a pool through every action that touches collateral, replays the events of each call
 *       that succeeded with exactly those rules, and requires the two totals to equal the pool's own after every call.
 *
 *       Every pool call goes through `_exec`, which records the call's logs and replays them only if the call
 *       succeeded: forge's recorded logs include those of a call that reverted.
 *
 *       Run by scripts/check-event-totals.sh in that repository. With `SG_TRACE=true`, every case reached is
 *       appended to the file named by `SG_TRACE_FILE` (`sg-trace.log` in the checkout), to count what a run covered.
 */
contract SubgraphReplayHandler is Test {

    ERC20Pool          public immutable pool;
    PoolInfoUtils      public immutable utils;
    TokenWithNDecimals public immutable quote;
    TokenWithNDecimals public immutable collateral;
    uint256            public immutable quoteScale;
    uint256            public immutable collateralScale;

    address[] public actors;
    bytes32[] public loanIds;

    // holds no tokens and has approved nothing: the pool emits its event, then reverts on the transfer
    address public immutable pauper = makeAddr("pauper");

    // prices of roughly 3000, 1 and 0.025 quote per collateral, so collateral amounts differ by orders of magnitude
    uint256[3] public bucketIndexes = [uint256(2550), 4156, 4900];

    // the handler's own clock: time and block number must not go back between calls
    uint256 public clock;
    uint256 public blockNo;

    // The totals as the subgraph computes them. Signed, so that a rule taking off too much shows as a mismatch.
    int256 public sgPledged;
    int256 public sgLender;

    // how often each case was reached
    mapping(string => uint256) public seen;
    bool   internal trace;
    string internal traceFile;

    bytes32 internal constant ADD_COLLATERAL    = keccak256("AddCollateral(address,uint256,uint256,uint256)");
    bytes32 internal constant REMOVE_COLLATERAL = keccak256("RemoveCollateral(address,uint256,uint256,uint256)");
    bytes32 internal constant DRAW_DEBT         = keccak256("DrawDebt(address,bytes32,uint256,uint256,uint256)");
    bytes32 internal constant REPAY_DEBT        = keccak256("RepayDebt(address,bytes32,uint256,uint256,uint256)");
    bytes32 internal constant LOAN_CALLED       = keccak256("LoanCalled(bytes32,address,uint256,uint256,uint256,uint256)");
    // counted only, to show what the run reached
    bytes32 internal constant EXIT_QUEUE_FUNDED = keccak256("ExitQueueFunded(uint256,uint256,uint256,uint256,uint256)");
    bytes32 internal constant MOVE_LOAN         = keccak256("MoveLoan(address,bytes32,bytes32,uint256,uint256,uint256,uint256)");
    bytes32 internal constant IMPROVE_LOAN      = keccak256("ImproveLoan(address,bytes32,bytes32)");
    bytes32 internal constant LOAN_CLOSED       = keccak256("LoanClosed(address,bytes32,bool)");
    bytes32 internal constant TAKE_COLLATERAL   = keccak256("TakeCollateralSurplus(address,uint256,uint256,uint256,uint256)");
    bytes32 internal constant KICK_COLLATERAL   = keccak256("KickCollateralSurplusAuction(address,uint256,uint256,uint256)");
    bytes32 internal constant INTEREST_FAILURE  = keccak256("InterestUpdateFailure()");

    constructor(ERC20Pool pool_, TokenWithNDecimals quote_, TokenWithNDecimals collateral_, Token ajna_) {
        pool            = pool_;
        utils           = new PoolInfoUtils();
        quote           = quote_;
        collateral      = collateral_;
        quoteScale      = pool_.quoteTokenScale();
        collateralScale = pool_.collateralScale();

        for (uint256 i = 0; i < 4; ++i) {
            address account = makeAddr(string.concat("actor", vm.toString(i)));
            actors.push(account);
            quote_.mint(account, 1e40 / quoteScale);
            collateral_.mint(account, 1e40 / collateralScale);
            ajna_.mint(account, 1e40);
            vm.startPrank(account);
            quote_.approve(address(pool_), type(uint256).max);
            collateral_.approve(address(pool_), type(uint256).max);
            ajna_.approve(address(pool_), type(uint256).max);
            vm.stopPrank();
        }

        clock     = block.timestamp;
        blockNo   = block.number;
        trace     = vm.envOr("SG_TRACE", false);
        traceFile = vm.envOr("SG_TRACE_FILE", string("sg-trace.log"));
    }

    modifier tick() {
        vm.warp(clock);
        vm.roll(blockNo);
        _;
        clock   = vm.getBlockTimestamp();
        blockNo = vm.getBlockNumber();
    }

    /**************/
    /*** Replay ***/
    /**************/

    function _note(string memory label_) internal {
        ++seen[label_];
        if (trace) vm.writeLine(traceFile, label_);
    }

    /// @dev The subgraph's rules. Only events of the pool are replayed: the subgraph indexes pools alone.
    function _replay(Vm.Log[] memory logs_) internal {
        for (uint256 i = 0; i < logs_.length; i++) {
            if (logs_[i].emitter != address(pool) || logs_[i].topics.length == 0) continue;
            bytes32 topic = logs_[i].topics[0];

            if (topic == ADD_COLLATERAL) {
                (uint256 amount, ) = abi.decode(logs_[i].data, (uint256, uint256));
                sgLender += int256(amount);
                _note("AddCollateral");
            } else if (topic == REMOVE_COLLATERAL) {
                (uint256 amount, ) = abi.decode(logs_[i].data, (uint256, uint256));
                sgLender -= int256(amount);
                _note("RemoveCollateral");
            } else if (topic == DRAW_DEBT) {
                (uint256 amountBorrowed, uint256 collateralPledged) = abi.decode(logs_[i].data, (uint256, uint256));
                sgPledged += int256(collateralPledged);
                _note("DrawDebt");
                if (amountBorrowed != 0)    _note("DrawDebt.borrow");
                if (collateralPledged != 0) _note("DrawDebt.pledge");
            } else if (topic == REPAY_DEBT) {
                (uint256 quoteRepaid, uint256 collateralPulled) = abi.decode(logs_[i].data, (uint256, uint256));
                sgPledged -= int256(collateralPulled);
                _note("RepayDebt");
                if (quoteRepaid != 0)      _note("RepayDebt.repay");
                if (collateralPulled != 0) _note("RepayDebt.pull");
            } else if (topic == LOAN_CALLED) {
                (, uint256 lenderCollateral, uint256 callerCollateral, uint256 surplusCollateral) =
                    abi.decode(logs_[i].data, (uint256, uint256, uint256, uint256));
                sgPledged -= int256(lenderCollateral) + int256(callerCollateral) + int256(surplusCollateral);
                sgLender  += int256(lenderCollateral);
                _note("LoanCalled");
                if (lenderCollateral != 0)  _note("LoanCalled.lender");
                if (callerCollateral != 0)  _note("LoanCalled.caller");
                if (surplusCollateral != 0) _note("LoanCalled.surplus");
            }
            else if (topic == EXIT_QUEUE_FUNDED) {
                (, , uint256 fundedCollateral, ) = abi.decode(logs_[i].data, (uint256, uint256, uint256, uint256));
                _note("ExitQueueFunded");
                if (fundedCollateral != 0) _note("ExitQueueFunded.collateral");
            }
            else if (topic == MOVE_LOAN)        _note("MoveLoan");
            else if (topic == IMPROVE_LOAN)     _note("ImproveLoan");
            else if (topic == LOAN_CLOSED)      _note("LoanClosed");
            else if (topic == TAKE_COLLATERAL)  _note("TakeCollateralSurplus");
            else if (topic == KICK_COLLATERAL)  _note("KickCollateralSurplusAuction");
            else if (topic == INTEREST_FAILURE) _note("InterestUpdateFailure");
        }
    }

    /// @dev One call to the pool as `actor_`. Its events count only if it succeeded, as they do on chain.
    function _exec(address actor_, bytes memory data_) internal returns (bool ok_, bytes memory ret_) {
        vm.recordLogs();
        vm.prank(actor_);
        (ok_, ret_) = address(pool).call(data_);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        if (ok_) {
            _replay(logs);
        } else {
            _note("revert");
            // the reverted call's logs were recorded all the same: this is what `ok_` keeps out of the totals
            for (uint256 i = 0; i < logs.length; i++) {
                if (logs[i].emitter != address(pool) || logs[i].topics.length == 0) continue;
                bytes32 topic = logs[i].topics[0];
                if (topic == ADD_COLLATERAL || topic == DRAW_DEBT || topic == REPAY_DEBT) _note("revert.afterCollateralEvent");
            }
        }

        assertTotals();
    }

    /// @dev **SG1**, **SG2**: the totals added up from events equal the pool's.
    function assertTotals() public view {
        require(sgPledged == int256(pool.pledgedCollateral()), "SG1: replayed pledgedCollateral differs from the pool's");
        require(sgLender  == int256(pool.lenderCollateral()),  "SG2: replayed lenderCollateral differs from the pool's");
    }

    /// @dev The pool's totals mean what the subgraph's schema says: collateral on loans, and collateral in buckets
    ///      and their exit escrow. Sums the pool's raw state over every loan and bucket this handler has used.
    function assertMeaning() external view {
        uint256 onLoans;
        for (uint256 i = 0; i < loanIds.length; i++) {
            (, , uint256 loanCollateral, , , , ) = pool.loanDetails(loanIds[i]);
            onLoans += loanCollateral;
        }
        require(onLoans == pool.pledgedCollateral(), "SG3: pledgedCollateral is not the collateral on loans");

        uint256 inBuckets;
        for (uint256 i = 0; i < 3; i++) {
            (, uint256 bucketCollateral, ) = pool.bucketInfo(bucketIndexes[i]);
            (, , , , , , uint256 escrowCollateral) = pool.lenderExit(bucketIndexes[i], address(0));
            inBuckets += bucketCollateral + escrowCollateral;
        }
        require(inBuckets == pool.lenderCollateral(), "SG4: lenderCollateral is not the collateral in buckets and escrow");
    }

    /***************/
    /*** Helpers ***/
    /***************/

    function actor(uint256 seed_) public view returns (address) {
        return actors[seed_ % actors.length];
    }

    function index(uint256 seed_) public view returns (uint256) {
        return bucketIndexes[seed_ % 3];
    }

    function loanCount() external view returns (uint256) {
        return loanIds.length;
    }

    function _borrowerOf(bytes32 loanId_) internal pure returns (address) {
        return address(uint160(uint256(loanId_) >> 96));
    }

    function _track(bytes32 loanId_) internal {
        for (uint256 i = 0; i < loanIds.length; i++) if (loanIds[i] == loanId_) return;
        loanIds.push(loanId_);
    }

    /// @dev A live loan of `borrower_` other than `except_`, with or without debt as asked; zero if there is none.
    function _otherLoan(address borrower_, bytes32 except_, bool debtFree_, uint256 seed_) internal view returns (bytes32) {
        uint256 count = loanIds.length;
        for (uint256 i = 0; i < count; i++) {
            bytes32 loanId = loanIds[(seed_ % count + i) % count];
            if (loanId == except_ || _borrowerOf(loanId) != borrower_) continue;
            (address live, uint256 t0Debt, , , , , ) = pool.loanDetails(loanId);
            if (live != address(0) && (t0Debt == 0) == debtFree_) return loanId;
        }
        return bytes32(0);
    }

    /// @dev Collateral that covers `debt_` at 1.05 in `bucket_`, with a sliver over for rounding.
    function collateralFor(uint256 debt_, uint256 bucket_) public view returns (uint256) {
        uint256 needed = debt_ * 105 / 100 * 1e18 / utils.indexToPrice(bucket_);
        return needed + needed / 1e9 + 2 * collateralScale;
    }

    /***********************/
    /*** Direct actions  ***/
    /***********************/

    // Each makes one pool call with the given arguments. The fuzzed actions below pick the arguments.

    function doDeposit(address lender_, uint256 bucket_, uint256 amount_) public tick returns (bool ok_) {
        (ok_, ) = _exec(lender_, abi.encodeCall(pool.addQuoteToken, (amount_, bucket_, vm.getBlockTimestamp())));
    }

    function doWithdraw(address lender_, uint256 bucket_, uint256 amount_) public tick returns (bool ok_) {
        (bool marked, , , , , , ) = pool.lenderExit(bucket_, lender_);
        (ok_, ) = _exec(lender_, abi.encodeCall(pool.removeQuoteToken, (amount_, bucket_)));
        if (ok_ && marked) _note("RemoveQuoteToken.exitClaim");
    }

    function doMoveQuote(address lender_, uint256 from_, uint256 to_, uint256 amount_) public tick returns (bool ok_) {
        (ok_, ) = _exec(lender_, abi.encodeCall(pool.moveQuoteToken, (amount_, from_, to_, vm.getBlockTimestamp())));
    }

    function doMark(address lender_, uint256 bucket_) public tick returns (bool ok_) {
        (ok_, ) = _exec(lender_, abi.encodeCall(pool.markQuoteForWithdrawal, (bucket_)));
        if (ok_) _note("MarkQuoteForWithdrawal");
    }

    function doAddCollateral(address lender_, uint256 bucket_, uint256 amount_) public tick returns (bool ok_) {
        (ok_, ) = _exec(lender_, abi.encodeCall(pool.addCollateral, (amount_, bucket_, vm.getBlockTimestamp())));
    }

    function doRemoveCollateral(address lender_, uint256 bucket_, uint256 amount_) public tick returns (bool ok_) {
        (bool marked, , , , , , ) = pool.lenderExit(bucket_, lender_);
        bytes memory ret;
        (ok_, ret) = _exec(lender_, abi.encodeCall(pool.removeCollateral, (amount_, bucket_)));
        if (!ok_) return false;

        (uint256 removed, ) = abi.decode(ret, (uint256, uint256));
        if (marked) _note(removed != 0 ? "RemoveCollateral.exitClaim.paid" : "RemoveCollateral.exitClaim.zero");
        else        _note("RemoveCollateral.ordinary");
    }

    /// @dev Borrowing always opens a loan. `closing_`, if not zero, is a debt-free loan whose collateral it takes over.
    function doDraw(
        address borrower_,
        uint256 bucket_,
        uint256 amount_,
        uint256 pledge_,
        bytes32 closing_
    ) public tick returns (bytes32 loanId_) {
        (bool ok, bytes memory ret) = _exec(
            borrower_,
            abi.encodeCall(pool.drawDebt, (borrower_, amount_, bucket_, pledge_, closing_))
        );
        if (!ok) return bytes32(0);

        (, loanId_) = abi.decode(ret, (uint256, bytes32));
        _track(loanId_);
        if (closing_ != bytes32(0)) _note("DrawDebt.takesOverCollateral");
    }

    /// @dev Pledging is open to anyone.
    function doPledge(address payer_, bytes32 loanId_, uint256 amount_) public tick returns (bool ok_) {
        (ok_, ) = _exec(payer_, abi.encodeCall(pool.drawDebt, (_borrowerOf(loanId_), 0, 7388, amount_, loanId_)));
    }

    function doRepay(bytes32 loanId_, uint256 amount_, uint256 pull_) public tick returns (bool ok_) {
        address borrower = _borrowerOf(loanId_);
        (ok_, ) = _exec(borrower, abi.encodeCall(pool.repayDebt, (borrower, amount_, pull_, borrower, 7388, loanId_)));
    }

    function doMoveLoan(
        bytes32 loanId_,
        bytes32 toLoanId_,
        uint256 toBucket_,
        uint256 debt_,
        uint256 collateral_
    ) public tick returns (bytes32 toLoanIdOut_) {
        address borrower = _borrowerOf(loanId_);
        (bool ok, bytes memory ret) = _exec(
            borrower,
            abi.encodeCall(pool.moveLoan, (borrower, loanId_, toLoanId_, toBucket_, debt_, collateral_))
        );
        if (!ok) return bytes32(0);

        (toLoanIdOut_, , ) = abi.decode(ret, (bytes32, uint256, uint256));
        _track(toLoanIdOut_);
    }

    function doImproveLoan(address caller_, bytes32 loanId_, uint256 toBucket_) public tick returns (bytes32 newLoanId_) {
        (bool ok, bytes memory ret) = _exec(caller_, abi.encodeCall(pool.improveLoan, (loanId_, toBucket_)));
        if (!ok) return bytes32(0);

        (newLoanId_, ) = abi.decode(ret, (bytes32, uint256));
        _track(newLoanId_);
    }

    function doCall(address caller_, bytes32 loanId_) public tick returns (bool ok_) {
        (, , uint256 collateralBefore, , , , ) = pool.loanDetails(loanId_);
        bytes memory ret;
        (ok_, ret) = _exec(caller_, abi.encodeCall(pool.callLoan, (loanId_)));
        if (!ok_) return false;

        (, uint256 lenderCollateral, , ) = abi.decode(ret, (uint256, uint256, uint256, uint256));
        (, , uint256 collateralAfter, , , , ) = pool.loanDetails(loanId_);
        if (collateralAfter != 0)                _note("LoanCalled.borrowerKeepsCollateral");
        if (lenderCollateral == collateralBefore) _note("LoanCalled.lendersTakeAll");
    }

    function doAdvance(uint256 elapsed_) public tick {
        vm.warp(vm.getBlockTimestamp() + elapsed_);
        vm.roll(vm.getBlockNumber() + 1 + elapsed_ / 12);
    }

    function doKickCollateral(address kicker_) public tick returns (bool ok_) {
        (ok_, ) = _exec(kicker_, abi.encodeCall(pool.kickCollateralSurplusAuction, ()));
    }

    function doTakeCollateral(address taker_, uint256 maxAjna_) public tick returns (bool ok_) {
        (ok_, ) = _exec(taker_, abi.encodeCall(pool.takeCollateralSurplus, (maxAjna_, type(uint256).max)));
    }

    /**********************/
    /*** Fuzzed actions ***/
    /**********************/

    /// @dev Matured deposits in every bucket and one loan in each, so that runs start with something to act on.
    function seed() external {
        require(loanIds.length == 0, "already seeded");
        for (uint256 i = 0; i < 3; i++) {
            doDeposit(actors[0], bucketIndexes[i], 10_000e18);
            doDeposit(actors[1], bucketIndexes[i], 5_000e18);
        }
        doAdvance(2 * DEPOSIT_MATURITY_EPOCH);
        for (uint256 i = 0; i < 3; i++) {
            doDraw(actors[2], bucketIndexes[i], 3_000e18, 2 * collateralFor(3_000e18, bucketIndexes[i]), bytes32(0));
        }
        require(loanIds.length == 3, "seed loans were not drawn");
    }

    function deposit(uint256 actorSeed_, uint256 bucketSeed_, uint256 amountSeed_) external {
        doDeposit(actor(actorSeed_), index(bucketSeed_), bound(amountSeed_, 1e15, 1e24));
    }

    function withdraw(uint256 actorSeed_, uint256 bucketSeed_, uint256 amountSeed_) external {
        uint256 amount = amountSeed_ % 3 == 0 ? type(uint256).max : bound(amountSeed_, 1e15, 1e24);
        doWithdraw(actor(actorSeed_), index(bucketSeed_), amount);
    }

    function moveQuote(uint256 actorSeed_, uint256 fromSeed_, uint256 toSeed_, uint256 amountSeed_) external {
        uint256 from = index(fromSeed_);
        uint256 to   = index(toSeed_);
        if (from == to) to = index(toSeed_ % 3 + 1);
        doMoveQuote(actor(actorSeed_), from, to, bound(amountSeed_, 1e15, 1e24));
    }

    function mark(uint256 actorSeed_, uint256 bucketSeed_) external {
        doMark(actor(actorSeed_), index(bucketSeed_));
    }

    /// @dev Amounts are not rounded to the collateral token's precision: the pool does that.
    function addCollateral(uint256 actorSeed_, uint256 bucketSeed_, uint256 amountSeed_) external {
        doAddCollateral(actor(actorSeed_), index(bucketSeed_), bound(amountSeed_, 1, 1e24));
    }

    function removeCollateral(uint256 actorSeed_, uint256 bucketSeed_, uint256 amountSeed_) external {
        uint256 amount = amountSeed_ % 2 == 0 ? type(uint256).max : bound(amountSeed_, 1, 1e24);
        doRemoveCollateral(actor(actorSeed_), index(bucketSeed_), amount);
    }

    /// @dev Pledges the least the pool accepts, or up to three times that, so that loans become callable both by
    ///      falling under collateralization and by expiring with collateral to spare.
    function draw(uint256 actorSeed_, uint256 bucketSeed_, uint256 amountSeed_, uint256 cushionSeed_, uint256 closeSeed_) external {
        address borrower = actor(actorSeed_);
        uint256 bucket   = index(bucketSeed_);
        uint256 amount   = bound(amountSeed_, 1e16, 1e22);
        uint256 toPledge = collateralFor(amount, bucket);
        if (cushionSeed_ % 3 != 0) toPledge += toPledge * (cushionSeed_ % 200) / 100;

        // one draw in three takes over the collateral of a debt-free loan of the borrower's, if there is one
        bytes32 closing = closeSeed_ % 3 == 0 ? _otherLoan(borrower, bytes32(0), true, closeSeed_) : bytes32(0);
        if (closing != bytes32(0) && closeSeed_ % 2 == 0) toPledge = 0;

        doDraw(borrower, bucket, amount, toPledge, closing);
    }

    function pledge(uint256 actorSeed_, uint256 loanSeed_, uint256 amountSeed_) external {
        doPledge(actor(actorSeed_), loanIds[loanSeed_ % loanIds.length], bound(amountSeed_, 1, 1e24));
    }

    function repay(uint256 loanSeed_, uint256 repaySeed_, uint256 pullSeed_) external {
        bytes32 loanId = loanIds[loanSeed_ % loanIds.length];
        (, , uint256 loanCollateral, , , , ) = pool.loanDetails(loanId);

        uint256 amount = repaySeed_ % 4 == 0 ? type(uint256).max : repaySeed_ % 4 == 1 ? 0 : bound(repaySeed_, 1e15, 1e22);
        uint256 pull   = pullSeed_ % 3 == 0 ? 0 : pullSeed_ % 3 == 1 ? loanCollateral : loanCollateral * (pullSeed_ % 100) / 100;
        doRepay(loanId, amount, pull);
    }

    function moveLoan(uint256 loanSeed_, uint256 toSeed_, uint256 debtSeed_, uint256 collateralSeed_) external {
        bytes32 loanId = loanIds[loanSeed_ % loanIds.length];
        (, , uint256 loanCollateral, , , , ) = pool.loanDetails(loanId);

        uint256 collateralToMove = collateralSeed_ % 3 == 0 ? type(uint256).max : loanCollateral * (collateralSeed_ % 101) / 100;
        if (debtSeed_ % 3 == 0) {
            // collateral alone, into another loan of the borrower's
            bytes32 other = _otherLoan(_borrowerOf(loanId), loanId, debtSeed_ % 2 == 0, debtSeed_);
            if (other == bytes32(0)) return;
            (, , , , uint256 otherBucket, , ) = pool.loanDetails(other);
            doMoveLoan(loanId, other, otherBucket, 0, collateralToMove);
        } else {
            uint256 debtToMove = debtSeed_ % 3 == 1 ? type(uint256).max : bound(debtSeed_, 1e15, 1e22);
            doMoveLoan(loanId, bytes32(0), index(toSeed_), debtToMove, collateralToMove);
        }
    }

    function improveLoan(uint256 actorSeed_, uint256 loanSeed_, uint256 toSeed_) external {
        doImproveLoan(actor(actorSeed_), loanIds[loanSeed_ % loanIds.length], index(toSeed_));
    }

    /// @dev `pastExpiry_` first moves just past the loan's expiry, where any loan with debt can be called.
    function callLoan(uint256 actorSeed_, uint256 loanSeed_, bool pastExpiry_) external {
        bytes32 loanId = loanIds[loanSeed_ % loanIds.length];
        (, uint256 t0Debt, , , , uint256 expiry, ) = pool.loanDetails(loanId);
        if (t0Debt == 0) return;
        if (pastExpiry_ && clock <= expiry) doAdvance(expiry + 1 - clock);
        doCall(actor(actorSeed_), loanId);
    }

    /// @dev Up to six days, and one time in five up to four hundred: long enough for interest to outgrow collateral.
    function advance(uint256 secondsSeed_) external {
        doAdvance(1 + secondsSeed_ % (secondsSeed_ % 5 == 0 ? 400 days : 6 days));
    }

    function updateInterest() external tick {
        _exec(actors[0], abi.encodeCall(pool.updateInterest, ()));
    }

    /// @dev Collateral sent straight to the pool belongs to neither total: it is collateral surplus.
    function donateCollateral(uint256 amountSeed_) external tick {
        collateral.mint(address(pool), bound(amountSeed_, 1, 1e24) / collateralScale + 1);
        assertTotals();
    }

    /// @dev A call that reverts after the pool has emitted its event: adding or pledging collateral the caller
    ///      does not have. Nothing of it reaches the chain, so nothing of it may reach the totals.
    function unfunded(uint256 bucketSeed_, uint256 loanSeed_, uint256 amountSeed_, bool pledge_) external {
        uint256 amount = bound(amountSeed_, 1e18, 1e24);
        if (pledge_) require(!doPledge(pauper, loanIds[loanSeed_ % loanIds.length], amount), "an unfunded pledge went through");
        else         require(!doAddCollateral(pauper, index(bucketSeed_), amount), "an unfunded addCollateral went through");
    }

    function kickCollateral(uint256 actorSeed_) external {
        doKickCollateral(actor(actorSeed_));
    }

    /// @dev The whole lot, or what an Ajna budget for about half of it buys. Sells collateral that is in neither total.
    function takeCollateral(uint256 actorSeed_, uint256 fractionSeed_) external {
        (uint256 unclaimed, , , ) = pool.collateralSurplusInfo();
        uint256 budget = type(uint256).max;
        if (fractionSeed_ % 3 != 0) {
            try utils.collateralSurplusAuctionPriceAt(address(pool), clock) returns (uint256 price) {
                budget = (unclaimed / 2 * price + 1e18 - 1) / 1e18;
            } catch {}
        }
        doTakeCollateral(actor(actorSeed_), budget);
    }
}

contract SubgraphReplayInvariants is StdInvariant, Test {

    SubgraphReplayHandler internal handler;

    function setUp() public {
        Token              ajna       = new Token('Ajna', 'AJNA');
        TokenWithNDecimals collateral = new TokenWithNDecimals('Collateral', 'COL', uint8(vm.envOr("COLLATERAL_PRECISION", uint256(18))));
        TokenWithNDecimals quote      = new TokenWithNDecimals('Quote', 'QUOTE', uint8(vm.envOr("QUOTE_PRECISION", uint256(18))));

        // A starting rate of 100% a year, so that interest outgrows a loan's collateral within a run. The scripted
        // test below depends on it: at a low rate its last loan is never left with less collateral than it owes.
        ERC20PoolFactory factory = new ERC20PoolFactory(address(ajna), 30 days);
        ERC20Pool pool = ERC20Pool(factory.deployPool(address(collateral), address(quote), 1e18));

        handler = new SubgraphReplayHandler(pool, quote, collateral, ajna);
        handler.seed();
        handler.assertTotals();
        handler.assertMeaning();

        bytes4[] memory selectors = new bytes4[](18);
        selectors[0]  = handler.deposit.selector;
        selectors[1]  = handler.withdraw.selector;
        selectors[2]  = handler.moveQuote.selector;
        selectors[3]  = handler.mark.selector;
        selectors[4]  = handler.addCollateral.selector;
        selectors[5]  = handler.removeCollateral.selector;
        selectors[6]  = handler.draw.selector;
        selectors[7]  = handler.pledge.selector;
        selectors[8]  = handler.repay.selector;
        selectors[9]  = handler.moveLoan.selector;
        selectors[10] = handler.improveLoan.selector;
        selectors[11] = handler.callLoan.selector;
        selectors[12] = handler.advance.selector;
        selectors[13] = handler.updateInterest.selector;
        selectors[14] = handler.donateCollateral.selector;
        selectors[15] = handler.kickCollateral.selector;
        selectors[16] = handler.takeCollateral.selector;
        selectors[17] = handler.unfunded.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @dev The handler also checks this after every pool call, so a failure names the call.
    function invariant_subgraph_collateral_totals() external view {
        handler.assertTotals();
        handler.assertMeaning();
    }

    /// @dev Fails if the cases the rules were written for cannot be reached: a pass of the invariant that never
    ///      called a loan or claimed collateral from escrow would say nothing about them.
    function test_subgraph_replay_reaches_every_rule() external {
        address lender   = handler.actors(0);
        address borrower = handler.actors(2);
        address caller   = handler.actors(3);
        uint256 bucket   = handler.index(1);

        // the lender asks to leave a bucket whose deposit is lent out
        handler.doDeposit(lender, bucket, 1_000e18);
        handler.doAdvance(2 * DEPOSIT_MATURITY_EPOCH);
        bytes32 roomy = handler.doDraw(borrower, bucket, 12_500e18, 3 * handler.collateralFor(12_500e18, bucket), bytes32(0));
        assertTrue(roomy != bytes32(0), "roomy loan was not drawn");
        assertTrue(handler.doMark(lender, bucket), "lender could not mark");

        // an expired loan with collateral to spare pays lenders, caller and surplus, and leaves the borrower the rest
        handler.doAdvance(31 days);
        assertTrue(handler.doCall(caller, roomy), "expired loan could not be called");
        assertGt(handler.seen("LoanCalled.lender"), 0);
        assertGt(handler.seen("LoanCalled.caller"), 0);
        assertGt(handler.seen("LoanCalled.surplus"), 0);
        assertGt(handler.seen("LoanCalled.borrowerKeepsCollateral"), 0);

        // the call's collateral funded the lender's place: it is claimed from escrow
        assertGt(handler.seen("ExitQueueFunded.collateral"), 0);
        assertTrue(handler.doRemoveCollateral(lender, bucket, type(uint256).max), "lender could not claim collateral");
        assertGt(handler.seen("RemoveCollateral.exitClaim.paid"), 0);

        // the borrower takes back what the call left, then borrows again on a debt-free loan's collateral
        (, , uint256 left, , , , ) = handler.pool().loanDetails(roomy);
        assertTrue(handler.doRepay(roomy, 0, left / 2), "borrower could not pull");
        assertGt(handler.seen("RepayDebt.pull"), 0);
        handler.doDeposit(handler.actors(1), bucket, 5_000e18);
        handler.doAdvance(2 * DEPOSIT_MATURITY_EPOCH);
        bytes32 tight = handler.doDraw(borrower, bucket, 100e18, handler.collateralFor(100e18, bucket), roomy);
        assertTrue(tight != bytes32(0), "tight loan was not drawn");
        assertGt(handler.seen("DrawDebt.takesOverCollateral"), 0);

        // a loan left to outgrow its collateral: lenders take all of it
        bytes32 doomed = handler.doDraw(borrower, bucket, 1_000e18, handler.collateralFor(1_000e18, bucket), bytes32(0));
        assertTrue(doomed != bytes32(0), "doomed loan was not drawn");
        handler.doAdvance(400 days);
        assertTrue(handler.doCall(caller, doomed), "undercollateralized loan could not be called");
        assertGt(handler.seen("LoanCalled.lendersTakeAll"), 0);

        // lender collateral outside the exit queue
        assertTrue(handler.doAddCollateral(caller, bucket, 5e18 + 123), "collateral could not be added");
        assertTrue(handler.doRemoveCollateral(caller, bucket, 1e18), "collateral could not be removed");
        assertGt(handler.seen("RemoveCollateral.ordinary"), 0);

        // a call that emits and then reverts leaves no trace
        handler.unfunded(1, 0, 3e18, false);
        handler.unfunded(1, 0, 3e18, true);
        assertEq(handler.seen("revert.afterCollateralEvent"), 2);

        handler.assertTotals();
        handler.assertMeaning();
    }
}
