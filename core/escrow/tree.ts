/**
 * buildTree(): the escrow's taproot script tree, with or without an arbiter,
 * timeout paying the buyer (stage 1) or the seller (stage 2, domain moving).
 * The 2-leaf tree relies on that flip. With no arbiter, only a seller-paid
 * timeout stops a buyer who already has the domain from waiting it out and
 * taking the money back.
 *
 * BIP-341 over @noble directly, no @scure/btc-signer, so
 * test/vectors/escrow.test.ts compares two independent derivations.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes } from '@noble/hashes/utils.js'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { bech32m } from '@scure/base'

import {
  bytesEqual,
  describeValue,
  tapBranchHash,
  tapLeafHash,
  tapTweakHash,
  TAP_LEAF_VERSION,
} from './tagged.js'
import {
  assertTimeoutBlocks,
  cooperativeLeaf,
  RBF_SEQUENCE,
  taprootScriptPubKey,
  timeoutLeaf,
  timeoutSequence,
  XONLY_PUBKEY_BYTES,
} from './script.js'

export type PartyRole = 'buyer' | 'seller' | 'arbiter'
export type TimeoutTo = 'buyer' | 'seller'
export type LeafName = 'A' | 'B' | 'C' | 'D'
export type LeafRole = 'cooperative' | 'arbiter-release' | 'arbiter-refund' | 'timeout'
export type TreeShape = 'arbiter-4leaf' | 'no-arbiter-2leaf'
export type NetworkName = 'mainnet' | 'testnet' | 'signet' | 'regtest'

export interface BuildTreeParams {
  /** 32-byte x-only pubkeys. */
  buyer: Uint8Array
  seller: Uint8Array
  /** Omit for the 2-leaf, no-arbiter tree. */
  arbiter?: Uint8Array
  /** Buyer in stage 1, seller in stage 2. */
  timeoutTo: TimeoutTo
  /** Relative lock in blocks, 1..65535. We use 1008/2016/4320. */
  timeoutBlocks: number
}

export interface EscrowLeaf {
  name: LeafName
  role: LeafRole
  script: Uint8Array
  leafVersion: number
  hash: Uint8Array
  /** Sibling hashes, leaf to root. Unsorted, TapBranch sorts each pair. */
  merklePath: Uint8Array[]
  /** (leafVersion | parity) || internal key || merklePath, 33 + 32*depth bytes. */
  controlBlock: Uint8Array
  /** In script order. */
  scriptKeyOrder: PartyRole[]
  /** Witness order, bottom of stack first. */
  signatureOrder: PartyRole[]
  /** Whole witness as labels, bottom of stack first. */
  witnessStack: string[]
  /** nSequence the spending input must carry. */
  sequence: number
}

export interface BranchStep {
  label: string
  hash: Uint8Array
}

/**
 * Every container is frozen. The Uint8Arrays can't be (freezing a typed array
 * throws), so they're read-only by contract. Copy before mutating. A write to a
 * leaf script, the output key or params makes the tree disagree with its
 * address, and a page showing the derivation can't tell.
 */
export interface EscrowTree {
  shape: TreeShape
  /** Validated inputs, so an auditor needn't trust the caller. */
  params: {
    buyer: Uint8Array
    seller: Uint8Array
    arbiter?: Uint8Array
    timeoutTo: TimeoutTo
    timeoutBlocks: number
  }
  /** Keyed by name. Never index leaves by position. */
  leaves: { A: EscrowLeaf; B?: EscrowLeaf; C?: EscrowLeaf; D: EscrowLeaf }
  /** Same leaves in A,B,C,D order. */
  leafList: EscrowLeaf[]
  /** Intermediate branch hashes in combine order. */
  branches: BranchStep[]
  merkleRoot: Uint8Array
  /** BIP-341 NUMS point. No key path. */
  internalKey: Uint8Array
  /** t = tagged_hash("TapTweak", internal || root). */
  tweak: Uint8Array
  /** x(Q), Q = lift_x(internal) + t*G. */
  outputKey: Uint8Array
  /** y-parity of Q. Goes in control-block byte 0, not the address. */
  parity: 0 | 1
  /** OP_1 OP_PUSHBYTES_32 <outputKey>, 34 bytes, any network. */
  scriptPubKey: Uint8Array
  /** Same for every leaf: 97 bytes with 4 leaves, 65 with 2. */
  controlBlockLength: number
  /** bech32m per network. testnet and signet are the same string. */
  addresses: Record<NetworkName, string>
  /** Spends need nVersion 2 for BIP-68. */
  txVersion: 2
}

