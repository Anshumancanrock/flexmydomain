/**
 * Bitcoin tx serialisation and the BIP-341 signature message. Written over
 * @noble without @scure/btc-signer, so test/vectors/spend.test.ts compares two
 * independent implementations. test/regtest checks the same spends against Core.
 *
 * A txid is little-endian on the wire and big-endian when displayed. Amounts are
 * 8 bytes LE. Scripts get a CompactSize prefix, not a push opcode. Any of these
 * wrong still gives a well-formed tx that spends the wrong thing or nothing.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, hexToBytes, bytesToHex } from '@noble/hashes/utils.js'
import { compactSize, taggedHash } from './tagged.js'

/** BIP-341 sighash epoch, prepended before tagging. */
const SIGHASH_EPOCH = 0x00

/** Signs everything, gives a 64-byte signature. */
export const SIGHASH_DEFAULT = 0x00

/** Script-path spends set ext_flag = 1, so spend_type = 2 with no annex. */
const EXT_FLAG_SCRIPT_PATH = 1

/** BIP-342 key version, the only one defined. */
const KEY_VERSION = 0

/** No escrow leaf contains OP_CODESEPARATOR. */
const NO_CODESEP = 0xffffffff

export interface TxInput {
  /** Big-endian, as displayed. */
  txid: string
  vout: number
  /** Sats. Signed over by BIP-341. */
  amountSats: bigint
  /** Signed over by BIP-341. */
  scriptPubKey: Uint8Array
  sequence: number
  /** Set by the finaliser. */
  witness?: Uint8Array[]
}

export interface TxOutput {
  amountSats: bigint
  scriptPubKey: Uint8Array
}

export interface Tx {
  version: number
  inputs: TxInput[]
  outputs: TxOutput[]
  lockTime: number
}

/** 4 bytes, little-endian. */
export function u32(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new Error(`u32: expected a uint32, got ${n}`)
  }
  return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff)
}

/** 8 bytes, little-endian. bigint so amounts can't lose precision. */
export function u64(n: bigint): Uint8Array {
  if (n < 0n || n > 0xffffffffffffffffn) throw new Error(`u64: expected a uint64, got ${n}`)
  const out = new Uint8Array(8)
  let v = n
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

/**
 * Outpoint with the txid reversed into wire order. Explorers and RPC show the
 * big-endian form. Mixing them up spends an output that doesn't exist, and the
 * node only says "missing inputs".
 */
export function outpointBytes(txid: string, vout: number): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error(`outpoint: txid must be 64 lowercase hex characters, got ${txid}`)
  return concatBytes(hexToBytes(txid).reverse(), u32(vout))
}

function withLength(bytes: Uint8Array): Uint8Array {
  return concatBytes(compactSize(bytes.length), bytes)
}

/** Legacy (no-witness) serialisation, which is what a txid hashes. */
export function serializeUnsigned(tx: Tx): Uint8Array {
  const parts: Uint8Array[] = [u32(tx.version), compactSize(tx.inputs.length)]
  for (const input of tx.inputs) {
    // scriptSig is always empty for taproot, the witness carries it.
    parts.push(outpointBytes(input.txid, input.vout), compactSize(0), u32(input.sequence))
  }
  parts.push(compactSize(tx.outputs.length))
  for (const output of tx.outputs) parts.push(u64(output.amountSats), withLength(output.scriptPubKey))
  parts.push(u32(tx.lockTime))
  return concatBytes(...parts)
}

/**
 * Full segwit serialisation with marker, flag and witnesses, the form that gets
 * broadcast. The txid ignores the witness, see {@link txid}.
 */
export function serializeSigned(tx: Tx): Uint8Array {
  const parts: Uint8Array[] = [
    u32(tx.version),
    Uint8Array.of(0x00, 0x01), // segwit marker + flag
    compactSize(tx.inputs.length),
  ]
  for (const input of tx.inputs) {
    parts.push(outpointBytes(input.txid, input.vout), compactSize(0), u32(input.sequence))
  }
  parts.push(compactSize(tx.outputs.length))
  for (const output of tx.outputs) parts.push(u64(output.amountSats), withLength(output.scriptPubKey))

  for (const input of tx.inputs) {
    const witness = input.witness ?? []
    parts.push(compactSize(witness.length))
    for (const item of witness) parts.push(withLength(item))
  }
  parts.push(u32(tx.lockTime))
  return concatBytes(...parts)
}

