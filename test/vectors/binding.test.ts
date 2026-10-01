// The escrow id bound into the taproot internal key (core/escrow/tree.ts).

import { test, expect, describe } from 'bun:test'
import { createHash } from 'node:crypto'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { base64urlnopad } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import * as btc from '@scure/btc-signer'

import {
  BINDING_TAG,
  NUMS_INTERNAL_KEY_HEX,
  bindingInternalKey,
  buildTree,
  cooperativeLeaf,
  decodeRecovery,
  encodeRecovery,
  rebuildFromRecovery,
  signSettlement,
  timeoutLeaf,
  verifyControlBlock,
  verifySettlement,
  type Settlement,
} from '../../core/escrow/index.ts'
import { deriveEscrowId, escrowAddress, escrowTree, type EscrowParams } from '../../core/nostr/index.ts'

const hex = (b: Uint8Array) => bytesToHex(b)
const secretInt = (n: number) => {
  const b = new Uint8Array(32)
  b[31] = n
  return b
}
const BUYER = secretInt(1)
const SELLER = secretInt(2)
const ARBITER = secretInt(3)
const x = (sk: Uint8Array) => schnorr.getPublicKey(sk)

const params = (salt: string): EscrowParams => ({
  salt,
  buyer: x(BUYER),
  seller: x(SELLER),
  arbiter: x(ARBITER),
  timeoutBlocks: 4320,
  deliverBlocks: 288,
  network: 'regtest',
  amountSats: 100_000,
  domain: 'lumenary.com',
})
const FIRST = params('11'.repeat(32))
const SIBLING = params('22'.repeat(32))
const ID = deriveEscrowId(FIRST)

// @scure/btc-signer ships no regtest network constant.
const REGTEST = { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef }

const G = secp256k1.Point.BASE
const N = secp256k1.Point.Fn.ORDER
const H = secp256k1.Point.fromHex('02' + NUMS_INTERNAL_KEY_HEX)

// BIP-340 tagged hash on node's sha256, independent of the one core/escrow uses.
function scalarOf(binding: Uint8Array): bigint {
  const tag = createHash('sha256').update(BINDING_TAG).digest()
  const digest = createHash('sha256').update(tag).update(tag).update(binding).digest()
  const r = BigInt('0x' + digest.toString('hex'))
  expect(r > 0n && r < N).toBe(true)
  return r
}

const BINDINGS = [hexToBytes(ID), new Uint8Array(32), new Uint8Array(32).fill(0xff), hexToBytes(deriveEscrowId(SIBLING))]

describe('the internal key', () => {
  test('without a binding it is the plain BIP-341 NUMS point', () => {
    expect(hex(bindingInternalKey())).toBe(NUMS_INTERNAL_KEY_HEX)
    const t = buildTree({ buyer: x(BUYER), seller: x(SELLER), arbiter: x(ARBITER), timeoutTo: 'buyer', timeoutBlocks: 4320 })
    expect(hex(t.internalKey)).toBe(NUMS_INTERNAL_KEY_HEX)
  })

  test('with one it is x(H + r·G), recomputed with an independent hash', () => {
    for (const b of BINDINGS) {
      const expected = H.add(G.multiply(scalarOf(b))).toAffine().x.toString(16).padStart(64, '0')
      expect(hex(bindingInternalKey(b))).toBe(expected)
    }
  })

  test('subtracting r·G gives back H, at whichever y the key lifts to', () => {
    for (const b of BINDINGS) {
      const P = secp256k1.Point.fromHex('02' + hex(bindingInternalKey(b)))
      const rG = G.multiply(scalarOf(b))
      expect([P, P.negate()].some((p) => p.subtract(rG).equals(H))).toBe(true)
    }
  })

  test('the tag and one value are pinned, since changing either moves every address', () => {
    expect(BINDING_TAG).toBe('fmd/escrow-binding')
    expect(hex(bindingInternalKey(new Uint8Array(32)))).toBe(
      H.add(G.multiply(scalarOf(new Uint8Array(32)))).toAffine().x.toString(16).padStart(64, '0'),
    )
    expect(hex(bindingInternalKey(new Uint8Array(32)))).toBe(PINNED_ZERO_BINDING)
  })

  test('every binding gives its own key', () => {
    const keys = new Set(BINDINGS.map((b) => hex(bindingInternalKey(b))))
    expect(keys.size).toBe(BINDINGS.length)
    expect(keys.has(NUMS_INTERNAL_KEY_HEX)).toBe(false)
  })

  test('a binding that is not 32 bytes is refused, by the key and by the tree', () => {
    for (const bad of [new Uint8Array(31), new Uint8Array(33), new Uint8Array(0)]) {
      expect(() => bindingInternalKey(bad)).toThrow(/32 bytes/)
      expect(() =>
        buildTree({ buyer: x(BUYER), seller: x(SELLER), arbiter: x(ARBITER), timeoutTo: 'buyer', timeoutBlocks: 4320, binding: bad }),
      ).toThrow()
    }
    expect(() => bindingInternalKey(ID as never)).toThrow(/32 bytes/)
  })
})

