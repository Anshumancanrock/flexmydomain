/**
 * Spending an escrow output: build, sign, finalise.
 *
 * web/recover.html is built on this module. From the recovery string it
 * rebuilds the tree, builds a sweep, signs leaf D and prints raw hex to
 * broadcast anywhere, with no network or server.
 *
 * The witness order is easy to get wrong. A tapscript witness is
 * [ ...signatures, script, controlBlock ], with the signatures in the order the
 * script consumes them: for `and_v(v:pk(A), pk(B))`, B's signature at the
 * bottom and A's on top, because the script checks A first and the stack pops
 * in reverse. buildTree records this in `leaf.signatureOrder`, and this module
 * reads it rather than re-deriving it, so the two cannot disagree.
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

/** The output being spent. */
export interface EscrowOutpoint {
  txid: string
  vout: number
  /** What the funding transaction actually paid, in satoshis. */
  amountSats: bigint
}

/** Where the money goes. */
export interface SpendDestination {
  /** A 32-byte taproot output key, or a raw scriptPubKey. */
  outputKey?: Uint8Array
  scriptPubKey?: Uint8Array
  amountSats: bigint
}

/**
 * Build the unsigned settlement transaction.
 *
 * One input: an escrow is funded by one payment to one output. Several partial
 * payments to the same address are not summed, since each extra input would
 * multiply the signing work.
 *
 * The fee is the difference between the input and the outputs. Outputs that
 * total more than the input are refused here, before anything is signed.
 */
export function buildSpend(params: {
  tree: EscrowTree
  leaf: EscrowLeaf
  outpoint: EscrowOutpoint
  destinations: SpendDestination[]
  /** Absolute locktime. Zero for every spend in this project. */
  lockTime?: number
}): Tx {
  const { tree, leaf, outpoint } = params

  if (params.destinations.length === 0) throw new Error('buildSpend: a spend needs at least one destination')

  const outputs: TxOutput[] = params.destinations.map((d) => {
    const scriptPubKey = d.scriptPubKey ?? (d.outputKey ? p2trScript(d.outputKey) : undefined)
    if (!scriptPubKey) throw new Error('buildSpend: every destination needs an output key or a scriptPubKey')
    if (d.amountSats <= 0n) throw new Error('buildSpend: a destination amount must be positive')
    // Below the dust limit an output is unspendable and most nodes will not
    // relay the transaction at all. 330 sats is the P2TR threshold.
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
    /* The sequence comes from the leaf. Leaf D carries the relative timelock
       here and cannot use the RBF marker; the others signal RBF and carry no
       timelock. */
    sequence: leaf.sequence,
  }

  return { version: tree.txVersion, inputs: [input], outputs, lockTime: params.lockTime ?? 0 }
}

/**
 * The fee this spend pays, and what that works out to per virtual byte.
 *
 * An unsigned spend is sized with the witness its leaf will carry, so `leaf`
 * is required until the transaction is finalised. The internal key is NUMS, so
 * there is no key path: every spend is a script-path spend whose witness is
 * the signatures, the leaf script and the control block.
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
 * The witness this leaf will carry, with zeroed signatures, so a fee can be
 * estimated before anything is signed.
 *
 * Schnorr signatures under SIGHASH_DEFAULT are always 64 bytes and the script
 * and control block are known, so the estimate is exact. A wrong estimate
 * means rebuilding and re-signing with every party.
 */
function withPlaceholderWitness(tx: Tx, leaf: EscrowLeaf): Tx {
  const shaped = [...leaf.signatureOrder.map(() => new Uint8Array(64)), leaf.script, leaf.controlBlock]
  return {
    ...tx,
    inputs: tx.inputs.map((i) => ({ ...i, witness: i.witness ?? shaped })),
  }
}

/**
 * The message one party signs for this leaf.
 *
 * Exposed separately because the parties sign at different times and on
 * different machines: the buyer can compute this, sign it, and send back 64
 * bytes without ever holding the seller's key or the finished transaction.
 */
export function sighashFor(tx: Tx, leaf: EscrowLeaf, inputIndex = 0): Uint8Array {
  return taprootSighash({ tx, inputIndex, leafHash: leaf.hash, hashType: SIGHASH_DEFAULT })
}

/**
 * Sign for one party.
 *
 * `auxRand` is BIP-340 auxiliary randomness. Pass 32 bytes to make the
 * signature reproducible, as the test vectors do. Omit it and @noble draws
 * from the platform CSPRNG, which is the right default for a real signature.
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
 * The x-only public key for an escrow secret key. The parties exchange these
 * before either can derive the address, since neither can produce it alone.
 */
export function escrowPublicKey(secretKey: Uint8Array): Uint8Array {
  if (secretKey.length !== 32) throw new Error('escrowPublicKey: a secret key is 32 bytes')
  return schnorr.getPublicKey(secretKey)
}

/** The same, as lowercase hex: what a user copies and pastes. */
export function escrowPublicKeyHex(secretKey: Uint8Array): string {
  return bytesToHex(escrowPublicKey(secretKey))
}

/** Verify one party's signature without assembling anything. */
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
 * Assemble the witness and produce a broadcastable transaction.
 *
 * Every signature is verified against the key the script expects before the
 * witness is built. A transaction assembled from a wrong signature looks like
 * a correct one until a node rejects it, and by then the parties may have
 * stopped watching.
 */
export function finaliseSpend(params: {
  tree: EscrowTree
  leaf: EscrowLeaf
  tx: Tx
  /** One signature per party the leaf requires, keyed by role. */
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

  /* signatureOrder is bottom-of-stack first, which is the order the script
     consumes them. buildTree derived it; re-deriving it here would be a second
     place for it to be wrong. */
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

  // Then the script, then the control block, in that order.
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
 * Build, sign with every key supplied, and finalise: the single-machine path.
 *
 * The cooperative leaf normally does not go through here, since buyer and
 * seller sign on their own machines and exchange 64-byte signatures. This is
 * for the timeout sweep, where one party holds the only key needed, and for
 * tests.
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