/** Double SHA-256 of the witness-free serialisation, reversed for display. */
export function txid(tx: Tx): string {
  return bytesToHex(sha256(sha256(serializeUnsigned(tx))).reverse())
}

/**
 * The message a script-path spend signs.
 *
 * Commits to every input's amount and scriptPubKey, which is BIP-341's fix for
 * the segwit v0 hardware-wallet fee attack, so it needs the whole input set.
 * `leafHash` binds the signature to one leaf, so a cooperative-leaf signature
 * can't be replayed into a dispute leaf with the same key.
 */
export function taprootSighash(params: {
  tx: Tx
  inputIndex: number
  leafHash: Uint8Array
  hashType?: number
}): Uint8Array {
  const { tx, inputIndex, leafHash } = params
  const hashType = params.hashType ?? SIGHASH_DEFAULT

  if (hashType !== SIGHASH_DEFAULT) {
    // Escrow spends sign the whole tx. Any other type would leave part of it
    // open to change by someone else.
    throw new Error(`taprootSighash: only SIGHASH_DEFAULT is supported, got ${hashType}`)
  }
  if (inputIndex < 0 || inputIndex >= tx.inputs.length) {
    throw new Error(`taprootSighash: input index ${inputIndex} is out of range`)
  }
  if (leafHash.length !== 32) throw new Error('taprootSighash: leafHash must be 32 bytes')

  const shaPrevouts = sha256(
    concatBytes(...tx.inputs.map((i) => outpointBytes(i.txid, i.vout))),
  )
  const shaAmounts = sha256(concatBytes(...tx.inputs.map((i) => u64(i.amountSats))))
  const shaScriptPubKeys = sha256(concatBytes(...tx.inputs.map((i) => withLength(i.scriptPubKey))))
  const shaSequences = sha256(concatBytes(...tx.inputs.map((i) => u32(i.sequence))))
  const shaOutputs = sha256(
    concatBytes(...tx.outputs.map((o) => concatBytes(u64(o.amountSats), withLength(o.scriptPubKey)))),
  )

  const sigMsg = concatBytes(
    Uint8Array.of(hashType),
    u32(tx.version),
    u32(tx.lockTime),
    shaPrevouts,
    shaAmounts,
    shaScriptPubKeys,
    shaSequences,
    shaOutputs,
    // spend_type = (ext_flag << 1) | annex_present. Script path, no annex.
    Uint8Array.of(EXT_FLAG_SCRIPT_PATH << 1),
    u32(inputIndex),
    // Script-path extension, which makes the signature leaf-specific.
    leafHash,
    Uint8Array.of(KEY_VERSION),
    u32(NO_CODESEP),
  )

  // Epoch byte goes inside the tagged hash, outside SigMsg. Anywhere else gives
  // a valid-looking signature no node accepts.
  return taggedHash('TapSighash', Uint8Array.of(SIGHASH_EPOCH), sigMsg)
}

/** P2TR scriptPubKey for any 32-byte output key. */
export function p2trScript(outputKey: Uint8Array): Uint8Array {
  if (outputKey.length !== 32) throw new Error('p2trScript: an output key is 32 bytes')
  return concatBytes(Uint8Array.of(0x51, 0x20), outputKey)
}

/**
 * vsize = ceil((base*3 + total) / 4), from the real serialisation so it tracks
 * each leaf's witness shape. Leaf D has one signature fewer than leaf A, with
 * the same control block size.
 */
export function vsize(tx: Tx): number {
  const base = serializeUnsigned(tx).length
  const total = serializeSigned(tx).length
  return Math.ceil((base * 3 + total) / 4)
}
