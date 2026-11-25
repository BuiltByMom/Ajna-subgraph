#!/bin/bash
# Copies the Ajna v3 contract ABIs this subgraph indexes out of an ajna-v3 checkout, and records
# the commit they were built from in abis/ajna-v3.lock.json.
#
#   ./scripts/copy-abis.sh <ajna-v3 checkout>   build the checkout, copy the ABIs, rewrite the lock
#   ./scripts/copy-abis.sh --check              verify abis/ still matches the lock (needs no checkout)
#
# Requires jq, plus forge (Foundry) to copy.
set -euo pipefail

CONTRACTS=(ERC20Pool ERC20PoolFactory PoolInfoUtils PoolInfoUtilsMulticall PositionManager)
REPOSITORY="https://github.com/ajna-finance/ajna-v3"

# a relative checkout path is relative to where the script was run from, not to this package
CHECKOUT="${1:-}"
if [ "$CHECKOUT" != "--check" ] && [ -d "$CHECKOUT" ]; then
  CHECKOUT="$(cd "$CHECKOUT" && pwd)"
fi

cd "$(dirname "$0")/.."
LOCK="abis/ajna-v3.lock.json"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

check() {
  local failed=0
  for contract in "${CONTRACTS[@]}"; do
    local file="abis/${contract}.json"
    local expected
    expected=$(jq -r --arg file "${contract}.json" '.abis[$file] // empty' "$LOCK")
    if [ ! -f "$file" ]; then
      echo "missing ${file}" >&2
      failed=1
    elif [ "$(sha256 "$file")" != "$expected" ]; then
      echo "${file} does not match ${LOCK}" >&2
      failed=1
    fi
  done
  if [ "$failed" -ne 0 ]; then
    echo "Re-run ./scripts/copy-abis.sh <ajna-v3 checkout> so the ABIs and the recorded commit agree." >&2
    exit 1
  fi
  echo "abis/ matches ajna-v3 $(jq -r '.commit' "$LOCK")"
}

if [ "$CHECKOUT" = "--check" ]; then
  check
  exit 0
fi

if [ -z "$CHECKOUT" ]; then
  echo "usage: copy-abis.sh <ajna-v3 checkout> | --check" >&2
  exit 1
fi
if [ ! -f "${CHECKOUT}/src/ERC20Pool.sol" ]; then
  echo "${CHECKOUT} is not an ajna-v3 checkout" >&2
  exit 1
fi
# the recorded commit is only meaningful if the contracts are exactly what that commit holds
if [ -n "$(git -C "$CHECKOUT" status --porcelain -- src)" ]; then
  echo "${CHECKOUT}/src has uncommitted changes; commit or stash them first" >&2
  exit 1
fi

# rebuild so the artifacts cannot be left over from another commit
(cd "$CHECKOUT" && forge build src)

# Build every ABI and the lock aside, and replace abis/ only once all of it is ready: a contract
# that is missing from the checkout must not leave some ABIs from the new commit and the rest,
# and the lock, from the old one.
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT

hashes='{}'
for contract in "${CONTRACTS[@]}"; do
  jq -e '.abi' "${CHECKOUT}/forge_out/${contract}.sol/${contract}.json" > "${staging}/${contract}.json"
  hashes=$(jq --arg file "${contract}.json" --arg hash "$(sha256 "${staging}/${contract}.json")" \
    '. + {($file): $hash}' <<< "$hashes")
done

# srcTree is the git tree hash of src/: two commits with the same srcTree have identical contracts
jq -n \
  --arg repository "$REPOSITORY" \
  --arg commit "$(git -C "$CHECKOUT" rev-parse HEAD)" \
  --arg srcTree "$(git -C "$CHECKOUT" rev-parse HEAD:src)" \
  --argjson abis "$hashes" \
  '{repository: $repository, commit: $commit, srcTree: $srcTree, abis: $abis}' > "${staging}/lock.json"

for contract in "${CONTRACTS[@]}"; do
  mv "${staging}/${contract}.json" "abis/${contract}.json"
done
mv "${staging}/lock.json" "$LOCK"

check