/**
 * BIP-341 NUMS point, derived so a reader can check it. x is SHA-256 of the
 * uncompressed generator (65 bytes, 0x04 prefix), so nobody chose it or knows
 * its discrete log, and one hash confirms there's no key path. That check is
 * why we skip the r*G offset, which would add a little privacy. Hashing the
 * compressed G gives a wrong point.
 */
const NUMS_BYTES: Uint8Array = sha256(secp256k1.Point.BASE.toBytes(false))

/**
 * Fresh copy per call. A shared exported array could be overwritten and corrupt
 * every later derivation. @scure/btc-signer deprecated TAPROOT_UNSPENDABLE_KEY
 * for the same reason.
 */
export function numsInternalKey(): Uint8Array {
  return Uint8Array.from(NUMS_BYTES)
}

/** Published BIP-341 value. Tests pin the derivation to it. */
export const NUMS_INTERNAL_KEY_HEX =
  '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0'

const CURVE_ORDER: bigint = secp256k1.Point.Fn.ORDER

/**
 * bech32 HRPs. Signet uses testnet's `tb`. Frozen since a writable table could
 * relabel every address, showing a mainnet escrow as `tb1...` or the reverse.
 */
export const NETWORK_HRP: Readonly<Record<NetworkName, string>> = Object.freeze({
  mainnet: 'bc',
  testnet: 'tb',
  signet: 'tb',
  regtest: 'bcrt',
})

function bytesToNumberBE(b: Uint8Array): bigint {
  let n = 0n
  for (let i = 0; i < b.length; i++) n = (n << 8n) | BigInt(b[i])
  return n
}

function numberToBytesBE(n: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length)
  let v = n
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  if (v !== 0n) throw new Error('numberToBytesBE: value does not fit')
  return out
}

/** Defensive copy, so later writes by the caller can't reach the tree. */
function copy(b: Uint8Array): Uint8Array {
  return Uint8Array.from(b)
}

/**
 * Freeze and return the same binding, keeping `T[]` (Object.freeze would widen
 * it to readonly). Containers only, freezing a non-empty Uint8Array throws.
 */
function freezeInPlace<T>(value: T): T {
  Object.freeze(value)
  return value
}

/**
 * Nothing downstream repeats these checks. @scure/btc-signer doesn't know our
 * CSV/DROP leaf and needs allowUnknownOutputs=true, which turns off its leaf
 * checks for the whole tree. It also accepts duplicate leaves.
 *
 * A bad key fails quietly and costs money. buyer === seller makes leaf A
 * single-signer, and a truncated or off-curve key gives a fundable address
 * whose leaf can never be satisfied.
 */
function validatePubkey(name: string, key: unknown): Uint8Array {
  if (!(key instanceof Uint8Array)) {
    throw new Error(`${name}: expected a Uint8Array x-only pubkey, got ${typeofDescription(key)}`)
  }
  if (key.length !== XONLY_PUBKEY_BYTES) {
    throw new Error(
      `${name}: expected a ${XONLY_PUBKEY_BYTES}-byte x-only pubkey, got ${key.length} bytes`,
    )
  }
  // BIP-340 lift_x rejects x >= p and off-curve x. Such a key can never sign.
  try {
    schnorr.utils.lift_x(bytesToNumberBE(key))
  } catch (cause) {
    throw new Error(`${name}: not a valid x-only point on secp256k1`, { cause })
  }
  if (bytesEqual(key, NUMS_BYTES)) {
    throw new Error(`${name}: equals the NUMS internal key, which nobody can sign for`)
  }
  return copy(key)
}

function typeofDescription(v: unknown): string {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  return typeof v
}

/**
 * Leaving out `arbiter` quietly builds the 2-leaf tree at another address, so
 * an unknown key throws. The event's wire field is `arbiter_x`, and spreading an
 * event straight in would fund a two-party escrow while the UI shows three.
 * TypeScript won't catch it (no excess-property check on spreads or variables),
 * and web/ calls buildTree from plain JS.
 */
const ALLOWED_PARAMS: readonly string[] = [
  'buyer',
  'seller',
  'arbiter',
  'timeoutTo',
  'timeoutBlocks',
]

