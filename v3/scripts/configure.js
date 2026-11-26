#!/usr/bin/env node
// Renders subgraph.yaml and src/config/deployments.ts for one network, then checks the manifest
// against the ABIs and mapping files it names.
//
//   yarn configure <network>           reads config/<network>.json
//   yarn configure <path/to/file.json>
//
// The checks cover what `graph build` does not: an ABI event that no handler is registered for
// (so a contract change cannot add an event unnoticed), and a handler named in the manifest that
// its mapping file does not export.
const fs = require("fs")
const path = require("path")
const Mustache = require("mustache")
const YAML = require("yaml")

const ROOT = path.join(__dirname, "..")
const ADDRESS = /^0x[0-9a-fA-F]{40}$/

// the output is YAML and TypeScript, not HTML
Mustache.escape = (text) => text

function fail(message) {
  console.error(`configure: ${message}`)
  process.exit(1)
}

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), "utf8")
}

function address(value, where) {
  if (typeof value !== "string" || !ADDRESS.test(value)) {
    fail(`${where} must be a 20-byte hex address, got ${JSON.stringify(value)}`)
  }
  return value.toLowerCase()
}

function contract(value, where) {
  if (value === null || typeof value !== "object") {
    fail(`${where} must be an object with "address" and "startBlock"`)
  }
  if (!Number.isInteger(value.startBlock) || value.startBlock < 0) {
    fail(`${where}.startBlock must be a block number, got ${JSON.stringify(value.startBlock)}`)
  }
  return { address: address(value.address, `${where}.address`), startBlock: value.startBlock }
}

function buildView(config, configFile) {
  if (typeof config.network !== "string" || config.network === "") {
    fail(`"network" must name the network`)
  }
  if (!Array.isArray(config.deployments) || config.deployments.length === 0) {
    fail(`"deployments" must list at least one deployment`)
  }

  const deployments = config.deployments.map((entry, i) => {
    const where = `deployments[${i}]`
    if (entry === null || typeof entry !== "object") fail(`${where} must be an object`)
    return {
      // Data source names must be unique. The first deployment keeps the bare names, because the
      // mappings import their generated event types from generated/ERC20PoolFactory and
      // generated/PositionManager.
      suffix: i === 0 ? "" : String(i + 1),
      factory: contract(entry.factory, `${where}.factory`),
      positionManager: contract(entry.positionManager, `${where}.positionManager`),
      poolInfoUtils: address(entry.poolInfoUtils, `${where}.poolInfoUtils`),
      poolInfoUtilsMulticall: address(entry.poolInfoUtilsMulticall, `${where}.poolInfoUtilsMulticall`),
    }
  })

  // handlers find their deployment by the address that emitted the event, so each must appear once
  const emitters = deployments.flatMap((d) => [d.factory.address, d.positionManager.address])
  const repeated = emitters.find((emitter, i) => emitters.indexOf(emitter) !== i)
  if (repeated) fail(`${repeated} is listed as a factory or PositionManager more than once`)

  return { network: config.network, configFile, deployments }
}

// An event in the form the manifest uses, e.g. "Burn(indexed address,indexed uint256)".
function eventSignature(event) {
  const params = event.inputs.map((input) => {
    if (input.type.startsWith("tuple")) {
      fail(`event ${event.name} has a tuple parameter, which the manifest check does not support`)
    }
    return (input.indexed ? "indexed " : "") + input.type
  })
  return `${event.name}(${params.join(",")})`
}

// Returns the number of distinct event handlers checked.
function checkManifest(manifestText) {
  const manifest = YAML.parse(manifestText)
  const problems = new Set()
  const checked = new Set()

  for (const source of [...manifest.dataSources, ...manifest.templates]) {
    const { mapping } = source
    const abiName = source.source.abi

    for (const abi of mapping.abis) {
      if (!fs.existsSync(path.join(ROOT, abi.file))) problems.add(`${abi.file} does not exist`)
    }
    const abiEntry = mapping.abis.find((abi) => abi.name === abiName)
    if (!abiEntry) {
      problems.add(`${source.name}: source ABI ${abiName} is not in its abis list`)
      continue
    }
    if (!fs.existsSync(path.join(ROOT, abiEntry.file))) continue

    const emitted = JSON.parse(read(abiEntry.file))
      .filter((item) => item.type === "event")
      .map(eventSignature)
    const handled = mapping.eventHandlers.map((entry) => entry.event)
    for (const signature of emitted) {
      if (!handled.includes(signature)) {
        problems.add(`${abiName} emits ${signature}, which has no handler in the manifest`)
      }
    }
    for (const signature of handled) {
      if (!emitted.includes(signature)) {
        problems.add(`${signature} is in the manifest but is not an event of ${abiEntry.file}`)
      }
    }

    const mappingSource = read(mapping.file)
    for (const { handler } of mapping.eventHandlers) {
      if (!new RegExp(`export function ${handler}\\(`).test(mappingSource)) {
        problems.add(`${mapping.file} does not export ${handler}`)
      }
      checked.add(`${mapping.file}:${handler}`)
    }
  }

  if (problems.size > 0) {
    fail(`the manifest does not match the ABIs and mappings:\n  - ${[...problems].join("\n  - ")}`)
  }
  return checked.size
}

function main() {
  const arg = process.argv[2]
  if (!arg) fail("usage: yarn configure <network | path to a config json>")
  const configPath = arg.endsWith(".json") ? path.resolve(arg) : path.join(ROOT, "config", `${arg}.json`)
  if (!fs.existsSync(configPath)) fail(`no config file at ${configPath}`)

  const configFile = path.relative(ROOT, configPath)
  const view = buildView(JSON.parse(fs.readFileSync(configPath, "utf8")), configFile)

  const manifest = Mustache.render(read("templates/subgraph.yaml.mustache"), view)
  const deployments = Mustache.render(read("templates/deployments.ts.mustache"), view)
  const handlerCount = checkManifest(manifest)

  fs.writeFileSync(path.join(ROOT, "subgraph.yaml"), manifest)
  fs.mkdirSync(path.join(ROOT, "src", "config"), { recursive: true })
  fs.writeFileSync(path.join(ROOT, "src", "config", "deployments.ts"), deployments)

  const abiCommit = JSON.parse(read("abis/ajna-v3.lock.json")).commit.slice(0, 8)
  console.log(
    `configured ${view.network} from ${configFile}: ${view.deployments.length} deployment(s), ` +
      `${handlerCount} event handlers checked against the ajna-v3 ${abiCommit} ABIs`
  )
}

main()
