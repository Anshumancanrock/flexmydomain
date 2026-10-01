import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { addressToScript } from './address.js'
import { buildSpend, feeOf, finaliseSpend, signSpend, verifySpendSignature } from './spend.js'
import type { Tx } from './tx.js'
import type { EscrowTree, LeafName, NetworkName, PartyRole } from './tree.js'

export type SettlementKind = 'release' | 'refund'
export type SettlementLeaf = 'A' | 'B' | 'C'

export const PROPOSER: Readonly<Record<SettlementKind, 'buyer' | 'seller'>> = Object.freeze({ release: 'seller', refund: 'buyer' })

export const SETTLEMENT_LEAVES: Readonly<Record<SettlementKind, readonly SettlementLeaf[]>> = Object.freeze({
  release: Object.freeze(['A', 'B'] as const),
  refund: Object.freeze(['A', 'C'] as const),
})

/** Past this the fee is a mistake, not a choice. */
export const MAX_FEE_RATE = 1000

export interface Settlement {
  kind: SettlementKind
  leaf: SettlementLeaf
  outpoint: string
  /** Receives the whole output less the fee. */
  dest: string
  fee: number
}

export interface SignedSettlement extends Settlement {
  /** 64-byte BIP-340 signature, hex. */
  sig: string
}

const OUTPOINT = /^([0-9a-f]{64}):(\d{1,10})$/

/** Why this isn't a well-formed settlement, for anything read off a relay. */
export function settlementProblem(raw: unknown, signed = true): string | undefined {
  if (typeof raw !== 'object' || raw === null) return 'not an object'
  const s = raw as Record<string, unknown>
  if (s.kind !== 'release' && s.kind !== 'refund') return 'kind is neither release nor refund'
  if (!(SETTLEMENT_LEAVES[s.kind] as readonly unknown[]).includes(s.leaf)) return `a ${s.kind} can't use leaf ${String(s.leaf)}`
  if (typeof s.outpoint !== 'string' || !OUTPOINT.test(s.outpoint) || Number(s.outpoint.split(':')[1]) > 0xffffffff) {
    return 'outpoint is not txid:vout'
  }
  if (typeof s.dest !== 'string' || s.dest.length === 0 || s.dest.length > 120) return 'no destination address'
  if (!Number.isSafeInteger(s.fee) || (s.fee as number) < 1) return 'fee is not a positive whole number of sats'
  if (signed && (typeof s.sig !== 'string' || !/^[0-9a-f]{128}$/.test(s.sig))) return 'signature is not 64 bytes of hex'
  return undefined
}

/** Equal for two settlements exactly when a signature on one is valid for the other. */
export function settlementKey(s: Settlement): string {
  return `${s.kind}:${s.leaf}:${s.outpoint}:${s.dest}:${s.fee}`
}

export function signersOf(leaf: SettlementLeaf): readonly PartyRole[] {
  return leaf === 'A' ? ['buyer', 'seller'] : leaf === 'B' ? ['seller', 'arbiter'] : ['buyer', 'arbiter']
}

export function settlementTx(params: { tree: EscrowTree; settlement: Settlement; value: bigint; network: NetworkName }): Tx {
  const { tree, settlement, value } = params
  const problem = settlementProblem(settlement, false)
  if (problem) throw new Error(`settlementTx: ${problem}`)
  const leaf = tree.leaves[settlement.leaf]
  if (!leaf) throw new Error(`settlementTx: this escrow has no leaf ${settlement.leaf}`)
  const fee = BigInt(settlement.fee)
  if (fee >= value) throw new Error(`settlementTx: a fee of ${fee} sats leaves nothing of the ${value} in the escrow`)

  const [txid, vout] = settlement.outpoint.split(':')
  return buildSpend({
    tree,
    leaf,
    outpoint: { txid, vout: Number(vout), amountSats: value },
    destinations: [{ scriptPubKey: addressToScript(settlement.dest, params.network), amountSats: value - fee }],
  })
}

/** The fee for `rate` sat/vB, rounded up. Leaves A, B and C spend at the same size. */
export function settlementFee(params: {
  tree: EscrowTree
  settlement: Omit<Settlement, 'fee'>
  value: bigint
  network: NetworkName
  rate: number
}): number {
  if (!Number.isFinite(params.rate) || params.rate <= 0 || params.rate > MAX_FEE_RATE) {
    throw new Error(`settlementFee: ${params.rate} sat/vB is outside 0..${MAX_FEE_RATE}`)
  }
  // Size doesn't depend on the fee, so price a one-sat draft.
  const draft = settlementTx({ ...params, settlement: { ...params.settlement, fee: 1 } })
  const { vbytes } = feeOf(draft, false, params.tree.leaves[params.settlement.leaf])
  return Math.ceil(params.rate * vbytes)
}

