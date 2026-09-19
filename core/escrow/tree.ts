/**
 * buildTree(): the taproot script tree of an escrow.
 *
 * One function builds all four variants: with or without an arbiter, and with
 * the timeout leaf paying the buyer (stage 1) or the seller (stage 2, once the
 * domain is moving). The two-leaf tree depends on that flip: with no arbiter,
 * only a timeout that pays the seller stops a buyer who already has the domain
 * from waiting it out and taking the money back.
 *
 * BIP-341 is implemented here over @noble primitives, without
 * @scure/btc-signer, so test/vectors/escrow.test.ts compares two independent
 * derivations.
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

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export type PartyRole = 'buyer' | 'seller' | 'arbiter'
export type TimeoutTo = 'buyer' | 'seller'
export type LeafName = 'A' | 'B' | 'C' | 'D'
export type LeafRole = 'cooperative' | 'arbiter-release' | 'arbiter-refund' | 'timeout'
export type TreeShape = 'arbiter-4leaf' | 'no-arbiter-2leaf'
export type NetworkName = 'mainnet' | 'testnet' | 'signet' | 'regtest'

export interface BuildTreeParams {
  /** 32-byte x-only (BIP-340) pubkey. Required. */
  buyer: Uint8Array
  /** 32-byte x-only (BIP-340) pubkey. Required. */
  seller: Uint8Array
  /** 32-byte x-only (BIP-340) pubkey. Omit for the two-leaf, no-arbiter tree. */
  arbiter?: Uint8Array
  /** Who the timeout leaf pays: the buyer in stage 1, the seller in stage 2. */
  timeoutTo: TimeoutTo
  /** Relative timelock in blocks, 1..65535. Project values: 1008 / 2016 / 4320. */
  timeoutBlocks: number
}

export interface EscrowLeaf {
  name: LeafName
  role: LeafRole
  /** The exact bytes committed to by the tree. */
  script: Uint8Array
  leafVersion: number
  /** tagged_hash("TapLeaf", version || compact_size(|s|) || s) */
  hash: Uint8Array
  /** Sibling hashes, leaf to root. Not sorted: the sort happens inside TapBranch. */
  merklePath: Uint8Array[]
  /** (leafVersion | parity) || internal key || merklePath. 33 + 32*depth bytes. */
  controlBlock: Uint8Array
  /** The parties whose keys appear in the script, in script order. */
  scriptKeyOrder: PartyRole[]
  /** The parties' signatures in witness order, bottom of stack first. */
  signatureOrder: PartyRole[]
  /** The whole witness stack as labels, bottom of stack first. */
  witnessStack: string[]
  /** nSequence the spending input must carry for this leaf. */
  sequence: number
}

export interface BranchStep {
  label: string
  hash: Uint8Array
}

/**
 * Every container here is frozen: the tree, its params echo, leaves, leafList,
 * branches, addresses, and each leaf's merklePath, key orders and witness
 * stack. The Uint8Arrays cannot be (Object.freeze() on a typed array throws),
 * so their contents are read-only by contract. Copy before mutating: an
 * in-place write to a leaf script, an output key or the params echo makes the
 * tree disagree with the address it was derived for, and a page displaying the
 * derivation cannot detect it.
 */
export interface EscrowTree {
  shape: TreeShape
  /** Echo of the validated inputs, so an auditor need not trust the caller. */
  params: {
    buyer: Uint8Array
    seller: Uint8Array
    arbiter?: Uint8Array
    timeoutTo: TimeoutTo
    timeoutBlocks: number
  }
  /** Leaves keyed by name. Never index a leaf list by position. */
  leaves: { A: EscrowLeaf; B?: EscrowLeaf; C?: EscrowLeaf; D: EscrowLeaf }
  /** The same leaves in canonical A,B,C,D order, for iteration. */
  leafList: EscrowLeaf[]
  /** Every intermediate branch hash, in the order they are combined. */
  branches: BranchStep[]
  merkleRoot: Uint8Array
  /** The BIP-341 NUMS point. There is no key path. */
  internalKey: Uint8Array
  /** t = tagged_hash("TapTweak", internal || root), as bytes. */
  tweak: Uint8Array
  /** x(Q) where Q = lift_x(internal) + t*G. */
  outputKey: Uint8Array
  /** y-parity of Q. Carried in control-block byte 0, not in the address. */
  parity: 0 | 1
  /** OP_1 OP_PUSHBYTES_32 <outputKey>. Network-independent, 34 bytes. */
  scriptPubKey: Uint8Array
  /** Every control block in this tree is this many bytes: 97 for 4 leaves, 65 for 2. */
  controlBlockLength: number
  /** bech32m for every network. testnet and signet are the same string by design. */
  addresses: Record<NetworkName, string>
  /** Required nVersion of any spending transaction. BIP-68 needs 2. */
  txVersion: 2
}

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/**
 * The BIP-341 NUMS point, derived here rather than pasted so a reader can see
 * why it is unspendable: its x-coordinate is the SHA-256 of the fixed, public
 * bytes of the uncompressed generator, so nobody chose it and nobody knows its
 * discrete log. Anyone can recompute it in one hash and confirm no key path
 * exists. That check is the reason for using the bare point rather than one
 * offset by a random r*G, which would add a little privacy.
 *
 * The hash is over the uncompressed (65-byte, 0x04-prefixed) generator.
 * Hashing the compressed form gives a different, wrong point.
 */
