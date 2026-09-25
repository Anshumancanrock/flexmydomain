/**
 * Spending an escrow output: build, sign, finalise. web/recover.html uses it to
 * rebuild the tree, sign a leaf D sweep and print raw hex, offline.
 *
 * Witness is [...signatures, script, controlBlock], signatures in the order the
 * script consumes them. For `and_v(v:pk(A), pk(B))` that's B's at the bottom and
 * A's on top. buildTree records this in `leaf.signatureOrder` and we only read
 * it, so the two can't disagree.
 */

import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  SIGHASH_DEFAULT,
  p2trScript,
  serializeSigned,
  taprootSighash,
  txid as computeTxid,
  vsize,
  type Tx,
  type TxInput,
  type TxOutput,
} from './tx.js'
import type { EscrowLeaf, EscrowTree, PartyRole } from './tree.js'

export interface EscrowOutpoint {
  txid: string
  vout: number
  /** What the funding tx actually paid, in sats. */
  amountSats: bigint
}

export interface SpendDestination {
  /** Either a 32-byte taproot output key or a raw scriptPubKey. */
  outputKey?: Uint8Array
  scriptPubKey?: Uint8Array
  amountSats: bigint
}

/**
 * Build the unsigned settlement tx. One input only. Extra payments to the same
 * address aren't summed, since each input multiplies the signing work. The fee
 * is input minus outputs, and outputs above the input are refused before signing.
 */
export function buildSpend(params: {
  tree: EscrowTree
  leaf: EscrowLeaf
  outpoint: EscrowOutpoint
  destinations: SpendDestination[]
  /** Absolute locktime, always 0 here. */
  lockTime?: number
}): Tx {
  const { tree, leaf, outpoint } = params

  if (params.destinations.length === 0) throw new Error('buildSpend: a spend needs at least one destination')

  const outputs: TxOutput[] = params.destinations.map((d) => {
    const scriptPubKey = d.scriptPubKey ?? (d.outputKey ? p2trScript(d.outputKey) : undefined)
    if (!scriptPubKey) throw new Error('buildSpend: every destination needs an output key or a scriptPubKey')
    if (d.amountSats <= 0n) throw new Error('buildSpend: a destination amount must be positive')
    // Below dust the output is unspendable and most nodes won't relay the tx.
    // 330 sats is the P2TR threshold.
    if (d.amountSats < 330n) throw new Error(`buildSpend: ${d.amountSats} sats is below the P2TR dust limit of 330`)
    return { amountSats: d.amountSats, scriptPubKey }
  })

  const total = outputs.reduce((sum, o) => sum + o.amountSats, 0n)
  if (total > outpoint.amountSats) {
    throw new Error(`buildSpend: outputs total ${total} sats but the input holds ${outpoint.amountSats}`)
  }

  const input: TxInput = {
    txid: outpoint.txid,
    vout: outpoint.vout,
    amountSats: outpoint.amountSats,
    scriptPubKey: tree.scriptPubKey,
    /* From the leaf. Leaf D's holds the CSV lock, the 2-of-2 leaves signal RBF. */
    sequence: leaf.sequence,
  }

  return { version: tree.txVersion, inputs: [input], outputs, lockTime: params.lockTime ?? 0 }
}

/**
 * Fee paid and sats per vbyte. An unsigned tx is sized with its leaf's witness,
 * so `leaf` is required until it's finalised. The internal key is NUMS, so every
 * spend is script-path: signatures, leaf script, control block.
 */
export function feeOf(
  tx: Tx,
  finalised: boolean,
  leaf?: EscrowLeaf,
): { sats: bigint; vbytes: number; satsPerVbyte: number } {
  const input = tx.inputs.reduce((sum, i) => sum + i.amountSats, 0n)
  const output = tx.outputs.reduce((sum, o) => sum + o.amountSats, 0n)
  const sats = input - output
  let vbytes: number
  if (finalised) vbytes = vsize(tx)
  else {
    if (!leaf) throw new Error('feeOf: an unsigned escrow spend is sized by its leaf; pass the leaf being spent')
    vbytes = vsize(withPlaceholderWitness(tx, leaf))
  }
  return { sats, vbytes, satsPerVbyte: Number(sats) / vbytes }
}

/**
 * The leaf's witness with zeroed signatures, to size the fee before signing.
 * Exact, since SIGHASH_DEFAULT Schnorr signatures are always 64 bytes. A wrong
 * estimate means re-signing with every party.
 */
function withPlaceholderWitness(tx: Tx, leaf: EscrowLeaf): Tx {
  const shaped = [...leaf.signatureOrder.map(() => new Uint8Array(64)), leaf.script, leaf.controlBlock]
  return {
    ...tx,
    inputs: tx.inputs.map((i) => ({ ...i, witness: i.witness ?? shaped })),
  }
}

/**
 * The message one party signs for this leaf. Separate because the parties sign
 * at different times on different machines. The buyer can sign and send back 64
 * bytes without the seller's key or the finished tx.
 */
export function sighashFor(tx: Tx, leaf: EscrowLeaf, inputIndex = 0): Uint8Array {
  return taprootSighash({ tx, inputIndex, leafHash: leaf.hash, hashType: SIGHASH_DEFAULT })
}