function validateParams(params: BuildTreeParams): Required<Omit<BuildTreeParams, 'arbiter'>> & {
  arbiter?: Uint8Array
} {
  if (params === null || typeof params !== 'object') {
    throw new Error('buildTree: expected a params object')
  }
  for (const key of Object.keys(params)) {
    if (!ALLOWED_PARAMS.includes(key)) {
      throw new Error(
        `buildTree: unknown parameter ${describeValue(key)}; expected only ` +
          `${ALLOWED_PARAMS.join(', ')}. The arbiter key must arrive as 'arbiter': ` +
          `under any other name it is dropped and this builds the two-leaf ` +
          `no-arbiter tree at a different address.`,
      )
    }
  }
  const buyer = validatePubkey('buyer', params.buyer)
  const seller = validatePubkey('seller', params.seller)

  let arbiter: Uint8Array | undefined
  if ('arbiter' in params && params.arbiter !== undefined) {
    if (params.arbiter === null) {
      throw new Error('arbiter: omit the property for the no-arbiter tree; got null')
    }
    arbiter = validatePubkey('arbiter', params.arbiter)
  }

  if (bytesEqual(buyer, seller)) {
    throw new Error('buyer and seller must be different keys: leaf A would need only one signer')
  }
  if (arbiter) {
    if (bytesEqual(arbiter, buyer)) {
      throw new Error('arbiter must differ from buyer: leaf C would need only one signer')
    }
    if (bytesEqual(arbiter, seller)) {
      throw new Error('arbiter must differ from seller: leaf B would need only one signer')
    }
  }

  if (params.timeoutTo !== 'buyer' && params.timeoutTo !== 'seller') {
    throw new Error(
      `timeoutTo: must be 'buyer' or 'seller', got ${JSON.stringify(params.timeoutTo)}`,
    )
  }
  assertTimeoutBlocks(params.timeoutBlocks)

  return { buyer, seller, arbiter, timeoutTo: params.timeoutTo, timeoutBlocks: params.timeoutBlocks }
}

interface LeafDraft {
  name: LeafName
  role: LeafRole
  script: Uint8Array
  hash: Uint8Array
  scriptKeyOrder: PartyRole[]
  sequence: number
}

type Node = { kind: 'leaf'; leaf: LeafDraft; hash: Uint8Array } | {
  kind: 'branch'
  hash: Uint8Array
  left: Node
  right: Node
}

function leafNode(leaf: LeafDraft): Node {
  return { kind: 'leaf', leaf, hash: leaf.hash }
}

function branchNode(left: Node, right: Node): Node {
  return { kind: 'branch', hash: tapBranchHash(left.hash, right.hash), left, right }
}

/**
 * Each leaf's sibling path, nearest sibling first, as BIP-341's control block
 * wants. Never sort the path. A sorted one still gives a fundable address, but
 * every script-path spend fails and no address-level test catches it.
 */
function collectPaths(node: Node, path: Uint8Array[], out: Map<LeafName, Uint8Array[]>): void {
  if (node.kind === 'leaf') {
    out.set(node.leaf.name, path)
    return
  }
  collectPaths(node.left, [node.right.hash, ...path], out)
  collectPaths(node.right, [node.left.hash, ...path], out)
}

/**
 * Witness order for `<X1> CHECKSIGVERIFY <X2> CHECKSIG`. CHECKSIGVERIFY checks
 * X1 against the signature on top of the stack, so X1's goes on top and X2's at
 * the bottom (second in script, first in witness). A mistake only shows as
 * "Invalid Schnorr signature", which is slow to diagnose.
 */
function signatureOrderFor2of2(scriptKeyOrder: PartyRole[]): PartyRole[] {
  return [...scriptKeyOrder].reverse()
}

export interface TweakResult {
  tweak: Uint8Array
  outputKey: Uint8Array
  parity: 0 | 1
}

/**
 * Q = lift_x(P_x) + t*G, where t = int(tagged_hash("TapTweak", P_x || root)).
 *
 * Returns Q's parity, not P's. lift_x always picks even Y, so P's would always
 * be 0. Q's varies per escrow, hence control blocks starting 0xc0 or 0xc1.
 * Hard-coding either passes about half the tests and fails the rest at broadcast.
 */
export function deriveOutputKey(internalKeyX: Uint8Array, merkleRoot: Uint8Array): TweakResult {
  const tweak = tapTweakHash(internalKeyX, merkleRoot)
  const t = bytesToNumberBE(tweak)
  // BIP-341 says fail, not reduce mod n. A reduced t gives a Q no verifier
  // re-derives. Odds are about 2^-128, so assert, no retry loop.
  if (t >= CURVE_ORDER) throw new Error('TapTweak: t >= curve order; this key set is unusable')
  if (t === 0n) throw new Error('TapTweak: t == 0; this key set is unusable')

  const P = schnorr.utils.lift_x(bytesToNumberBE(internalKeyX))
  const Q = P.add(secp256k1.Point.BASE.multiply(t)).toAffine()
  return {
    tweak,
    outputKey: numberToBytesBE(Q.x, 32),
    parity: (Q.y & 1n) === 0n ? 0 : 1,
  }
}