const NUMS_BYTES: Uint8Array = sha256(secp256k1.Point.BASE.toBytes(false))

/**
 * Returns a fresh copy on every call. A shared exported Uint8Array could be
 * overwritten by any consumer, corrupting every later address derivation in
 * the process; @scure/btc-signer deprecated its TAPROOT_UNSPENDABLE_KEY export
 * for the same reason.
 */
export function numsInternalKey(): Uint8Array {
  return Uint8Array.from(NUMS_BYTES)
}

/** The published BIP-341 value, kept so the tests can pin the derivation to it. */
export const NUMS_INTERNAL_KEY_HEX =
  '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0'

const CURVE_ORDER: bigint = secp256k1.Point.Fn.ORDER

/**
 * bech32 human-readable parts. Signet uses testnet's `tb`.
 *
 * Frozen because it is read at derivation time: a writable table would let any
 * consumer in the process relabel every address this module produces, showing
 * a mainnet escrow as `tb1...` or the reverse.
 */
export const NETWORK_HRP: Readonly<Record<NetworkName, string>> = Object.freeze({
  mainnet: 'bc',
  testnet: 'tb',
  signet: 'tb',
  regtest: 'bcrt',
})

// ---------------------------------------------------------------------------
// small pure helpers
// ---------------------------------------------------------------------------

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

/** Defensive copy, so a caller mutating its input cannot change the returned tree. */
function copy(b: Uint8Array): Uint8Array {
  return Uint8Array.from(b)
}

/**
 * Freeze in place, keeping the declared type.
 *
 * `Object.freeze(xs)` widens a `T[]` to `readonly T[]`, which does not fit the
 * interface; returning the original binding keeps the type. Only called on
 * containers: freezing a non-empty Uint8Array throws in both V8 and JSC, which
 * is why EscrowTree documents its byte arrays as read-only by contract.
 */
