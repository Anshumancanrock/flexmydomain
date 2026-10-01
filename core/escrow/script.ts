// The escrow's leaf scripts as exact bytes. These bytes are normative and a descriptor only describes them.

import { concatBytes } from '@noble/hashes/utils.js'

import { describeValue } from './tagged.js'

/** Only the opcodes these leaves use. */
export const OP = Object.freeze({
  /** Pushes the next 32 bytes, an x-only key. */
  PUSH32: 0x20,
  OP_1: 0x51,
  OP_16: 0x60,
  CHECKSIG: 0xac,
  CHECKSIGVERIFY: 0xad,
  CHECKSEQUENCEVERIFY: 0xb2,
  DROP: 0x75,
} as const)

export const XONLY_PUBKEY_BYTES = 32

export const MAX_TIMEOUT_BLOCKS = 0xffff
export const MIN_TIMEOUT_BLOCKS = 1

export function scriptNum(n: number): Uint8Array {
  if (!Number.isInteger(n)) {
    throw new Error(`scriptNum: expected an integer, got ${describeValue(n)}`)
  }
  if (n < 0) {
    throw new Error(`scriptNum: negative values are not used by this protocol, got ${describeValue(n)}`)
  }
  if (n === 0) return new Uint8Array(0)
  const out: number[] = []
  let v = n
  while (v > 0) {
    out.push(v & 0xff)
    v = Math.floor(v / 256)
  }
  if (out[out.length - 1] & 0x80) out.push(0x00)
  return Uint8Array.from(out)
}

export function minimalPushNum(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`minimalPushNum: expected a non-negative integer, got ${describeValue(n)}`)
  }
  if (n >= 1 && n <= 16) return Uint8Array.of(OP.OP_1 + n - 1)
  const payload = scriptNum(n)
  if (payload.length > 75) {
    throw new Error(`minimalPushNum: ${n} needs OP_PUSHDATA, which this protocol never uses`)
  }
  return concatBytes(Uint8Array.of(payload.length), payload)
}

function assertXOnly(name: string, key: Uint8Array): void {
  if (!(key instanceof Uint8Array)) throw new Error(`${name}: expected a Uint8Array`)
  if (key.length !== XONLY_PUBKEY_BYTES) {
    throw new Error(`${name}: expected a ${XONLY_PUBKEY_BYTES}-byte x-only pubkey, got ${key.length} bytes`)
  }
}

function pushKey(key: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(OP.PUSH32), key)
}

/** 2-of-2 leaf: `<X1> OP_CHECKSIGVERIFY <X2> OP_CHECKSIG`, 68 bytes. */
export function cooperativeLeaf(firstKey: Uint8Array, secondKey: Uint8Array): Uint8Array {
  assertXOnly('cooperativeLeaf/firstKey', firstKey)
  assertXOnly('cooperativeLeaf/secondKey', secondKey)
  return concatBytes(
    pushKey(firstKey),
    Uint8Array.of(OP.CHECKSIGVERIFY),
    pushKey(secondKey),
    Uint8Array.of(OP.CHECKSIG),
  )
}

export function timeoutLeaf(timeoutBlocks: number, payeeKey: Uint8Array): Uint8Array {
  assertXOnly('timeoutLeaf/payeeKey', payeeKey)
  assertTimeoutBlocks(timeoutBlocks)
  return concatBytes(
    minimalPushNum(timeoutBlocks),
    Uint8Array.of(OP.CHECKSEQUENCEVERIFY, OP.DROP),
    pushKey(payeeKey),
    Uint8Array.of(OP.CHECKSIG),
  )
}

export function assertTimeoutBlocks(timeoutBlocks: number): void {
  if (typeof timeoutBlocks !== 'number' || !Number.isInteger(timeoutBlocks)) {
    throw new Error(`timeoutBlocks: expected an integer, got ${describeValue(timeoutBlocks)}`)
  }
  if (timeoutBlocks < MIN_TIMEOUT_BLOCKS || timeoutBlocks > MAX_TIMEOUT_BLOCKS) {
    throw new Error(
      `timeoutBlocks: must be in ${MIN_TIMEOUT_BLOCKS}..${MAX_TIMEOUT_BLOCKS} (BIP-68 block range), got ${timeoutBlocks}`,
    )
  }
}

/** Segwit v1 scriptPubKey `OP_1 OP_PUSHBYTES_32 <Q_x>`, 34 bytes. Same on every network. */
export function taprootScriptPubKey(outputKey: Uint8Array): Uint8Array {
  assertXOnly('taprootScriptPubKey/outputKey', outputKey)
  return concatBytes(Uint8Array.of(OP.OP_1, OP.PUSH32), outputKey)
}

export function timeoutSequence(timeoutBlocks: number): number {
  assertTimeoutBlocks(timeoutBlocks)
  return timeoutBlocks
}

export const RBF_SEQUENCE = 0xfffffffd
