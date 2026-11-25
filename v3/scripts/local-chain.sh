#!/bin/bash
# Builds the local chain the integration tests stand on: an anvil node with the Ajna v3
# contracts deployed and driven through every event the subgraph handles (integration/scenario.js).
#
#   ./scripts/local-chain.sh start <ajna-v3 checkout>    build the chain and leave the node running
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
PIDFILE="${OUT}/anvil.pid"
LOCK="abis/ajna-v3.lock.json"

stop() {
  if [ -f "$PIDFILE" ]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    rm -f "$PIDFILE"
  fi
}

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
  anvil --port "$PORT" --timestamp "$GENESIS_TIME" --silent > "${OUT}/anvil.log" 2>&1 &
  echo $! > "$PIDFILE"
  for _ in $(seq 1 200); do
    if cast block-number --rpc-url "$RPC_URL" > /dev/null 2>&1; then break; fi
    if ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "anvil did not start: see ${OUT}/anvil.log" >&2
      exit 1
    fi
  done

  node integration/scenario.js "$CHECKOUT"
}

case "$COMMAND" in
  start)
    trap 'stop' ERR
    start
    echo
    echo "The node is running at ${RPC_URL} (pid $(cat "$PIDFILE")). Its subgraph config is ${OUT}/local.json:"
    echo "  yarn configure ${OUT}/local.json && yarn codegen && yarn build"
    echo "Stop it with: ./scripts/local-chain.sh stop"
    ;;
  record)
    trap 'stop' EXIT
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
