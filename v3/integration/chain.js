// A small JSON-RPC client for the integration scripts: reads, transactions from a node's unlocked
// accounts, contract deployment from Foundry artifacts, and the block controls of a development
// node (anvil). ABIs come from abis/, the same files the subgraph is built from.
const fs = require("fs")
const path = require("path")
const { Interface } = require("@ethersproject/abi")

const ROOT = path.join(__dirname, "..")
const GAS = "0x" + (25_000_000).toString(16)

// Solidity custom errors are left out: this version of the ABI library does not parse them.
// errorNames() reads them separately.
function withoutErrors(abi) {
  return abi.filter((entry) => entry.type !== "error")
}

function loadAbi(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "abis", `${name}.json`), "utf8"))
}

function interfaceOf(name) {
  return new Interface(withoutErrors(loadAbi(name)))
}

// selector -> name, for the custom errors of the ABIs named
function errorNames(names) {
  const errors = {}
  for (const name of names) {
    for (const entry of loadAbi(name)) {
      if (entry.type !== "error") continue
      // a function with the same name and inputs has the same selector
      const asFunction = { type: "function", name: entry.name, inputs: entry.inputs, outputs: [], stateMutability: "view" }
      const iface = new Interface([asFunction])
      errors[iface.getSighash(iface.fragments[0])] = entry.name
    }
  }
  return errors
}

// a Foundry build artifact from an ajna-v3 checkout, e.g. artifact(checkout, "Tokens.sol", "Token")
function artifact(checkout, file, name) {
  const artifactPath = path.join(checkout, "forge_out", file, `${name}.json`)
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`${artifactPath} is missing: build it in the checkout first`)
  }
  const json = JSON.parse(fs.readFileSync(artifactPath, "utf8"))
  return { name, iface: new Interface(withoutErrors(json.abi)), bytecode: json.bytecode }
}

// the ABI library wants numbers as strings, and returns its own big number type
function encodable(value) {
  if (typeof value === "bigint") return value.toString()
  if (Array.isArray(value)) return value.map(encodable)
  return value
}

function plain(value) {
  if (value !== null && typeof value === "object" && value._isBigNumber) return BigInt(value.toString())
  if (Array.isArray(value)) return value.map(plain)
  return value
}

function hex(value) {
  return "0x" + BigInt(value).toString(16)
}

class Chain {
  constructor(url, errors = {}) {
    this.url = url
    this.errors = errors
    this.nextId = 1
    this.clock = null
  }

