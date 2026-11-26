#!/bin/bash
# Builds the local chain the integration tests stand on: an anvil node with the Ajna v3
# contracts deployed and driven through every event the subgraph handles (integration/scenario.js).
#
#   ./scripts/local-chain.sh start <ajna-v3 checkout>    build the chain, attack it with hostile tokens
#                                                        and arguments (integration/hostile.js), and
#                                                        leave the node running
#   ./scripts/local-chain.sh record <ajna-v3 checkout>   build the chain, record it into
#                                                        tests/recorded/local-chain.test.ts, and stop
#   ./scripts/local-chain.sh stop                        stop a node left running by start
#
# The node starts at a fixed time and the scenario fixes the time between blocks, so every run
# builds the same chain, down to its transaction hashes, and a recording only changes when the
# contracts or the scenario do.
#
# The checkout must hold the contracts the ABIs were built from (abis/ajna-v3.lock.json). Its
# build output is used, and nothing else in it is written.
#
# Requires anvil, forge and cast (Foundry), jq and node. PORT sets the node's port (default 8545).
#
# anvil listens on 127.0.0.1 unless ANVIL_IP_ADDR says otherwise, which is anvil's own setting. A
# graph-node in a container must be able to reach it: see scripts/local-graph-node.sh.
set -euo pipefail

PORT="${PORT:-8545}"
GENESIS_TIME=1750000000
export RPC_URL="http://127.0.0.1:${PORT}"

COMMAND="${1:-}"
CHECKOUT="${2:-}"
if [ -n "$CHECKOUT" ] && [ -d "$CHECKOUT" ]; then
  # a relative path is relative to where the script was run from, not to this package
  CHECKOUT="$(cd "$CHECKOUT" && pwd)"
fi

cd "$(dirname "$0")/.."
OUT="integration/.out"
# one node per port, each with its own record of the process to stop
PIDFILE="${OUT}/anvil-${PORT}.pid"
LOCK="abis/ajna-v3.lock.json"
# seconds to wait for anvil to answer
START_TIMEOUT=60

stop() {
  if [ -f "$PIDFILE" ]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    rm -f "$PIDFILE"
  fi
}

# Whether this run started a node, and whether to leave it running. A run stops the node it
# started when it fails, and never one that was already there.
STARTED=""
KEEP=""
finish() {
  if [ -n "$STARTED" ] && [ -z "$KEEP" ]; then stop; fi
}
trap finish EXIT

start() {
  if [ ! -f "${CHECKOUT}/src/ERC20Pool.sol" ]; then
    echo "usage: local-chain.sh start|record <ajna-v3 checkout>" >&2
    exit 1
  fi
  # the chain says something about this subgraph only if these are the contracts its ABIs came from
  if [ "$(git -C "$CHECKOUT" rev-parse HEAD:src)" != "$(jq -r '.srcTree' "$LOCK")" ] \
    || [ -n "$(git -C "$CHECKOUT" status --porcelain -- src)" ]; then
    echo "${CHECKOUT}/src is not the contracts recorded in ${LOCK}." >&2
    echo "Check out $(jq -r '.commit' "$LOCK") there, or run ./scripts/copy-abis.sh first." >&2
    exit 1
  fi
  if cast block-number --rpc-url "$RPC_URL" > /dev/null 2>&1; then
    echo "a node is already answering at ${RPC_URL}: stop it, or set PORT" >&2
    exit 1
  fi

  # the contracts, and the two test helpers the scenario deploys
  (cd "$CHECKOUT" && forge build src tests/forge/utils/Tokens.sol tests/forge/utils/FlashloanBorrower.sol > /dev/null)

  mkdir -p "$OUT"
  # what an earlier chain left for integration/reconcile.js says nothing about this one
  rm -f "${OUT}/hostile.json"
  anvil --port "$PORT" --timestamp "$GENESIS_TIME" --silent > "${OUT}/anvil.log" 2>&1 &
  echo $! > "$PIDFILE"
  STARTED=1
  local deadline=$(( $(date +%s) + START_TIMEOUT ))
  until cast block-number --rpc-url "$RPC_URL" > /dev/null 2>&1; do
    if ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "anvil did not start: see ${OUT}/anvil.log" >&2
      exit 1
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "anvil did not answer at ${RPC_URL} within ${START_TIMEOUT} seconds: see ${OUT}/anvil.log" >&2
      exit 1
    fi
    sleep 0.2
  done

  node integration/scenario.js "$CHECKOUT"
}

# The token integration/hostile.js deploys, built with the compiler the checkout's build installed,
# and the transactions that use it. They come after the scenario's last block, so the chain up to
# there, which is what a recording holds, is the same with or without them.
attack() {
  forge build --root integration/hostile --out "${PWD}/${OUT}/hostile/forge_out" \
    --cache-path "${PWD}/${OUT}/hostile/cache" > /dev/null
  node integration/hostile.js
}

case "$COMMAND" in
  start)
    start
    attack
    KEEP=1
    echo
    echo "The node is running at ${RPC_URL} (pid $(cat "$PIDFILE")). Its subgraph config is ${OUT}/local.json:"
    echo "  yarn configure ${OUT}/local.json && yarn codegen && yarn build"
    echo "Stop it with: ./scripts/local-chain.sh stop"
    ;;
  record)
    start
    node integration/record.js
    ;;
  stop)
    stop
    ;;
  *)
    echo "usage: local-chain.sh start|record <ajna-v3 checkout>, or local-chain.sh stop" >&2
    exit 1
    ;;
esac
