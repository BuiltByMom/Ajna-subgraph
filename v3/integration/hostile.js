#!/usr/bin/env node
// Attacks the indexer through the local chain, after integration/scenario.js has built it.
//
//   node integration/hostile.js
//
// Anyone can deploy a pool for any token, and call a pool with any arguments. A mapping that
// aborts on what such a token answers, or on such an argument, stops the subgraph for every
// pool, so each case here is something a stranger could do for the price of a transaction:
//
//   - a token that answers `decimals()` with a number no integer type holds, once its pool exists
//   - a token whose name, symbol and decimals cannot be read at all
//   - a megabyte of name, and a symbol cut in the middle of a character if cut carelessly
//   - a name and a symbol that are not text
//   - a quote token whose `balanceOf` reverts, which makes the pool's readers revert
//   - LP allowances for bucket indexes that are no bucket
//
// It needs integration/hostile/ built by scripts/local-chain.sh, which runs this. It writes
// integration/.out/hostile.json: the block it ended at, and what the subgraph must hold then,
// which integration/reconcile.js checks.
//
// Not attacked: a call that burns all its gas. A node answers it with an out-of-gas error, which
// graph-node takes for a revert from geth, reth and nethermind but not from anvil, whose wording
// it does not know. On this chain it would wait for ever.
const fs = require("fs")
const path = require("path")

const { defaultAbiCoder: coder } = require("@ethersproject/abi")

const { Chain, artifact, interfaceOf, wad } = require("./chain")

const OUT = path.join(__dirname, ".out")

const POOL = interfaceOf("ERC20Pool")
const FACTORY = interfaceOf("ERC20PoolFactory")

// the calls a token is asked for its metadata with, and for a balance
const NAME = "0x06fdde03"
const SYMBOL = "0x95d89b41"
const DECIMALS = "0x313ce567"
const BALANCE_OF = "0x70a08231"
// how a HostileToken answers: see integration/hostile/src/HostileToken.sol
const RETURN = 0
const REVERT = 1
const NOTHING = 2
const LONG = 3

const MAX = (1n << 256n) - 1n
const FIVE_PERCENT = wad("0.05")
// the longest name or symbol the subgraph keeps (MAX_TOKEN_TEXT_LENGTH)
const TEXT_LIMIT = 128

const utf8 = (text) => Buffer.from(text, "utf8").toString("hex")
const word = (value) => coder.encode(["uint256"], [value.toString()])

// abi.encode(string) of bytes that need not be text
function rawString(hex) {
  const length = hex.length / 2
  return "0x" + (32).toString(16).padStart(64, "0") + length.toString(16).padStart(64, "0") + hex.padEnd(Math.ceil(length / 32) * 64, "0")
}

// What graph-node makes of bytes that are meant as text: each run of bytes that is not UTF-8
// becomes a replacement character, and null characters, which Postgres does not store, go.
function asStored(hex) {
  return Buffer.from(hex, "hex").toString("utf8").replace(/\u0000/g, "")
}