export function signSettlement(params: {
  tree: EscrowTree
  settlement: Settlement
  value: bigint
  network: NetworkName
  secretKey: Uint8Array
  auxRand?: Uint8Array
}): SignedSettlement {
  const role = roleOf(params.tree, schnorr.getPublicKey(params.secretKey))
  if (!role || !signersOf(params.settlement.leaf).includes(role)) {
    throw new Error(`signSettlement: this key is not one of leaf ${params.settlement.leaf}'s two signers`)
  }
  const tx = settlementTx(params)
  const sig = signSpend({ tx, leaf: params.tree.leaves[params.settlement.leaf]!, secretKey: params.secretKey, auxRand: params.auxRand })
  const { kind, leaf, outpoint, dest, fee } = params.settlement
  return { kind, leaf, outpoint, dest, fee, sig: bytesToHex(sig) }
}

/** Whether `signed.sig` is `role`'s signature on this settlement. Never throws. */
export function verifySettlement(params: {
  tree: EscrowTree
  signed: SignedSettlement
  value: bigint
  network: NetworkName
  role: PartyRole
}): boolean {
  try {
    if (settlementProblem(params.signed)) return false
    if (!signersOf(params.signed.leaf).includes(params.role)) return false
    const pubkey = params.tree.params[params.role]
    if (!pubkey) return false
    return verifySpendSignature({
      tx: settlementTx({ ...params, settlement: params.signed }),
      leaf: params.tree.leaves[params.signed.leaf]!,
      signature: hexToBytes(params.signed.sig),
      pubkey,
    })
  } catch {
    return false
  }
}

export function completeSettlement(params: {
  tree: EscrowTree
  settlement: Settlement
  value: bigint
  network: NetworkName
  signatures: Partial<Record<PartyRole, string>>
}): { hex: string; txid: string; vbytes: number } {
  const signatures: Partial<Record<PartyRole, Uint8Array>> = {}
  for (const role of signersOf(params.settlement.leaf)) {
    const sig = params.signatures[role]
    if (sig === undefined || !/^[0-9a-f]{128}$/.test(sig)) {
      throw new Error(`completeSettlement: leaf ${params.settlement.leaf} needs the ${role}'s signature`)
    }
    signatures[role] = hexToBytes(sig)
  }
  const { hex, txid, vbytes } = finaliseSpend({
    tree: params.tree,
    leaf: params.tree.leaves[params.settlement.leaf]!,
    tx: settlementTx(params),
    signatures,
  })
  return { hex, txid, vbytes }
}

export interface BoardEntry {
  settlement: Settlement
  sigs: Partial<Record<PartyRole, string>>
  complete: boolean
}

export function collectSettlements(params: {
  tree: EscrowTree
  network: NetworkName
  outpoint: string
  value: bigint
  sources: readonly { role: PartyRole; sigs: readonly SignedSettlement[] }[]
}): BoardEntry[] {
  const board = new Map<string, BoardEntry>()
  for (const { role, sigs } of params.sources) {
    for (const signed of sigs) {
      if (signed.outpoint !== params.outpoint) continue
      if (!verifySettlement({ tree: params.tree, signed, value: params.value, network: params.network, role })) continue
      const { kind, leaf, outpoint, dest, fee } = signed
      const key = settlementKey(signed)
      const entry = board.get(key) ?? { settlement: { kind, leaf, outpoint, dest, fee }, sigs: {}, complete: false }
      entry.sigs[role] = signed.sig
      entry.complete = signersOf(leaf).every((r) => entry.sigs[r] !== undefined)
      board.set(key, entry)
    }
  }
  return [...board.values()]
}

export function proposalOf(board: readonly BoardEntry[], kind: SettlementKind, leaf: SettlementLeaf): BoardEntry | undefined {
  return board.find((e) => e.settlement.kind === kind && e.settlement.leaf === leaf && e.sigs[PROPOSER[kind]] !== undefined)
}

export function leafOfWitness(tree: EscrowTree, witness: readonly string[]): LeafName | undefined {
  const stack = witness.length >= 2 && witness[witness.length - 1].startsWith('50') ? witness.slice(0, -1) : witness
  if (stack.length < 2) return undefined
  const script = stack[stack.length - 2]
  return tree.leafList.find((l) => bytesToHex(l.script) === script)?.name
}

/** Which party an x-only key is in this tree. */
export function roleOf(tree: EscrowTree, pubkey: Uint8Array): PartyRole | undefined {
  const hex = bytesToHex(pubkey)
  if (hex === bytesToHex(tree.params.buyer)) return 'buyer'
  if (hex === bytesToHex(tree.params.seller)) return 'seller'
  if (tree.params.arbiter && hex === bytesToHex(tree.params.arbiter)) return 'arbiter'
  return undefined
}
