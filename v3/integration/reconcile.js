#!/usr/bin/env node
// Compares a subgraph that a graph-node has synced over the local chain with the chain itself.
//
//   node integration/reconcile.js <subgraph query URL>
//
// for example http://localhost:8000/subgraphs/name/ajna-v3. It needs the chain that
// scripts/local-chain.sh start built still running, and integration/.out/scenario.json.
//
// It makes the checks of integration/expected.js, the ones the recorded Matchstick test makes,
// against the entities the graph-node serves at the scenario's last block: which entities exist,
// how many events were recorded, and every field that must equal the chain's final state.
//
// NOT YET RUN AGAINST A GRAPH-NODE. The checks themselves pass against the mappings in the
// recorded test; the code below that queries a graph-node has never met one. It also does not
// yet read the chain at the block each Pool, Bucket and Lend says it was refreshed in, to
// compare the fields that drift between events.
const fs = require("fs")
const path = require("path")

const { Chain } = require("./chain")
const { decodedEvents } = require("./events")
const { expectations } = require("./expected")

const OUT = path.join(__dirname, ".out")

async function graphql(url, query) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query })
  })
  const body = await response.json()
  if (body.errors) throw new Error(`${body.errors.map((error) => error.message).join("; ")}\n  in: ${query}`)
  return body.data
}

// the innermost named type of a GraphQL type reference, and whether a list wraps it
function unwrap(type) {
  let list = false
  while (type.ofType) {
    if (type.kind === "LIST") list = true
    type = type.ofType
  }
  return { name: type.name, kind: type.kind, list }
}

// a value as integration/expected.js writes it: a reference by its id, a list in brackets, and
// a decimal without trailing zeros
function normalized(value) {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return `[${value.map(normalized).join(", ")}]`
  if (typeof value === "object") return value.id
  const text = String(value)
  return /^-?\d+\.\d+$/.test(text) ? text.replace(/0+$/, "").replace(/\.$/, "") : text
}

async function main() {
  const url = process.argv[2]
  if (!url) throw new Error("usage: reconcile.js <subgraph query URL>")
  const scenario = JSON.parse(fs.readFileSync(path.join(OUT, "scenario.json"), "utf8"))
  const chain = new Chain(process.env.RPC_URL || scenario.rpcUrl)
  const head = scenario.headBlock

  const meta = (await graphql(url, `{ _meta { block { number } hasIndexingErrors } }`))._meta
  if (meta.hasIndexingErrors) throw new Error("the subgraph has indexing errors")
  if (meta.block.number < head) throw new Error(`the subgraph is at block ${meta.block.number}; the scenario ends at ${head}`)

  // how the graph-node names each entity's queries, and which of its fields are references
  const schema = (
    await graphql(
      url,
      `{ __schema { queryType { fields { name type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } } } }`
    )
  ).__schema
  const single = {}
  const plural = {}
  for (const query of schema.queryType.fields) {
    const target = unwrap(query.type)
    if (target.kind !== "OBJECT") continue
    if (target.list) plural[target.name] = query.name
    else single[target.name] = query.name
  }
  const references = {}
  async function isReference(entity, field) {
    if (!references[entity]) {
      const type = (
        await graphql(
          url,
          `{ __type(name: "${entity}") { fields { name type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } } }`
        )
      ).__type
      references[entity] = {}
      for (const candidate of type.fields) references[entity][candidate.name] = unwrap(candidate.type).kind === "OBJECT"
    }
    return references[entity][field]
  }

  const at = `block: { number: ${head} }`
  const events = await decodedEvents(chain, scenario)
  // the graph-node indexes the scenario's own addresses, so nothing is renamed
  const checks = await expectations(chain, scenario, events, (address) => address.toLowerCase())

  const failures = []
  for (const check of checks) {
    if (check.kind === "count") {
      let total = 0
      for (let skip = 0; ; skip += 1000) {
        const page = (await graphql(url, `{ ${plural[check.entity]}(first: 1000, skip: ${skip}, ${at}) { id } }`))[plural[check.entity]]
        total += page.length
        if (page.length < 1000) break
      }
      if (total !== check.count) failures.push(`${check.entity}: ${total} entities, expected ${check.count}`)
      continue
    }

    const name = single[check.entity]
    if (check.kind === "absent") {
      const found = (await graphql(url, `{ ${name}(id: "${check.id}", ${at}) { id } }`))[name]
      if (found !== null) failures.push(`${check.entity} ${check.id}: exists, expected none`)
      continue
    }

    const selection = (await isReference(check.entity, check.field)) ? `${check.field} { id }` : check.field
    const found = (await graphql(url, `{ ${name}(id: "${check.id}", ${at}) { ${selection} } }`))[name]
    if (found === null) {
      failures.push(`${check.entity} ${check.id}: missing`)
    } else if (normalized(found[check.field]) !== check.value) {
      failures.push(`${check.entity} ${check.id} ${check.field}: ${normalized(found[check.field])}, expected ${check.value}`)
    }
  }

  for (const failure of failures) console.error(failure)
  console.log(`${checks.length - failures.length} of ${checks.length} checks agree with the chain at block ${head}`)
  if (failures.length !== 0) process.exit(1)
}

main().catch((error) => {
  console.error(`reconcile: ${error.message}`)
  process.exit(1)
})