describe('the bound tree', () => {
  test('agrees with @scure/btc-signer given the same internal key', () => {
    const mine = escrowTree(FIRST)
    const A = { script: cooperativeLeaf(FIRST.buyer, FIRST.seller) }
    const B = { script: cooperativeLeaf(FIRST.seller, FIRST.arbiter) }
    const C = { script: cooperativeLeaf(FIRST.buyer, FIRST.arbiter) }
    const D = { script: timeoutLeaf(FIRST.timeoutBlocks, FIRST.buyer) }
    const theirs = btc.p2tr(bindingInternalKey(hexToBytes(ID)), [[A, B], [C, D]] as never, REGTEST as never, true)
    expect(hex(theirs.tapInternalKey)).toBe(hex(mine.internalKey))
    expect(hex(theirs.tapMerkleRoot!)).toBe(hex(mine.merkleRoot))
    expect(hex(theirs.tweakedPubkey)).toBe(hex(mine.outputKey))
    expect(theirs.address).toBe(mine.addresses.regtest)
  })

  test('every control block carries the bound key and opens to the output key', () => {
    const t = escrowTree(FIRST)
    expect(hex(t.internalKey)).toBe(hex(bindingInternalKey(hexToBytes(ID))))
    for (const leaf of t.leafList) {
      expect(hex(leaf.controlBlock.subarray(1, 33))).toBe(hex(t.internalKey))
      expect(verifyControlBlock(leaf.script, leaf.controlBlock, t.outputKey)).toBe(true)
    }
  })

  test('escrowAddress is the bound tree\'s address on the escrow\'s network', () => {
    expect(escrowAddress(FIRST)).toBe(escrowTree(FIRST).addresses.regtest)
    expect(escrowTree(FIRST).params.binding && hex(escrowTree(FIRST).params.binding!)).toBe(ID)
  })
})

describe('an escrow between the same keys at another salt', () => {
  const first = escrowTree(FIRST)
  const sibling = escrowTree(SIBLING)

  test('has the same leaves, and without the binding the same address', () => {
    expect(first.leafList.map((l) => hex(l.hash))).toEqual(sibling.leafList.map((l) => hex(l.hash)))
    const unbound = (p: EscrowParams) =>
      buildTree({ buyer: p.buyer, seller: p.seller, arbiter: p.arbiter, timeoutTo: 'buyer', timeoutBlocks: p.timeoutBlocks })
    expect(unbound(FIRST).addresses.regtest).toBe(unbound(SIBLING).addresses.regtest)
  })

  test('has another id, another internal key and another address', () => {
    expect(deriveEscrowId(SIBLING)).not.toBe(ID)
    expect(hex(sibling.internalKey)).not.toBe(hex(first.internalKey))
    expect(hex(sibling.outputKey)).not.toBe(hex(first.outputKey))
    expect(sibling.addresses.regtest).not.toBe(first.addresses.regtest)
  })

  test('a signature made under its rules cannot spend the first escrow\'s output, even at the same outpoint', () => {
    const dest = btc.p2wpkh(secp256k1.getPublicKey(secretInt(9), true), REGTEST as never).address!
    const settlement: Settlement = { kind: 'refund', leaf: 'C', outpoint: `${'aa'.repeat(32)}:0`, dest, fee: 500 }
    const value = 100_000n
    for (const secretKey of [BUYER, ARBITER]) {
      const role = secretKey === BUYER ? 'buyer' : 'arbiter'
      const signed = signSettlement({ tree: sibling, settlement, value, network: 'regtest', secretKey, auxRand: new Uint8Array(32) })
      expect(verifySettlement({ tree: sibling, signed, value, network: 'regtest', role })).toBe(true)
      expect(verifySettlement({ tree: first, signed, value, network: 'regtest', role })).toBe(false)
    }
  })
})

describe('the recovery string', () => {
  const base = {
    version: 1,
    secretKey: BUYER,
    buyer: FIRST.buyer,
    seller: FIRST.seller,
    arbiter: FIRST.arbiter,
    timeoutTo: 'buyer' as const,
    timeoutBlocks: FIRST.timeoutBlocks,
  }

  test('carries the binding and rebuilds the bound address', () => {
    const decoded = decodeRecovery(encodeRecovery({ ...base, binding: hexToBytes(ID) }))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(hex(decoded.recovery.binding!)).toBe(ID)
    expect(rebuildFromRecovery(decoded.recovery).tree.addresses.regtest).toBe(escrowAddress(FIRST))
  })

  test('keeps the binding and the funding apart when it has both', () => {
    const funding = { txid: 'cd'.repeat(32), vout: 7, amountSats: 123_456n }
    const decoded = decodeRecovery(encodeRecovery({ ...base, binding: hexToBytes(ID), funding }))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(hex(decoded.recovery.binding!)).toBe(ID)
    expect(decoded.recovery.funding).toEqual(funding)
    expect(rebuildFromRecovery(decoded.recovery).tree.addresses.regtest).toBe(escrowAddress(FIRST))
  })

  test('without one, an older string still decodes to the unbound address', () => {
    const decoded = decodeRecovery(encodeRecovery(base))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.recovery.binding).toBeUndefined()
    const tree = rebuildFromRecovery(decoded.recovery).tree
    expect(hex(tree.internalKey)).toBe(NUMS_INTERNAL_KEY_HEX)
    expect(tree.addresses.regtest).not.toBe(escrowAddress(FIRST))
  })

  test('a binding flag with the bytes missing is refused, not read as something else', () => {
    const good = encodeRecovery({ ...base, arbiter: undefined })
    const prefix = good.slice(0, good.indexOf('1') + 1)
    const bytes = base64urlnopad.decode(good.slice(prefix.length))
    const payload = bytes.slice(0, bytes.length - 4)
    payload[1] |= 0b1000
    const tampered = prefix + base64urlnopad.encode(new Uint8Array([...payload, ...sha256(payload).slice(0, 4)]))
    const r = decodeRecovery(tampered)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('binding is truncated')
  })

  test('a binding that is not 32 bytes is never written', () => {
    expect(() => encodeRecovery({ ...base, binding: new Uint8Array(31) })).toThrow(/binding/)
  })
})

// x(H + r·G) for 32 zero bytes, computed separately in pure Python integer arithmetic.
const PINNED_ZERO_BINDING = 'e60f6c73f1f1ea1dee3d8209f718a56e4d9ea557837498a655012b278ca05d32'