async function main() {
  const scenario = JSON.parse(fs.readFileSync(path.join(OUT, "scenario.json"), "utf8"))
  const chain = new Chain(process.env.RPC_URL || scenario.rpcUrl)
  await chain.useFixedClock()

  const Hostile = artifact(path.join(OUT, "hostile"), "HostileToken.sol", "HostileToken")
  const { deployer, lenderA, other } = scenario.accounts
  const factory = { address: scenario.deployments[0].factory.address, iface: FACTORY }
  const honestQuote = scenario.tokens.quote
  const honestCollateral = scenario.tokens.coll

  const checks = []
  const field = (entity, id, name, value) => checks.push({ kind: "field", entity, id, field: name, value: String(value) })
  const absent = (entity, id) => checks.push({ kind: "absent", entity, id })
  const token = (decimals) => chain.deploy(deployer, Hostile, [decimals])
  const answer = (hostile, selector, data, mode) => chain.send(deployer, hostile, "setAnswer", [selector, data, mode])

  // Deploys a pool and runs `after` in the same block. An indexer reads the chain as it is at the
  // end of the block, so it sees what `after` left, while the factory saw what came before.
  async function deployPool(collateral, quote, after = async () => {}) {
    let deployed
    const block = await chain.inOneBlock(async () => {
      deployed = await chain.send(deployer, factory, "deployPool", [collateral, quote, FIVE_PERCENT])
      await after()
    })
    const pool = String(deployed.returned[0]).toLowerCase()
    field("Pool", pool, "createdAtBlockNumber", block)
    return { address: pool, iface: POOL, block }
  }
  const expectToken = (hostile, name, symbol, decimals) => {
    field("Token", hostile.address, "name", name)
    field("Token", hostile.address, "symbol", symbol)
    field("Token", hostile.address, "decimals", decimals)
  }

  // 1. The factory is told 6 decimals. From the end of that block on, the token says 2^255.
  let hostile = await token(6)
  await deployPool(hostile.address, honestQuote, () => answer(hostile, DECIMALS, word(1n << 255n), RETURN))
  expectToken(hostile, "Hostile", "HOSTILE", 6)

  // 2. The name reverts, the symbol answers nothing, and the decimals, 8 for the factory, revert after.
  hostile = await token(8)
  await answer(hostile, NAME, "0x", REVERT)
  await answer(hostile, SYMBOL, "0x", NOTHING)
  await deployPool(hostile.address, honestQuote, () => answer(hostile, DECIMALS, "0x", REVERT))
  expectToken(hostile, "unknown", "unknown", 8)

  // 3. A megabyte of name. A symbol whose character at the limit takes two UTF-16 code units: cut
  // between them, it is not text, and saving it fails.
  hostile = await token(18)
  await answer(hostile, NAME, word(1_000_000), LONG)
  await answer(hostile, SYMBOL, coder.encode(["string"], ["A".repeat(TEXT_LIMIT - 1) + "\u{1F680}" + "B"]), RETURN)
  await deployPool(hostile.address, honestQuote)
  expectToken(hostile, "A".repeat(TEXT_LIMIT), "A".repeat(TEXT_LIMIT - 1), 18)

  // 4. A name with null bytes, bytes that are not UTF-8 and an encoded surrogate. A symbol that
  // only decodes as a bytes32, and is not text either.
  const notText = "41004200fffeeda080225c43"
  const notTextBytes32 = "ff00fe00" + "41".repeat(28)
  hostile = await token(18)
  await answer(hostile, NAME, rawString(notText), RETURN)
  await answer(hostile, SYMBOL, "0x" + notTextBytes32, RETURN)
  await deployPool(hostile.address, honestQuote)
  expectToken(hostile, asStored(notText), asStored(notTextBytes32), 18)

  // 5. A quote token whose balanceOf reverts from the block of the first deposit on. The pool's
  // readers ask it for the pool's balance, so they revert: the pool stays as it was last read,
  // its actions are still counted, and every other pool is untouched.
  hostile = await token(18)
  const pool = await deployPool(honestCollateral, hostile.address)
  await chain.send(deployer, hostile, "mint", [lenderA, wad(1000)])
  await chain.send(lenderA, hostile, "approve", [pool.address, MAX])
  await chain.inOneBlock(async () => {
    await chain.send(lenderA, pool, "addQuoteToken", [wad(100), 4100, MAX])
    await answer(hostile, BALANCE_OF, "0x", REVERT)
  })
  await chain.send(lenderA, pool, "approveLPTransferors", [[other]])
  expectToken(hostile, "Hostile", "HOSTILE", 18)
  field("Pool", pool.address, "updatedAtBlockNumber", pool.block)
  field("Pool", pool.address, "txCount", 2)

  // 6. LP allowances at indexes past the last bucket, which the pool accepts and the subgraph
  // skips, beside one at a real bucket. The spender is an address nothing else has used.
  const p1 = { address: scenario.pools.P1, iface: POOL }
  const spender = hostile.address
  const far = (1n << 255n).toString()
  await chain.send(lenderA, p1, "increaseLPAllowance", [spender, [far, "4100", MAX.toString()], ["1", "1", "1"]])
  await chain.send(lenderA, p1, "decreaseLPAllowance", [spender, [far], ["1"]])
  await chain.send(lenderA, p1, "revokeLPAllowance", [spender, [far, MAX.toString()]])
  const listId = p1.address + utf8("|") + lenderA.slice(2) + utf8("|") + spender.slice(2)
  field("LPAllowance", listId + utf8("|4100"), "amount", "0.000000000000000001")
  absent("LPAllowance", listId + utf8(`|${far}`))
  absent("LPAllowance", listId + utf8(`|${MAX}`))

  await chain.mine()
  const headBlock = await chain.blockNumber()
  fs.writeFileSync(path.join(OUT, "hostile.json"), JSON.stringify({ headBlock, checks }, null, 2) + "\n")
  console.log(`hostile tokens and arguments are on the chain, which now ends at block ${headBlock}`)
}

main().catch((error) => {
  console.error(`hostile: ${error.message}`)
  process.exit(1)
})
