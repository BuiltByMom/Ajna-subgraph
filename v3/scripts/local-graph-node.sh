#!/bin/bash
# Runs a graph-node over the local chain and checks the subgraph it indexes against the chain.
#
#   ./scripts/local-graph-node.sh up          start graph-node, IPFS and Postgres (integration/docker-compose.yml)
#   ./scripts/local-graph-node.sh deploy      build the subgraph for the local chain, deploy it and wait
#                                             until it has indexed the whole chain
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
#                http://host.docker.internal:8545, suits Docker Desktop and Docker on Linux.
#   DOCKER_HOST  the Docker engine, if it is not the default one.
# With Docker in a Lima VM on a Mac (README, "A graph-node"):
#   export DOCKER_HOST=unix://$HOME/.lima/<vm>/sock/docker.sock CHAIN_RPC=http://192.168.5.2:8545
set -euo pipefail

cd "$(dirname "$0")/.."
OUT="integration/.out"
NAME="ajna-v3"
ADMIN="http://localhost:8020"
IPFS="http://localhost:5001"
STATUS="http://localhost:8030/graphql"
QUERY="http://localhost:8000/subgraphs/name/${NAME}"
compose() { docker compose -p "$NAME" -f integration/docker-compose.yml "$@"; }

# the indexing status as "<health> <latest block> <fatal error or ->", or nothing if there is none yet
status() {
  curl -s -m 5 -X POST -H 'content-type: application/json' "$STATUS" --data \
    '{"query":"{ indexingStatuses { health fatalError { message } chains { latestBlock { number } } } }"}' \
    | node -e '
      let text = ""
      process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
        let statuses = []
        try { statuses = JSON.parse(text).data.indexingStatuses } catch (error) {}
        if (statuses.length === 0) return
        const latest = statuses[0].chains[0].latestBlock
        const fatal = statuses[0].fatalError
        console.log(statuses[0].health, latest ? latest.number : -1, fatal ? fatal.message : "-")
      })'
}

case "${1:-}" in
  up)
    compose up -d
    for _ in $(seq 1 600); do
      if curl -s -m 2 -o /dev/null "$STATUS"; then
        echo "graph-node is up: admin ${ADMIN}, queries ${QUERY}"
        exit 0
      fi
    done
    echo "graph-node did not come up:" >&2
    compose logs --tail 20 graph-node >&2
    exit 1
    ;;
  deploy)
    if [ ! -f "${OUT}/scenario.json" ]; then
      echo "no local chain: run ./scripts/local-chain.sh start <ajna-v3 checkout> first" >&2
      exit 1
    fi
    head=$(node -p "require('./${OUT}/scenario.json').headBlock")
    yarn -s configure "${OUT}/local.json"
    yarn -s codegen > /dev/null
    yarn -s build > /dev/null
    yarn -s graph create --node "$ADMIN" "$NAME" > /dev/null
    yarn -s graph deploy --node "$ADMIN" --ipfs "$IPFS" --version-label "local-$(date +%s)" "$NAME" > /dev/null
    echo "deployed; indexing to block ${head}"
    for _ in $(seq 1 3000); do
      read -r health latest fatal <<< "$(status) "
      if [ "${health:-}" = "failed" ]; then
        echo "indexing failed at block ${latest}: ${fatal}" >&2
        exit 1
      fi
      if [ -n "${latest:-}" ] && [ "$latest" -ge "$head" ]; then
        echo "indexed to block ${latest}, ${health}"
        exit 0
      fi
    done
    echo "the subgraph did not reach block ${head}: $(status)" >&2
    exit 1
    ;;
  reconcile)
    node integration/reconcile.js "$QUERY"
    ;;
  down)
    compose down
    ;;
  *)
    echo "usage: local-graph-node.sh up|deploy|reconcile|down" >&2
    exit 1
    ;;
esac
