/**
 * Bitcoin transaction serialisation and the BIP-341 signature message.
 *
 * Like the rest of core/escrow, this is written over @noble primitives
 * without @scure/btc-signer, so test/vectors/spend.test.ts compares two
 * independent implementations. test/regtest then checks the same spends
 * against Bitcoin Core's consensus rules.
 *
 * A txid is little-endian on the wire and big-endian wherever a person reads
 * one; an amount is eight bytes little-endian; a script is length-prefixed
 * with CompactSize, not with a push opcode. Getting any of these wrong still
 * gives a well-formed transaction, one that spends the wrong thing or nothing.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, hexToBytes, bytesToHex } from '@noble/hashes/utils.js'
import { compactSize, taggedHash } from './tagged.js'

/** BIP-341 sighash epoch. Prepended to the message before tagging. */
const SIGHASH_EPOCH = 0x00

/** SIGHASH_DEFAULT: sign everything, and emit a 64-byte signature. */
export const SIGHASH_DEFAULT = 0x00

/** Script-path spends set ext_flag = 1, so spend_type = 2 with no annex. */
const EXT_FLAG_SCRIPT_PATH = 1

/** BIP-342 key version. The only one defined. */
const KEY_VERSION = 0

/** No escrow leaf contains OP_CODESEPARATOR. */
const NO_CODESEP = 0xffffffff

export interface TxInput {
  /** The funding transaction id, big-endian, as a person reads it. */
  txid: string
  vout: number
  /** What this input is worth, in satoshis. Signed over by BIP-341. */
  amountSats: bigint
  /** The scriptPubKey being spent. Signed over by BIP-341. */
  scriptPubKey: Uint8Array
  sequence: number
  /** Filled in by the finaliser. */
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

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

/** 4 bytes, little-endian. */
export function u32(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new Error(`u32: expected a uint32, got ${n}`)
  }
  return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff)
}

/** 8 bytes, little-endian. Amounts are bigint so 21M BTC cannot lose precision. */
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
 * A txid on the wire is the reverse of the txid a person reads.
 *
 * Block explorers, RPC calls and error messages show the big-endian form; the
 * serialised transaction carries little-endian. Mixing them produces a
 * transaction that spends an output that does not exist, and the only symptom
 * is "missing inputs" from the node, with no further detail.
 */
export function outpointBytes(txid: string, vout: number): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error(`outpoint: txid must be 64 lowercase hex characters, got ${txid}`)
  return concatBytes(hexToBytes(txid).reverse(), u32(vout))
}

/** Length-prefixed with CompactSize, not with a script push opcode. */
function withLength(bytes: Uint8Array): Uint8Array {
  return concatBytes(compactSize(bytes.length), bytes)
}

/** The legacy (no-witness) serialisation. This is what a txid hashes. */
export function serializeUnsigned(tx: Tx): Uint8Array {
  const parts: Uint8Array[] = [u32(tx.version), compactSize(tx.inputs.length)]
  for (const input of tx.inputs) {
    // scriptSig is always empty for a taproot spend; the witness carries it.
    parts.push(outpointBytes(input.txid, input.vout), compactSize(0), u32(input.sequence))
  }
  parts.push(compactSize(tx.outputs.length))
  for (const output of tx.outputs) parts.push(u64(output.amountSats), withLength(output.scriptPubKey))
  parts.push(u32(tx.lockTime))
  return concatBytes(...parts)
}

/**
 * The full segwit serialisation, with the marker, flag and witnesses.
 *
 * This is what gets broadcast. The txid is still the hash of the serialisation
 * without the witness, so changing the witness cannot change the txid, and
 * {@link txid} uses serializeUnsigned.
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

/** double-sha256 of the witness-free serialisation, reversed for display. */
export function txid(tx: Tx): string {
  return bytesToHex(sha256(sha256(serializeUnsigned(tx))).reverse())
}

// ---------------------------------------------------------------------------
// BIP-341 signature message
// ---------------------------------------------------------------------------

/**
 * The message a script-path spend signs.
 *
 * Every input's amount and scriptPubKey is committed to, not just the one
 * being signed. That is BIP-341's fix for the hardware-wallet fee attack
 * segwit v0 had, and it is why this function needs the whole input set.
 *
 * `leafHash` is the TapLeaf hash of the script being executed, and it binds a
 * signature to one leaf: a signature made for the cooperative leaf cannot be
 * replayed into a dispute leaf, even though the same key appears in both.
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
    // Every escrow spend signs the whole transaction. Any other sighash type
    // would leave part of it open to change by someone else, and no spend here
    // needs that.
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
    // The script-path extension, which is what makes this leaf-specific.
    leafHash,
    Uint8Array.of(KEY_VERSION),
    u32(NO_CODESEP),
  )

  // The epoch byte goes inside the tagged hash and outside SigMsg. Putting it
  // anywhere else yields a valid-looking signature no node will accept.
  return taggedHash('TapSighash', Uint8Array.of(SIGHASH_EPOCH), sigMsg)
}

/** A P2TR output script for an arbitrary 32-byte output key. */
export function p2trScript(outputKey: Uint8Array): Uint8Array {
  if (outputKey.length !== 32) throw new Error('p2trScript: an output key is 32 bytes')
  return concatBytes(Uint8Array.of(0x51, 0x20), outputKey)
}

/**
 * The virtual size of a transaction, for fee estimation.
 *
 * weight = base*3 + total, vsize = ceil(weight / 4). Computed from the real
 * serialisation rather than a table of estimates, so it stays correct when the
 * witness changes shape between leaves: leaf D's witness is one signature
 * shorter than leaf A's, with a control block of the same size.
 */
export function vsize(tx: Tx): number {
  const base = serializeUnsigned(tx).length
  const total = serializeSigned(tx).length
  return Math.ceil((base * 3 + total) / 4)
}
