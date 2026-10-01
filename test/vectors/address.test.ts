// Payout address decoding (core/escrow/address.ts), checked byte for byte against @scure/btc-signer.

import { test, expect, describe } from 'bun:test'
import { bytesToHex } from '@noble/hashes/utils.js'
import { bech32, bech32m } from '@scure/base'
import * as btc from '@scure/btc-signer'
import { schnorr } from '@noble/curves/secp256k1.js'
import { addressToScript, decodeAddress } from '../../core/escrow/address.js'

const REGTEST = { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef }

function reference(address: string, network: typeof btc.NETWORK): string {
  return bytesToHex(btc.OutScript.encode(btc.Address(network).decode(address)))
}

const program = (n: number, fill: number) => new Uint8Array(n).fill(fill)
// btc-signer refuses a taproot program that isn't a real x-only key.
const xonly = (fill: number) => schnorr.getPublicKey(program(32, fill))
const segwit = (coder: typeof bech32, hrp: string, version: number, bytes: Uint8Array) =>
  coder.encode(hrp, [version, ...coder.toWords(bytes)])

// One data character changed to another valid one.
function typo(address: string): string {
  const i = address.length - 10
  const swap = address[i] === 'q' ? 'p' : 'q'
  return address.slice(0, i) + swap + address.slice(i + 1)
}

// Built in code, not copied: a typo in a hand-copied vector would fail for the wrong reason.
const P2WPKH_MAIN = segwit(bech32, 'bc', 0, program(20, 0x11))
const P2WSH_TEST = segwit(bech32, 'tb', 0, program(32, 0x22))
const P2TR_MAIN = segwit(bech32m, 'bc', 1, xonly(0x33))
const P2TR_TEST = segwit(bech32m, 'tb', 1, xonly(0x44))
const P2TR_REGTEST = segwit(bech32m, 'bcrt', 1, xonly(0x55))

const P2PKH_MAIN = btc.Address(btc.NETWORK).encode({ type: 'pkh', hash: program(20, 0x66) })
const P2SH_MAIN = btc.Address(btc.NETWORK).encode({ type: 'sh', hash: program(20, 0x77) })
const P2PKH_TEST = btc.Address(btc.TEST_NETWORK).encode({ type: 'pkh', hash: program(20, 0x88) })

describe('accepted: every standard type, byte-identical to btc-signer', () => {
  const cases: [string, string, typeof btc.NETWORK][] = [
    ['p2wpkh', P2WPKH_MAIN, btc.NETWORK],
    ['p2wsh', P2WSH_TEST, btc.TEST_NETWORK],
    ['p2tr', P2TR_MAIN, btc.NETWORK],
    ['p2tr', P2TR_TEST, btc.TEST_NETWORK],
    ['p2tr', P2TR_REGTEST, REGTEST],
    ['p2pkh', P2PKH_MAIN, btc.NETWORK],
    ['p2sh', P2SH_MAIN, btc.NETWORK],
    ['p2pkh', P2PKH_TEST, btc.TEST_NETWORK],
  ]
  for (const [type, address, network] of cases) {
    test(`${type} ${address.slice(0, 12)}…`, () => {
      const decoded = decodeAddress(address)
      expect(decoded.type).toBe(type as never)
      expect(bytesToHex(decoded.scriptPubKey)).toBe(reference(address, network))
    })
  }

  test('BIP-173 published vector: P2WPKH, upper case', () => {
    const decoded = decodeAddress('BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4')
    expect(bytesToHex(decoded.scriptPubKey)).toBe('0014751e76e8199196d454941c45d1b3a323f1433bd6')
  })

  test('a bitcoin: URI is read for its address', () => {
    const decoded = decodeAddress(`bitcoin:${P2TR_TEST}?amount=0.001&label=x`)
    expect(bytesToHex(decoded.scriptPubKey)).toBe(reference(P2TR_TEST, btc.TEST_NETWORK))
  })
})