/**
 * Segwit v1 is bech32m (BIP-350), with the version as a raw 5-bit word before
 * the program. Plain bech32 gives a string that differs only in the checksum.
 * It looks right and is never accepted.
 */
export function encodeTaprootAddress(outputKey: Uint8Array, hrp: string): string {
  if (outputKey.length !== 32) {
    throw new Error(`encodeTaprootAddress: expected a 32-byte output key, got ${outputKey.length}`)
  }
  return bech32m.encode(hrp, [1, ...bech32m.toWords(outputKey)])
}

function allAddresses(outputKey: Uint8Array): Record<NetworkName, string> {
  return {
    mainnet: encodeTaprootAddress(outputKey, NETWORK_HRP.mainnet),
    testnet: encodeTaprootAddress(outputKey, NETWORK_HRP.testnet),
    // Same string as testnet, signet shares `tb`. Carry the network with the
    // address, never infer it from the prefix.
    signet: encodeTaprootAddress(outputKey, NETWORK_HRP.signet),
    regtest: encodeTaprootAddress(outputKey, NETWORK_HRP.regtest),
  }
}

/**
 * Build the escrow's taproot script tree. Deterministic with no clock,
 * randomness or I/O, since web/recover.html rebuilds the address offline from
 * the parties' pubkeys.
 */
export function buildTree(params: BuildTreeParams): EscrowTree {
  const p = validateParams(params)
  const timeoutPayee = p.timeoutTo === 'buyer' ? p.buyer : p.seller

  const drafts: LeafDraft[] = []

  const scriptA = cooperativeLeaf(p.buyer, p.seller)
  drafts.push({
    name: 'A',
    role: 'cooperative',
    script: scriptA,
    hash: tapLeafHash(scriptA),
    scriptKeyOrder: ['buyer', 'seller'],
    sequence: RBF_SEQUENCE,
  })

  if (p.arbiter) {
    const scriptB = cooperativeLeaf(p.seller, p.arbiter)
    drafts.push({
      name: 'B',
      role: 'arbiter-release',
      script: scriptB,
      hash: tapLeafHash(scriptB),
      scriptKeyOrder: ['seller', 'arbiter'],
      sequence: RBF_SEQUENCE,
    })
    const scriptC = cooperativeLeaf(p.buyer, p.arbiter)
    drafts.push({
      name: 'C',
      role: 'arbiter-refund',
      script: scriptC,
      hash: tapLeafHash(scriptC),
      scriptKeyOrder: ['buyer', 'arbiter'],
      sequence: RBF_SEQUENCE,
    })
  }

  const scriptD = timeoutLeaf(p.timeoutBlocks, timeoutPayee)
  drafts.push({
    name: 'D',
    role: 'timeout',
    script: scriptD,
    hash: tapLeafHash(scriptD),
    scriptKeyOrder: [p.timeoutTo],
    sequence: timeoutSequence(p.timeoutBlocks),
  })

  const byName = new Map(drafts.map((d) => [d.name, leafNode(d)]))
  const shape: TreeShape = p.arbiter ? 'arbiter-4leaf' : 'no-arbiter-2leaf'

  // The grouping is part of the address. The TapBranch sort hides a swap inside
  // a pair, but ((A,B),(C,D)) and ((A,C),(B,D)) are different roots, and a
  // control block for one can't spend the other. So the nesting is spelled out.
  //
  // Don't swap in @scure/btc-signer's taprootListToTree, a weighted (Huffman)
  // builder. Four equal leaves give the same root but in C,D,A,B order, and any
  // other count or weights give a skewed tree (65/129/129/97-byte control
  // blocks). That moves the address and loses the uniform control-block size
  // that keeps a leaf from being identified by its witness size.
  let root: Node
  const branches: BranchStep[] = []
  if (p.arbiter) {
    const ab = branchNode(byName.get('A')!, byName.get('B')!)
    const cd = branchNode(byName.get('C')!, byName.get('D')!)
    root = branchNode(ab, cd)
    branches.push(
      { label: 'branch(A,B)', hash: ab.hash },
      { label: 'branch(C,D)', hash: cd.hash },
      { label: 'root = branch(branch(A,B),branch(C,D))', hash: root.hash },
    )
  } else {
    root = branchNode(byName.get('A')!, byName.get('D')!)
    branches.push({ label: 'root = branch(A,D)', hash: root.hash })
  }

  const merkleRoot = root.hash
  const paths = new Map<LeafName, Uint8Array[]>()
  collectPaths(root, [], paths)

  const { tweak, outputKey, parity } = deriveOutputKey(NUMS_BYTES, merkleRoot)
  const scriptPubKey = taprootScriptPubKey(outputKey)

  const leafList: EscrowLeaf[] = drafts.map((d) => {
    const merklePath = paths.get(d.name)!
    const signatureOrder =
      d.name === 'D' ? d.scriptKeyOrder.slice() : signatureOrderFor2of2(d.scriptKeyOrder)
    const leaf: EscrowLeaf = {
      name: d.name,
      role: d.role,
      script: d.script,
      leafVersion: TAP_LEAF_VERSION,
      hash: d.hash,
      merklePath: freezeInPlace(merklePath),
      controlBlock: concatBytes(
        Uint8Array.of(TAP_LEAF_VERSION | parity),
        NUMS_BYTES,
        ...merklePath,
      ),
      scriptKeyOrder: freezeInPlace(d.scriptKeyOrder),
      signatureOrder: freezeInPlace(signatureOrder),
      witnessStack: freezeInPlace([
        ...signatureOrder.map((r) => `sig_${r}`),
        `script_${d.name}`,
        'control_block',
      ]),
      sequence: d.sequence,
    }
    return freezeInPlace(leaf)
  })
  freezeInPlace(leafList)

  const leaves = freezeInPlace(
    Object.fromEntries(leafList.map((l) => [l.name, l])) as EscrowTree['leaves'],
  )

  for (const b of branches) freezeInPlace(b)
  freezeInPlace(branches)

  // Frozen all the way down. The graph is shared (leaves.A is leafList[0],
  // leaves.B.hash is leaves.A.merklePath[0]), so one stray write would spread
  // until the params, leaf bytes and address disagree.
  const tree: EscrowTree = {
    shape,
    params: freezeInPlace({
      buyer: p.buyer,
      seller: p.seller,
      ...(p.arbiter ? { arbiter: p.arbiter } : {}),
      timeoutTo: p.timeoutTo,
      timeoutBlocks: p.timeoutBlocks,
    }),
    leaves,
    leafList,
    branches,
    merkleRoot,
    internalKey: numsInternalKey(),
    tweak,
    outputKey,
    parity,
    scriptPubKey,
    controlBlockLength: leafList[0].controlBlock.length,
    addresses: freezeInPlace(allAddresses(outputKey)),
    txVersion: 2,
  }
  return freezeInPlace(tree)
}

