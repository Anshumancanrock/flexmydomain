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
  outputKey?: Uint8Array
  scriptPubKey?: Uint8Array
  amountSats: bigint
}

/** Build the unsigned settlement tx. One input only. */
export function buildSpend(params: {
  tree: EscrowTree
  leaf: EscrowLeaf
  outpoint: EscrowOutpoint
  destinations: SpendDestination[]
  lockTime?: number
}): Tx {
  const { tree, leaf, outpoint } = params

  if (params.destinations.length === 0) throw new Error('buildSpend: a spend needs at least one destination')

  const outputs: TxOutput[] = params.destinations.map((d) => {
    const scriptPubKey = d.scriptPubKey ?? (d.outputKey ? p2trScript(d.outputKey) : undefined)
    if (!scriptPubKey) throw new Error('buildSpend: every destination needs an output key or a scriptPubKey')
    // Paying the escrow back to itself burns the fee and restarts the timelock.
    if (bytesToHex(scriptPubKey) === bytesToHex(tree.scriptPubKey)) {
      throw new Error('buildSpend: that is the escrow address itself; pay out to an address you control')
    }
    if (d.amountSats <= 0n) throw new Error('buildSpend: a destination amount must be positive')
    // Below dust the output is unspendable and nodes won't relay the tx.
    const dust = dustThreshold(scriptPubKey)
    if (d.amountSats < dust) {
      throw new Error(`buildSpend: ${d.amountSats} sats is below the dust limit of ${dust} for this kind of address`)
    }
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
    sequence: leaf.sequence,
  }

  return { version: tree.txVersion, inputs: [input], outputs, lockTime: params.lockTime ?? 0 }
}

export function dustThreshold(scriptPubKey: Uint8Array): bigint {
  const length = scriptPubKey.length
  const outputSize = 8 + (length < 0xfd ? 1 : 3) + length
  const witnessProgram =
    length >= 4 &&
    length <= 42 &&
    (scriptPubKey[0] === 0x00 || (scriptPubKey[0] >= 0x51 && scriptPubKey[0] <= 0x60)) &&
    scriptPubKey[1] + 2 === length
  const inputSize = witnessProgram ? 32 + 4 + 1 + Math.floor(107 / 4) + 4 : 32 + 4 + 1 + 107 + 4
  return BigInt((outputSize + inputSize) * 3)
}

/** Fee paid and sats per vbyte. */
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

/** The leaf's witness with zeroed signatures, to size the fee before signing. */
function withPlaceholderWitness(tx: Tx, leaf: EscrowLeaf): Tx {
  const shaped = [...leaf.signatureOrder.map(() => new Uint8Array(64)), leaf.script, leaf.controlBlock]
  return {
    ...tx,
    inputs: tx.inputs.map((i) => ({ ...i, witness: i.witness ?? shaped })),
  }
}

/** The message one party signs for this leaf. Separate because the parties sign at different times on different machines. */
export function sighashFor(tx: Tx, leaf: EscrowLeaf, inputIndex = 0): Uint8Array {
  return taprootSighash({ tx, inputIndex, leafHash: leaf.hash, hashType: SIGHASH_DEFAULT })
}

/** Sign for one party. `auxRand` is BIP-340 aux randomness. */
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

/** x-only pubkey for an escrow secret key. Nobody can derive the address alone, so the parties swap these first. */
export function escrowPublicKey(secretKey: Uint8Array): Uint8Array {
  if (secretKey.length !== 32) throw new Error('escrowPublicKey: a secret key is 32 bytes')
  return schnorr.getPublicKey(secretKey)
}

export function escrowPublicKeyHex(secretKey: Uint8Array): string {
  return bytesToHex(escrowPublicKey(secretKey))
}

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

export function finaliseSpend(params: {
  tree: EscrowTree
  leaf: EscrowLeaf
  tx: Tx
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
