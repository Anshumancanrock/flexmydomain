/**
 * The escrow's leaf scripts, as exact bytes.
 *
 * These bytes are normative; a descriptor only describes them. The taproot
 * output commits to the bytes, so a single differing opcode changes the leaf
 * hash, the merkle root and the funding address.
 */

import { concatBytes } from '@noble/hashes/utils.js'

import { describeValue } from './tagged.js'

/**
 * The opcodes these leaves use, and only those.
 *
 * Frozen, because `as const` is erased at runtime and these values are read at
 * derivation time: a writable table would let any consumer in the process
 * rewrite every later leaf script and address. Turning CHECKSIGVERIFY into
 * CHECKSIG, for example, silently makes leaf A a 1-of-2 that one party can
 * drain alone.
 */
export const OP = Object.freeze({
  /** Direct push of the next 32 bytes: the x-only pubkey form. */
  PUSH32: 0x20,
  OP_1: 0x51,
  OP_16: 0x60,
  CHECKSIG: 0xac,
  CHECKSIGVERIFY: 0xad,
  CHECKSEQUENCEVERIFY: 0xb2,
  DROP: 0x75,
} as const)

/** BIP-340 x-only public keys are 32 bytes. */
export const XONLY_PUBKEY_BYTES = 32

/**
 * BIP-68 carries the relative lock in the low 16 bits of nSequence, and BIP-112
 * masks the CSV stack operand with 0x0040ffff. A value above 65535 therefore
 * wraps instead of failing: operand 65546 executes as 10 blocks, turning a
 * requested month-long timeout into a 10-block one.
 */
export const MAX_TIMEOUT_BLOCKS = 0xffff
export const MIN_TIMEOUT_BLOCKS = 1

/**
 * CScriptNum: little-endian, sign-magnitude, minimal length.
 *
 * The top byte's 0x80 bit is the sign bit, so a value whose magnitude already
 * sets it needs a trailing 0x00: 40000 encodes as `40 9c 00`, and Bitcoin Core
 * reads the unpadded `40 9c` as -7232. A negative operand makes
 * OP_CHECKSEQUENCEVERIFY fail unconditionally, which locks the timeout path
 * forever.
 *
 * Only non-negative values occur here (timeoutBlocks >= 1), so the negative
 * branch is a guard rather than a code path.
 */
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

/**
 * Push a non-negative integer onto the stack, minimally.
 *
 * Script verification enforces BIP-62 minimal pushes: 1..16 must be the single
 * opcodes OP_1..OP_16, and Bitcoin Core rejects a spend whose operand was
 * pushed as `01 0a` with "Data push larger than necessary". Production
 * timeouts (1008/2016/4320) never reach that branch, but a short regtest
 * timelock does, and the failure shows only at spend time, long after the
 * address was funded.
 */
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

/** `20 <x>`: the x-only key push shared by every leaf. */
function pushKey(key: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(OP.PUSH32), key)
}

/**
 * The 2-of-2 leaf shape: `<X1> OP_CHECKSIGVERIFY <X2> OP_CHECKSIG`, 68 bytes.
 *
 * Leaf A is (buyer, seller), leaf B is (seller, arbiter), leaf C is
 * (buyer, arbiter). All three have the same shape, so on-chain a cooperative
 * settlement looks the same as an arbiter ruling.
 *
 * CHECKSIGVERIFY consumes the top signature on the stack, so the party named
 * second here supplies the signature that appears first in the witness. See
 * signatureOrderFor2of2 in tree.ts.
 */
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

/**
 * The timeout leaf: `<n> OP_CHECKSEQUENCEVERIFY OP_DROP <X> OP_CHECKSIG`.
 *
 * 39 bytes for all three production timeouts (1008/2016/4320), because each
 * encodes to a 2-byte CScriptNum payload. Other values give other sizes (37
 * bytes for n <= 16, 38 for n <= 127, 40 for n >= 32768), so size assertions
 * must be a function of n, never a constant.
 *
 * This leaf intentionally differs from its descriptor: Bitcoin Core's
 * miniscript compiles and_v(v:older(n),pk(K)) to OP_VERIFY (0x69) where this
 * has OP_DROP (0x75). Both are consensus-valid and behave the same here (CSV
 * leaves its operand on the stack; DROP discards it, VERIFY consumes it and
 * requires it to be nonzero, and 1008/2016/4320 are all nonzero), but they
 * give different leaf hashes and so different addresses. The bytes are
 * normative, so this builds the DROP form, and these trees cannot be
 * cross-checked against a Core tr() miniscript descriptor.
 */
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

/**
 * The value is rendered with describeValue, not String(). Values that come
 * through JSON (the escrow event, the recovery flow) can arrive as strings,
 * and `String("4320")` would make the rejection read "expected an integer, got
 * 4320", a message that contradicts itself and points the reader at a range
 * problem that is not there.
 */
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

/**
 * scriptPubKey for a segwit v1 output: `OP_1 OP_PUSHBYTES_32 <Q_x>`, 34 bytes.
 *
 * Network-independent: only the address HRP and checksum change across
 * mainnet, signet/testnet and regtest.
 */
export function taprootScriptPubKey(outputKey: Uint8Array): Uint8Array {
  assertXOnly('taprootScriptPubKey/outputKey', outputKey)
  return concatBytes(Uint8Array.of(OP.OP_1, OP.PUSH32), outputKey)
}

/**
 * nSequence for spending the timeout leaf.
 *
 * The lock lives in the low 16 bits with bit 22 (SEQUENCE_LOCKTIME_TYPE_FLAG,
 * "units of 512 seconds") and bit 31 (SEQUENCE_LOCKTIME_DISABLE_FLAG) both
 * clear, so the value is just the block count. The usual RBF marker 0xfffffffd
 * has bit 31 set and makes CSV fail. A timeout spend is fee-bumped by
 * re-signing with the same nSequence and a smaller output, which needs no
 * counterparty because the leaf has one signer.
 */
export function timeoutSequence(timeoutBlocks: number): number {
  assertTimeoutBlocks(timeoutBlocks)
  return timeoutBlocks
}

/** nSequence for the 2-of-2 leaves: RBF-signalling, no relative lock. */
export const RBF_SEQUENCE = 0xfffffffd
