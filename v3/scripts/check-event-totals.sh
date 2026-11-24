#!/bin/bash
# Checks the totals this subgraph adds up from pool events against the contracts.
#
#   ./scripts/check-event-totals.sh <ajna-v3 checkout>
#
# Pool.pledgedCollateral and Pool.lenderCollateral are never read from chain: the mappings add them
# up from AddCollateral, RemoveCollateral, DrawDebt, RepayDebt and LoanCalled. That is right only
# if the pool changes its own two totals by exactly those amounts and nowhere else.
# contract-checks/SubgraphReplayInvariants.t.sol tests that inside the contracts' Foundry suite: it
# drives a pool through every action that touches collateral, replays each successful call's events
# with the subgraph's rules, and requires the totals to equal the pool's after every call.
#
# The rules are written out a second time in that file. Run this when abis/ moves to another commit
# and when the rules in src/mappings/erc-20-pool.ts change, and keep the two in step.
#
# The checkout must hold the contracts the ABIs were built from (abis/ajna-v3.lock.json). The test
# file is copied into it for the run and removed afterwards; forge's build output stays.
#
# Requires forge (Foundry) and jq. Each campaign makes RUNS sequences of DEPTH calls (default
# 300 x 100), once for every pair of QUOTE_DECIMALS and COLLATERAL_DECIMALS.
set -euo pipefail

RUNS="${RUNS:-300}"
DEPTH="${DEPTH:-100}"
QUOTE_DECIMALS="${QUOTE_DECIMALS:-6 18}"
COLLATERAL_DECIMALS="${COLLATERAL_DECIMALS:-0 6 8 18}"

cd "$(dirname "$0")/.."
LOCK="abis/ajna-v3.lock.json"
TEST="contract-checks/SubgraphReplayInvariants.t.sol"

CHECKOUT="${1:?usage: check-event-totals.sh <ajna-v3 checkout>}"
if [ ! -f "${CHECKOUT}/src/ERC20Pool.sol" ]; then
  echo "${CHECKOUT} is not an ajna-v3 checkout" >&2
  exit 1
fi

# the result says something about this subgraph only if these are the contracts its ABIs came from
expected=$(jq -r '.srcTree' "$LOCK")
if [ "$(git -C "$CHECKOUT" rev-parse HEAD:src)" != "$expected" ] || [ -n "$(git -C "$CHECKOUT" status --porcelain -- src)" ]; then
  echo "${CHECKOUT}/src is not the contracts recorded in ${LOCK}." >&2
  echo "Check out $(jq -r '.commit' "$LOCK") there, or run ./scripts/copy-abis.sh first." >&2
  exit 1
fi

target="${CHECKOUT}/tests/forge/invariants/ERC20Pool/SubgraphReplayInvariants.t.sol"
if [ -e "$target" ]; then
  echo "${target} already exists; remove it first" >&2
  exit 1
fi
log=$(mktemp)
trap 'rm -f "$target" "$log"' EXIT
cp "$TEST" "$target"

failed=0
for quote in $QUOTE_DECIMALS; do
  for collateral in $COLLATERAL_DECIMALS; do
    printf 'quote %2s decimals, collateral %2s decimals: ' "$quote" "$collateral"
    # forge exits 0 when no test matches, so a pass must also name both tests
    if (cd "$CHECKOUT" && \
        QUOTE_PRECISION="$quote" COLLATERAL_PRECISION="$collateral" \
        FOUNDRY_PROFILE=invariant FOUNDRY_INVARIANT_RUNS="$RUNS" FOUNDRY_INVARIANT_DEPTH="$DEPTH" \
        forge test --mc SubgraphReplayInvariants) > "$log" 2>&1 \
      && grep -q '^\[PASS\] invariant_subgraph_collateral_totals' "$log" \
      && grep -q '^\[PASS\] test_subgraph_replay_reaches_every_rule' "$log"; then
      echo "ok (${RUNS} x ${DEPTH} calls)"
    else
      echo "FAILED"
      cat "$log"
      failed=1
    fi
  done
done

if [ "$failed" -ne 0 ]; then
  echo "The event totals do not match ajna-v3 $(jq -r '.commit' "$LOCK")." >&2
  exit 1
fi
echo "Event totals match the contracts at ajna-v3 $(jq -r '.commit' "$LOCK")."