/**
 * BIP-341 caps the path at 128 nodes, so a control block is at most
 * 33 + 32*128 = 4129 bytes (Core's TAPROOT_CONTROL_MAX_SIZE). Core's
 * VerifyTaprootCommitment rejects a longer one on size alone.
 */
const CONTROL_BLOCK_MAX_NODES = 128
const CONTROL_BLOCK_MAX_SIZE = 33 + 32 * CONTROL_BLOCK_MAX_NODES

/**
 * Re-derive the output key from a script and control block alone, as a BIP-341
 * verifier does. Exported so recover.html and the tests can check a control
 * block independently of the code that built it.
 */
export function verifyControlBlock(
  script: Uint8Array,
  controlBlock: Uint8Array,
  outputKey: Uint8Array,
): boolean {
  if (
    controlBlock.length < 33 ||
    controlBlock.length > CONTROL_BLOCK_MAX_SIZE ||
    (controlBlock.length - 33) % 32 !== 0
  ) {
    return false
  }
  const leafVersion = controlBlock[0] & 0xfe
  // 0x50 is the annex marker, not a leaf version. tapLeafHash throws on it and
  // this function returns a boolean, so reject it here.
  if (leafVersion === 0x50) return false
  const parity = (controlBlock[0] & 1) as 0 | 1
  const internalKey = controlBlock.subarray(1, 33)

  let h = tapLeafHash(script, leafVersion)
  for (let i = 33; i < controlBlock.length; i += 32) {
    h = tapBranchHash(h, controlBlock.subarray(i, i + 32))
  }

  let derived: TweakResult
  try {
    derived = deriveOutputKey(internalKey, h)
  } catch {
    return false
  }
  return derived.parity === parity && bytesEqual(derived.outputKey, outputKey)
}
