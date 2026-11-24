import { Address } from "@graphprotocol/graph-ts"

// A distinct address for each n, e.g. testAddress(26) is 0x000000000000000000000000000000000000001a.
export function testAddress(n: i32): Address {
  return Address.fromString("0x" + n.toString(16).padStart(40, "0"))
}
