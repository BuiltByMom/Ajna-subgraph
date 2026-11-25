// Finds and decodes the events of the deployments a scenario describes: every log the factories,
// pools and PositionManagers emitted, in the order the chain emitted them. The scenario is the
// one integration/scenario.js wrote for the local chain, or one that integration/reconcile.js
// puts together for a real network.
const { interfaceOf, loadAbi, plain } = require("./chain")

const SOURCES = {
  factory: { abi: "ERC20PoolFactory" },
  pool: { abi: "ERC20Pool" },
  manager: { abi: "PositionManager" }
}
for (const source of Object.values(SOURCES)) {
  source.iface = interfaceOf(source.abi)
  source.events = {}
  for (const entry of loadAbi(source.abi)) {
    if (entry.type === "event") source.events[source.iface.getEventTopic(entry.name)] = entry
  }
}

// Each event as { kind, address, deployment, name, inputs, args, block, logIndex, transactionHash }.
// kind is "factory", "pool" or "manager"; deployment is the index of a factory's or manager's
// deployment; args maps each parameter name to its value: a BigInt, a string, a boolean or an array.
async function decodedEvents(chain, scenario) {
  const emitters = {}
  scenario.deployments.forEach((deployment, i) => {
    emitters[deployment.factory.address] = { kind: "factory", deployment: i }
    emitters[deployment.positionManager.address] = { kind: "manager", deployment: i }
  })
  for (const address of Object.values(scenario.pools)) emitters[address] = { kind: "pool" }

  // in ranges a public endpoint accepts
  const logs = []
  const step = Number(process.env.LOG_RANGE || 5000)
  for (let from = scenario.startBlock || 0; from <= scenario.headBlock; from += step) {
    logs.push(...(await chain.logs(Object.keys(emitters), from, Math.min(from + step - 1, scenario.headBlock))))
  }
  logs.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex))

  return logs.map((entry) => {
    const address = entry.address.toLowerCase()
    const emitter = emitters[address]
    const source = SOURCES[emitter.kind]
    const event = source.events[entry.topics[0]]
    if (!event) throw new Error(`${address} emitted an event its ABI does not list, in block ${Number(entry.blockNumber)}`)
    const values = source.iface.parseLog(entry).args
    const args = {}
    event.inputs.forEach((input, i) => (args[input.name] = plain(values[i])))
    return {
      kind: emitter.kind,
      address,
      deployment: emitter.deployment,
      name: event.name,
      inputs: event.inputs,
      args,
      block: Number(entry.blockNumber),
      logIndex: Number(entry.logIndex),
      transactionHash: entry.transactionHash
    }
  })
}

module.exports = { decodedEvents }