/**
 * Sign for one party. `auxRand` is BIP-340 aux randomness. Pass 32 bytes for a
 * reproducible signature (the test vectors do), or omit it to let @noble use
 * the platform CSPRNG, the right default for real signatures.
 */
export function signSpend(params: {
  tx: Tx
  leaf: EscrowLeaf
  secretKey: Uint8Array
  inputIndex?: number
  auxRand?: Uint8Array
}): Uint8Array {
  const digest = sighashFor(params.tx, params.leaf, params.inputIndex ?? 0)
  return params.auxRand
    ? schnorr.sign(digest, params.secretKey, params.auxRand)
    : schnorr.sign(digest, params.secretKey)
}

/**
 * x-only pubkey for an escrow secret key. Nobody can derive the address alone,
 * so the parties swap these first.
 */
export function escrowPublicKey(secretKey: Uint8Array): Uint8Array {
  if (secretKey.length !== 32) throw new Error('escrowPublicKey: a secret key is 32 bytes')
  return schnorr.getPublicKey(secretKey)
}

/** Lowercase hex, the form a user copies and pastes. */
export function escrowPublicKeyHex(secretKey: Uint8Array): string {
  return bytesToHex(escrowPublicKey(secretKey))
}

/** Check one party's signature without assembling the witness. */
export function verifySpendSignature(params: {
  tx: Tx
  leaf: EscrowLeaf
  signature: Uint8Array
  pubkey: Uint8Array
  inputIndex?: number
}): boolean {
  try {
    return schnorr.verify(params.signature, sighashFor(params.tx, params.leaf, params.inputIndex ?? 0), params.pubkey)
  } catch {
    return false
  }
}

/**
 * Assemble the witness and return a broadcastable tx. Every signature is checked
 * against the key the script expects first. A bad one looks fine until a node
 * rejects it, and by then the parties may have stopped watching.
 */
export function finaliseSpend(params: {
  tree: EscrowTree
  leaf: EscrowLeaf
  tx: Tx
  /** One per party the leaf requires. */
  signatures: Partial<Record<PartyRole, Uint8Array>>
  inputIndex?: number
}): { tx: Tx; hex: string; txid: string; vbytes: number } {
  const { tree, leaf, tx } = params
  const inputIndex = params.inputIndex ?? 0

  const keys: Record<PartyRole, Uint8Array | undefined> = {
    buyer: tree.params.buyer,
    seller: tree.params.seller,
    arbiter: tree.params.arbiter,
  }

  /* Bottom of stack first, the order the script consumes them. */
  const witness: Uint8Array[] = []
  for (const role of leaf.signatureOrder) {
    const signature = params.signatures[role]
    if (!signature) {
      throw new Error(
        `finaliseSpend: leaf ${leaf.name} needs a signature from the ${role} and none was supplied`,
      )
    }
    if (signature.length !== 64) {
      throw new Error(`finaliseSpend: a SIGHASH_DEFAULT signature is 64 bytes, the ${role} gave ${signature.length}`)
    }
    const pubkey = keys[role]
    if (!pubkey) throw new Error(`finaliseSpend: this tree has no ${role}`)
    if (!verifySpendSignature({ tx, leaf, signature, pubkey, inputIndex })) {
      throw new Error(
        `finaliseSpend: the ${role}'s signature does not verify for leaf ${leaf.name}: ` +
          'it was made for a different transaction, a different leaf, or by a different key',
      )
    }
    witness.push(signature)
  }

  witness.push(leaf.script, leaf.controlBlock)

  const finalised: Tx = {
    ...tx,
    inputs: tx.inputs.map((input, i) => (i === inputIndex ? { ...input, witness } : input)),
  }

  return {
    tx: finalised,
    hex: bytesToHex(serializeSigned(finalised)),
    txid: computeTxid(finalised),
    vbytes: vsize(finalised),
  }
}

/**
 * Build, sign with every key given, finalise, all on one machine. For the
 * timeout sweep (one key) and tests. Cooperative spends are signed separately
 * by buyer and seller, who exchange 64-byte signatures.
 */
export function spendWith(params: {
  tree: EscrowTree
  leaf: EscrowLeaf
  outpoint: EscrowOutpoint
  destinations: SpendDestination[]
  secretKeys: Partial<Record<PartyRole, Uint8Array>>
  auxRand?: Uint8Array
  lockTime?: number
}): { tx: Tx; hex: string; txid: string; vbytes: number } {
  const tx = buildSpend(params)
  const signatures: Partial<Record<PartyRole, Uint8Array>> = {}

  for (const role of params.leaf.signatureOrder) {
    const secretKey = params.secretKeys[role]
    if (!secretKey) {
      throw new Error(`spendWith: leaf ${params.leaf.name} needs the ${role}'s key and none was supplied`)
    }
    signatures[role] = signSpend({ tx, leaf: params.leaf, secretKey, auxRand: params.auxRand })
  }

  return finaliseSpend({ tree: params.tree, leaf: params.leaf, tx, signatures })
}