describe('refused: the mistakes a checksum exists to catch', () => {
  test('a one-character typo fails the checksum, for every family', () => {
    for (const address of [P2WPKH_MAIN, P2WSH_TEST, P2TR_MAIN, P2TR_TEST]) {
      expect(() => decodeAddress(typo(address))).toThrow(/checksum/)
    }
    const legacy = P2PKH_MAIN.slice(0, -1) + (P2PKH_MAIN.endsWith('2') ? '3' : '2')
    expect(() => decodeAddress(legacy)).toThrow()
  })

  test('a v1 program under a bech32 checksum is refused (BIP-350)', () => {
    expect(() => decodeAddress(segwit(bech32, 'bc', 1, program(32, 1)))).toThrow(/bech32m/)
  })

  test('a v0 program under a bech32m checksum is refused', () => {
    expect(() => decodeAddress(segwit(bech32m, 'bc', 0, program(20, 1)))).toThrow(/bech32 checksum/)
  })

  test('undefined witness versions are refused: anyone could spend them', () => {
    for (const version of [2, 16]) {
      expect(() => decodeAddress(segwit(bech32m, 'bc', version, program(32, 1)))).toThrow(/not defined/)
    }
  })

  test('wrong program lengths are refused', () => {
    expect(() => decodeAddress(segwit(bech32, 'bc', 0, program(25, 1)))).toThrow(/20 or 32/)
    expect(() => decodeAddress(segwit(bech32m, 'bc', 1, program(20, 1)))).toThrow(/32 bytes/)
  })

  test('a prefix that is not bitcoin is refused', () => {
    expect(() => decodeAddress(segwit(bech32m, 'tc', 1, program(32, 1)))).toThrow(/prefix/)
    expect(() => decodeAddress(segwit(bech32m, 'ltc', 1, program(32, 1)))).toThrow(/prefix/)
  })

  test('mixed case is refused', () => {
    const mixed = P2TR_TEST.slice(0, -4) + P2TR_TEST.slice(-4).toUpperCase()
    expect(() => decodeAddress(mixed)).toThrow()
  })

  test('garbage and empty input are refused with a reason', () => {
    expect(() => decodeAddress('')).toThrow(/Enter an address/)
    expect(() => decodeAddress('not an address')).toThrow(/not a bitcoin address/)
  })
})

describe('the network must match the escrow', () => {
  test('mainnet addresses only on mainnet', () => {
    expect(addressToScript(P2TR_MAIN, 'mainnet')).toBeInstanceOf(Uint8Array)
    expect(() => addressToScript(P2TR_MAIN, 'signet')).toThrow(/mainnet address/)
    expect(() => addressToScript(P2PKH_MAIN, 'testnet')).toThrow(/mainnet address/)
  })

  test('tb1 serves testnet and signet alike, and not mainnet', () => {
    expect(addressToScript(P2TR_TEST, 'signet')).toBeInstanceOf(Uint8Array)
    expect(addressToScript(P2WSH_TEST, 'testnet')).toBeInstanceOf(Uint8Array)
    expect(() => addressToScript(P2TR_TEST, 'mainnet')).toThrow(/test-network address/)
  })

  test('regtest takes bcrt1, and the base58 forms it shares with testnet', () => {
    expect(addressToScript(P2TR_REGTEST, 'regtest')).toBeInstanceOf(Uint8Array)
    expect(addressToScript(P2PKH_TEST, 'regtest')).toBeInstanceOf(Uint8Array)
    expect(() => addressToScript(P2TR_TEST, 'regtest')).toThrow()
  })
})

test('a prefix every object inherits is still not a bitcoin prefix', () => {
  for (const hrp of ['constructor', '__proto__', 'tostring']) {
    const address = segwit(bech32m, hrp, 1, xonly(0x12))
    expect(() => decodeAddress(address)).toThrow(/not a bitcoin address prefix/)
  }
})

test('a recovery string with a flag this code does not know is refused, not half read', async () => {
  const { encodeRecovery, decodeRecovery } = await import('../../core/escrow/recovery.js')
  const { base64urlnopad } = await import('@scure/base')
  const { sha256 } = await import('@noble/hashes/sha2.js')
  const sk = new Uint8Array(32).fill(3)
  const good = encodeRecovery({
    version: 1, secretKey: sk, buyer: xonly(0x31), seller: xonly(0x32), timeoutTo: 'buyer', timeoutBlocks: 144,
  })
  expect(decodeRecovery(good).ok).toBe(true)

  // Bit 4 set, with a fresh checksum. Bits 0 to 3 are taken.
  const prefix = good.slice(0, good.indexOf('1') + 1)
  const bytes = base64urlnopad.decode(good.slice(prefix.length))
  const payload = bytes.slice(0, bytes.length - 4)
  payload[1] |= 0b1_0000
  const tampered = prefix + base64urlnopad.encode(new Uint8Array([...payload, ...sha256(payload).slice(0, 4)]))
  const r = decodeRecovery(tampered)
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.reason).toContain('newer format')
})
