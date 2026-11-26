#!/bin/bash
# Runs a graph-node over the local chain and checks the subgraph it indexes against the chain.
#
#   ./scripts/local-graph-node.sh up          start graph-node, IPFS and Postgres (integration/docker-compose.yml)
#   ./scripts/local-graph-node.sh deploy      build the subgraph for the local chain, deploy it and wait
#                                             until it has indexed the whole chain and is healthy
#   ./scripts/local-graph-node.sh reconcile   compare what the graph-node serves with the chain
#   ./scripts/local-graph-node.sh down        stop and remove the three containers
#
# The chain must be running first: ./scripts/local-chain.sh start <ajna-v3 checkout>.
#
# `deploy` renders the subgraph for the local chain. Afterwards, run `yarn configure <network>`
# and `yarn codegen` again before building for a real network or running the tests.
#
# Requires docker with the compose plugin, and node. Two things depend on where Docker runs:
#   CHAIN_RPC    the chain as the graph-node container reaches it. The default,
#                http://host.docker.internal:8545, suits Docker Desktop.
#   DOCKER_HOST  the Docker engine, if it is not the default one.
# With Docker in a Lima VM on a Mac (README, "A graph-node"):
#   export DOCKER_HOST=unix://$HOME/.lima/<vm>/sock/docker.sock CHAIN_RPC=http://192.168.5.2:8545
# With Docker Engine on Linux, host.docker.internal is the Docker bridge's address, where anvil
# does not listen unless it is told to when the chain is started. This has not been run:
#   ANVIL_IP_ADDR=0.0.0.0 ./scripts/local-chain.sh start <ajna-v3 checkout>
# That opens the chain, whose accounts' keys are public, to everything that can reach the machine.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT="integration/.out"
NAME="ajna-v3"
ADMIN="http://localhost:8020"
IPFS="http://localhost:5001"
STATUS="http://localhost:8030/graphql"
# the deployment `deploy` last made, by its id: a name serves the version before it until the new one has synced
DEPLOYMENT_FILE="${OUT}/deployment"
# seconds to wait for graph-node to start, and for it to index the chain
UP_TIMEOUT=300
INDEX_TIMEOUT=900
compose() { docker compose -p "$NAME" -f integration/docker-compose.yml "$@"; }

# runs a command, showing what it printed only if it fails
quietly() {
  local output
  output=$("$@" 2>&1) || {
    printf '%s\n' "$output" >&2
    exit 1
  }
}

# The indexing status of a deployment as "<health> <latest block> <fatal error or ->", or nothing
# if graph-node has none for it yet.
status() {
  curl -s -m 5 -X POST -H 'content-type: application/json' "$STATUS" --data \
    "{\"query\":\"{ indexingStatuses(subgraphs: [\\\"$1\\\"]) { health fatalError { message } chains { latestBlock { number } } } }\"}" \
    | node -e '
      let text = ""
      process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
        let statuses = []
        // graph-node puts the tabs of a wasm backtrace into the message as they are, which is not JSON
        try { statuses = JSON.parse(text.replace(/[\u0000-\u001f]/g, " ")).data.indexingStatuses } catch (error) {}
        if (statuses.length === 0) return
        const latest = statuses[0].chains[0].latestBlock
        const fatal = statuses[0].fatalError
        console.log(statuses[0].health, latest ? latest.number : -1, fatal ? fatal.message : "-")
      })'
}

case "${1:-}" in
  up)
    compose up -d
    deadline=$(( $(date +%s) + UP_TIMEOUT ))
    until curl -s -m 2 -o /dev/null "$STATUS"; do
      if [ "$(date +%s)" -ge "$deadline" ]; then
        echo "graph-node did not come up within ${UP_TIMEOUT} seconds:" >&2
        compose logs --tail 20 graph-node >&2
        exit 1
      fi
      sleep 1
    done
    echo "graph-node is up: admin ${ADMIN}, queries http://localhost:8000/subgraphs/name/${NAME}"
    ;;
  deploy)
    if [ ! -f "${OUT}/scenario.json" ]; then
      echo "no local chain: run ./scripts/local-chain.sh start <ajna-v3 checkout> first" >&2
      exit 1
    fi
    # the chain ends where the hostile transactions do, if it has them
    head=$(node -p "require('./${OUT}/' + (require('fs').existsSync('${OUT}/hostile.json') ? 'hostile' : 'scenario') + '.json').headBlock")
    quietly yarn -s configure "${OUT}/local.json"
    quietly yarn -s codegen
    quietly yarn -s build
    # the name is already there after an earlier deploy to this graph-node, which is no error
    yarn -s graph create --node "$ADMIN" "$NAME" > /dev/null 2>&1 || true
    deployed=$(yarn -s graph deploy --node "$ADMIN" --ipfs "$IPFS" --version-label "local-$(date +%s)" "$NAME" 2>&1) || {
      echo "$deployed" >&2
      exit 1
    }
    deployment=$(printf '%s\n' "$deployed" | sed -n 's/.*Build completed: \(Qm[A-Za-z0-9]*\).*/\1/p' | tail -1)
    if [ -z "$deployment" ]; then
      echo "could not tell which deployment graph-node made of:" >&2
      echo "$deployed" >&2
      exit 1
    fi
    echo "$deployment" > "$DEPLOYMENT_FILE"
    echo "deployed ${deployment}; indexing to block ${head}"

    # Done only when the last block is indexed and the deployment is healthy. One that fails on
    # the last block has reached it too.
    deadline=$(( $(date +%s) + INDEX_TIMEOUT ))
    while true; do
      read -r health latest fatal <<< "$(status "$deployment") "
      if [ "${health:-}" = "failed" ]; then
        echo "indexing failed at block ${latest}: ${fatal}" >&2
        exit 1
      fi
      if [ "${health:-}" = "healthy" ] && [ "$latest" -ge "$head" ]; then
        echo "indexed to block ${latest}, healthy"
        exit 0
      fi
      if [ "$(date +%s)" -ge "$deadline" ]; then
        echo "the subgraph did not reach block ${head} in good health within ${INDEX_TIMEOUT} seconds: ${health:-no status} at block ${latest:-none}" >&2
        exit 1
      fi
      sleep 1
    done
    ;;
  reconcile)
    if [ ! -f "$DEPLOYMENT_FILE" ]; then
      echo "nothing deployed: run ./scripts/local-graph-node.sh deploy first" >&2
      exit 1
    fi
    node integration/reconcile.js "http://localhost:8000/subgraphs/id/$(cat "$DEPLOYMENT_FILE")"
    ;;
  down)
    compose down
    rm -f "$DEPLOYMENT_FILE"
    ;;
  *)
    echo "usage: local-graph-node.sh up|deploy|reconcile|down" >&2
    exit 1
    ;;
esac