function freezeInPlace<T>(value: T): T {
  Object.freeze(value)
  return value
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

/**
 * No library downstream repeats these checks. @scure/btc-signer does not
 * recognise the `<n> CSV DROP <key> CHECKSIG` leaf, so building this tree with
 * it needs allowUnknownOutputs=true, which turns off its leaf sanity checks for
 * the whole tree (including "unspendable key in leaf script"). It also accepts
 * two identical leaves.
 *
 * A bad key fails silently and expensively: buyer === seller turns leaf A into
 * a single-signer path that one party can drain alone, and a truncated or
 * off-curve key gives a fundable address whose leaf can never be satisfied.
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
  // lift_x is the BIP-340 even-Y lift. It rejects x >= p and any x that is not
  // on the curve; a key that fails it can never produce a signature.
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
 * The only parameters buildTree accepts.
 *
 * Leaving out `arbiter` swaps the four-leaf tree for the two-leaf one, at a
 * different address, and nothing else signals that choice. So an arbiter key
 * under any other name is an error: the escrow event's wire field is
 * `arbiter_x`, and spreading an event straight in would otherwise fund a
 * two-party escrow while the UI shows three parties.
 *
 * TypeScript does not catch this (excess-property checks skip spreads and
 * variables, and `arbiter` is optional), and the pages in web/ call buildTree
 * from untyped JavaScript.
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

// ---------------------------------------------------------------------------
// merkle construction
// ---------------------------------------------------------------------------

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
 * Collect each leaf's sibling path, leaf to root.
 *
 * Each sibling is prepended before descending, so the nearest sibling ends up
 * first and the root's child last: the order BIP-341 requires in the control
 * block. TapBranch sorts the pair it hashes, but the path itself is never
 * sorted. A sorted path still gives a fundable address, yet every script-path
 * spend from it is rejected, and no address-level test catches that.
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
 * Witness order for a `<X1> CHECKSIGVERIFY <X2> CHECKSIG` leaf.
 *
 * Both signatures are pushed before the script runs. CHECKSIGVERIFY pops the
 * key it just pushed (X1) and the signature directly under it, which is the one
 * pushed last, at the top of the stack. So X1's signature sits on top and X2's
 * at the bottom: the party named second in the script signs first in the
 * witness. Getting this wrong fails with a generic "Invalid Schnorr signature",
 * not a structural error, so it is slow to diagnose.
 */
function signatureOrderFor2of2(scriptKeyOrder: PartyRole[]): PartyRole[] {
  return [...scriptKeyOrder].reverse()
}

// ---------------------------------------------------------------------------
// output key
// ---------------------------------------------------------------------------

export interface TweakResult {
  tweak: Uint8Array
  outputKey: Uint8Array
  parity: 0 | 1
}

/**
 * Q = lift_x(P_x) + t*G, where t = int(tagged_hash("TapTweak", P_x || root)).
 *
 * The parity returned is Q's, not P's. P travels as 32 x-only bytes and lift_x
 * always picks the even-Y point, so a parity computed from P would always be 0.
 * Q's parity varies between escrows built from the same internal key, which is
 * why some control blocks start 0xc0 and others 0xc1. Hard-coding either value
 * passes about half the tests and fails the rest only at broadcast.
 */
export function deriveOutputKey(internalKeyX: Uint8Array, merkleRoot: Uint8Array): TweakResult {
  const tweak = tapTweakHash(internalKeyX, merkleRoot)
  const t = bytesToNumberBE(tweak)
  // BIP-341 says fail here rather than reduce mod n: a reduced t gives a Q
  // that no verifier re-derives. The odds are about 2^-128, so this is an
  // assertion, not a retry loop.
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

// ---------------------------------------------------------------------------
// address
// ---------------------------------------------------------------------------

/**
 * Segwit v1 uses bech32m, not bech32 (BIP-350). The witness version enters as
 * a raw 5-bit word ahead of the converted program.
 *
 * Encoding a v1 program with plain bech32 gives a string that differs only in
 * its 6-character checksum: it looks right and is never accepted.
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
    // Identical to testnet by design: signet shares the `tb` HRP, so an address
    // string alone cannot tell you which chain it belongs to. Carry the network
    // alongside it; never infer it from the prefix.
    signet: encodeTaprootAddress(outputKey, NETWORK_HRP.signet),
    regtest: encodeTaprootAddress(outputKey, NETWORK_HRP.regtest),
  }
}

// ---------------------------------------------------------------------------
// buildTree
// ---------------------------------------------------------------------------

/**
 * Build the escrow's taproot script tree.
 *
 * Deterministic: same inputs, same bytes. There is no clock, randomness, I/O or
 * network selection, because web/recover.html has to rebuild the funding
 * address from the parties' pubkeys with no server and no network.
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
    // The sequence field is the relative timelock here, so it cannot also
    // carry the 0xfffffffd RBF marker: bit 31 of that value disables the lock
    // and CSV then fails outright.
    sequence: timeoutSequence(p.timeoutBlocks),
  })

  const byName = new Map(drafts.map((d) => [d.name, leafNode(d)]))
  const shape: TreeShape = p.arbiter ? 'arbiter-4leaf' : 'no-arbiter-2leaf'

  // The grouping is part of the address. TapBranch's lexicographic sort hides
  // a swapped pair inside a branch, but ((A,B),(C,D)) and ((A,C),(B,D)) are
  // different roots, so different escrows, and a control block for one cannot
  // spend the other. The nesting is written out here rather than derived from
  // iteration order or handed to a helper.
  //
  // Do not replace it with @scure/btc-signer's taprootListToTree, which is a
  // weighted (Huffman) builder. With four equal-weight leaves it happens to
  // produce the same root, but returns the leaves in a different order
  // (C,D,A,B), and with any other leaf count or weights it builds a skewed tree
  // (control blocks of 65/129/129/97 bytes). That changes the address and loses
  // the uniform control-block size that keeps a leaf from being identified by
  // its witness size.
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

  // Containers are frozen all the way down. An auditor re-derives against this
  // tree, and its object graph is shared (leaves.A is leafList[0], leaves.B.hash
  // is leaves.A.merklePath[0]), so one stray write would propagate and make the
  // params echo, the leaf bytes and the address disagree. The Uint8Arrays
  // cannot be frozen; see EscrowTree.
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

// ---------------------------------------------------------------------------
// independent verification
// ---------------------------------------------------------------------------

/**
 * BIP-341 limits the merkle path to 0..128 nodes, so a control block is
 * 33 + 32m bytes with m <= 128: at most 4129 (Bitcoin Core's
 * TAPROOT_CONTROL_MAX_SIZE). A longer one is an invalid witness, which Core's
 * VerifyTaprootCommitment rejects on size before it folds a single branch.
 */
const CONTROL_BLOCK_MAX_NODES = 128
const CONTROL_BLOCK_MAX_SIZE = 33 + 32 * CONTROL_BLOCK_MAX_NODES

/**
 * Re-derive the output key from a script and its control block alone, as a
 * BIP-341 verifier does: fold the path leaf to root with sorted TapBranch,
 * tweak the internal key by the resulting root, and compare x(Q) and y-parity.
 *
 * Exported so recover.html and the tests can check a control block
 * independently of the code that built it.
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
  // Not a leaf version: as c[0] this is the annex marker, so BIP-341 has the
  // verifier reject the witness rather than hash it. tapLeafHash throws on it;
  // this function answers true or false, so catch it here.
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