  async rpc(method, params = []) {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params })
    })
    const body = await response.json()
    if (body.error) {
      const error = new Error(`${method}: ${body.error.message}`)
      error.data = body.error.data
      throw error
    }
    return body.result
  }

  // Many requests in one round trip: [{ method, params }]. Returns one { result } or { error }
  // for each, in order.
  async batch(requests) {
    if (requests.length === 0) return []
    const first = this.nextId
    const body = requests.map((request) => ({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: request.method,
      params: request.params
    }))
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    })
    const answers = await response.json()
    const ordered = new Array(requests.length)
    for (const answer of answers) ordered[answer.id - first] = answer
    return ordered
  }

  // why a call reverted, from the error data a node returns
  reason(error) {
    const data = typeof error.data === "string" ? error.data : ""
    if (data.length >= 10 && this.errors[data.slice(0, 10)]) return this.errors[data.slice(0, 10)]
    return error.message
  }

  async blockNumber() {
    return Number(await this.rpc("eth_blockNumber"))
  }

  async timestamp(block = "latest") {
    const tag = typeof block === "number" ? hex(block) : block
    return Number((await this.rpc("eth_getBlockByNumber", [tag, false])).timestamp)
  }

  // A read of `contract` ({ address, iface }) at a block number or tag. Returns the decoded
  // outputs as an array of BigInts, strings, booleans and nested arrays.
  async call(contract, fn, args = [], block = "latest", from = undefined) {
    const data = contract.iface.encodeFunctionData(fn, encodable(args))
    const tag = typeof block === "number" ? hex(block) : block
    let result
    try {
      result = await this.rpc("eth_call", [{ from, to: contract.address, data }, tag])
    } catch (error) {
      error.message = `${fn} on ${contract.address}: ${this.reason(error)}`
      throw error
    }
    return plain(contract.iface.decodeFunctionResult(fn, result))
  }

  // true if the read reverts or the address has no code to answer it
  async reverts(contract, fn, args = [], block = "latest") {
    try {
      await this.call(contract, fn, args, block)
      return false
    } catch (error) {
      return true
    }
  }

  // A transaction from one of the node's unlocked accounts. It is run as a call first, against
  // the pending state, which gives its return values and the reason if it would revert. With
  // automine on, the receipt is checked too.
  async send(from, contract, fn, args = []) {
    const data = contract.iface.encodeFunctionData(fn, encodable(args))
    const returned = await this.call(contract, fn, args, "pending", from)
    if (!this.batched) await this.tick()
    const hash = await this.rpc("eth_sendTransaction", [{ from, to: contract.address, data, gas: GAS }])
    if (this.batched) {
      this.batched.push({ hash, what: `${fn} on ${contract.address}` })
      return { hash, returned }
    }
    return { hash, returned, receipt: await this.receipt(hash, `${fn} on ${contract.address}`) }
  }

  // The node answers a send before it has mined the block, so the receipt can take a moment.
  async receipt(hash, what) {
    const deadline = Date.now() + 10_000
    let receipt = await this.rpc("eth_getTransactionReceipt", [hash])
    while (receipt === null) {
      if (Date.now() > deadline) throw new Error(`${what}: no receipt for ${hash}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
      receipt = await this.rpc("eth_getTransactionReceipt", [hash])
    }
    if (Number(receipt.status) !== 1) throw new Error(`${what}: transaction ${hash} failed`)
    return receipt
  }

  // Deploys a Foundry artifact, linking the libraries it names: { LibraryName: address }.
  async deploy(from, built, args = [], libraries = {}) {
    let code = built.bytecode.object.slice(2)
    for (const file of Object.values(built.bytecode.linkReferences || {})) {
      for (const [library, places] of Object.entries(file)) {
        if (!libraries[library]) throw new Error(`${built.name} needs the library ${library}`)
        const address = libraries[library].slice(2).toLowerCase()
        for (const place of places) {
          code = code.slice(0, place.start * 2) + address + code.slice((place.start + place.length) * 2)
        }
      }
    }
    const data = "0x" + code + built.iface.encodeDeploy(encodable(args)).slice(2)
    await this.tick()
    const hash = await this.rpc("eth_sendTransaction", [{ from, data, gas: GAS }])
    const receipt = await this.receipt(hash, `deployment of ${built.name}`)
    return { address: receipt.contractAddress.toLowerCase(), iface: built.iface, block: Number(receipt.blockNumber) }
  }

  /*** development node controls ***/

  // Makes block times repeatable: from now on each block is `interval` seconds after the one
  // before, whatever the wall clock says. With a fixed genesis time, a script then builds the
  // same chain every time, down to its transaction hashes.
  async useFixedClock(interval = 12) {
    this.clock = await this.timestamp()
    this.interval = interval
  }

  // sets the time of the next block
  async tick(seconds = this.interval) {
    if (this.clock === null) return
    this.clock += seconds
    await this.rpc("evm_setNextBlockTimestamp", [hex(this.clock)])
  }

  async mine() {
    await this.tick()
    await this.rpc("evm_mine")
  }

  // moves the clock forward and mines a block at the new time
  async advance(seconds) {
    if (this.clock === null) {
      await this.rpc("evm_increaseTime", [hex(seconds)])
      await this.rpc("evm_mine")
    } else {
      await this.tick(seconds)
      await this.rpc("evm_mine")
    }
  }

  // Runs `actions`, whose transactions are all mined in one block, in the order they were sent.
  // Returns that block's number.
  async inOneBlock(actions) {
    await this.rpc("evm_setAutomine", [false])
    this.batched = []
    try {
      await actions()
      await this.mine()
      const receipts = []
      for (const sent of this.batched) receipts.push(await this.receipt(sent.hash, sent.what))
      const blocks = new Set(receipts.map((receipt) => receipt.blockNumber))
      if (blocks.size > 1) throw new Error("transactions meant for one block were mined in several")
      return receipts.length === 0 ? await this.blockNumber() : Number(receipts[0].blockNumber)
    } finally {
      this.batched = null
      await this.rpc("evm_setAutomine", [true])
    }
  }

  // every log of the addresses given, from `fromBlock` to `toBlock`
  async logs(addresses, fromBlock, toBlock) {
    return this.rpc("eth_getLogs", [{ address: addresses, fromBlock: hex(fromBlock), toBlock: hex(toBlock) }])
  }
}

// n whole units as a WAD, the 18-decimal integer the pool takes for every amount: wad("1.5")
function wad(amount) {
  const [whole, fraction = ""] = String(amount).split(".")
  return BigInt(whole + fraction.padEnd(18, "0").slice(0, 18))
}

module.exports = { ROOT, Chain, artifact, errorNames, interfaceOf, loadAbi, plain, wad }
