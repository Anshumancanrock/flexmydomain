import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes } from '@noble/hashes/utils.js'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { bech32m } from '@scure/base'

import {
  bytesEqual,
  describeValue,
  taggedHash,
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
  arbiter?: Uint8Array
  timeoutTo: TimeoutTo
  /** Relative lock in blocks, 1..65535. */
  timeoutBlocks: number
  /** 32 bytes the address commits to without changing any leaf: the escrow id. */
  binding?: Uint8Array
}

export interface EscrowLeaf {
  name: LeafName
  role: LeafRole
  script: Uint8Array
  leafVersion: number
  hash: Uint8Array
  merklePath: Uint8Array[]
  /** (leafVersion | parity) || internal key || merklePath, 33 + 32*depth bytes. */
  controlBlock: Uint8Array
  scriptKeyOrder: PartyRole[]
  signatureOrder: PartyRole[]
  witnessStack: string[]
  /** nSequence the spending input must carry. */
  sequence: number
}

export interface BranchStep {
  label: string
  hash: Uint8Array
}

/** Every container is frozen. The Uint8Arrays can't be (freezing a typed array throws), so they're read-only by contract. */
export interface EscrowTree {
  shape: TreeShape
  params: {
    buyer: Uint8Array
    seller: Uint8Array
    arbiter?: Uint8Array
    timeoutTo: TimeoutTo
    timeoutBlocks: number
    binding?: Uint8Array
  }
  /** Keyed by name. Never index leaves by position. */
  leaves: { A: EscrowLeaf; B?: EscrowLeaf; C?: EscrowLeaf; D: EscrowLeaf }
  leafList: EscrowLeaf[]
  branches: BranchStep[]
  merkleRoot: Uint8Array
  internalKey: Uint8Array
  tweak: Uint8Array
  outputKey: Uint8Array
  parity: 0 | 1
  /** OP_1 OP_PUSHBYTES_32 <outputKey>, 34 bytes, any network. */
  scriptPubKey: Uint8Array
  /** Same for every leaf: 97 bytes with 4 leaves, 65 with 2. */
  controlBlockLength: number
  addresses: Record<NetworkName, string>
  /** Spends need nVersion 2 for BIP-68. */
  txVersion: 2
}

const NUMS_BYTES: Uint8Array = sha256(secp256k1.Point.BASE.toBytes(false))

export function numsInternalKey(): Uint8Array {
  return Uint8Array.from(NUMS_BYTES)
}

/** Published BIP-341 value. Tests pin the derivation to it. */
export const NUMS_INTERNAL_KEY_HEX =
  '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0'

const CURVE_ORDER: bigint = secp256k1.Point.Fn.ORDER

export const BINDING_TAG = 'fmd/escrow-binding'

export function bindingInternalKey(binding?: Uint8Array): Uint8Array {
  if (binding === undefined) return numsInternalKey()
  if (!(binding instanceof Uint8Array) || binding.length !== 32) throw new Error('bindingInternalKey: expected 32 bytes')
  const r = bytesToNumberBE(taggedHash(BINDING_TAG, binding))
  if (r === 0n || r >= CURVE_ORDER) throw new Error('bindingInternalKey: the binding gives an unusable scalar')
  const H = schnorr.utils.lift_x(bytesToNumberBE(NUMS_BYTES))
  const P = H.add(secp256k1.Point.BASE.multiply(r)).toAffine()
  return numberToBytesBE(P.x, 32)
}

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

function freezeInPlace<T>(value: T): T {
  Object.freeze(value)
  return value
}

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

const ALLOWED_PARAMS: readonly string[] = [
  'buyer',
  'seller',
  'arbiter',
  'timeoutTo',
  'timeoutBlocks',
  'binding',
]

function validateParams(params: BuildTreeParams): Required<Omit<BuildTreeParams, 'arbiter' | 'binding'>> & {
  arbiter?: Uint8Array
  binding?: Uint8Array
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

  let binding: Uint8Array | undefined
  if ('binding' in params && params.binding !== undefined) {
    if (!(params.binding instanceof Uint8Array) || params.binding.length !== 32) {
      throw new Error('binding: expected 32 bytes, the escrow id')
    }
    binding = copy(params.binding)
  }

  return { buyer, seller, arbiter, timeoutTo: params.timeoutTo, timeoutBlocks: params.timeoutBlocks, binding }
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

/** Each leaf's sibling path, nearest sibling first, as BIP-341's control block wants. Never sort the path. */
function collectPaths(node: Node, path: Uint8Array[], out: Map<LeafName, Uint8Array[]>): void {
  if (node.kind === 'leaf') {
    out.set(node.leaf.name, path)
    return
  }
  collectPaths(node.left, [node.right.hash, ...path], out)
  collectPaths(node.right, [node.left.hash, ...path], out)
}

function signatureOrderFor2of2(scriptKeyOrder: PartyRole[]): PartyRole[] {
  return [...scriptKeyOrder].reverse()
}

export interface TweakResult {
  tweak: Uint8Array
  outputKey: Uint8Array
  parity: 0 | 1
}

export function deriveOutputKey(internalKeyX: Uint8Array, merkleRoot: Uint8Array): TweakResult {
  const tweak = tapTweakHash(internalKeyX, merkleRoot)
  const t = bytesToNumberBE(tweak)
  // BIP-341 says fail, not reduce mod n. A reduced t gives a Q no verifier re-derives.
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

/** Segwit v1 is bech32m (BIP-350), with the version as a raw 5-bit word before the program. */
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
    // Same string as testnet, signet shares `tb`. Carry the network with the address, never infer it from the prefix.
    signet: encodeTaprootAddress(outputKey, NETWORK_HRP.signet),
    regtest: encodeTaprootAddress(outputKey, NETWORK_HRP.regtest),
  }
}

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

  const internalKey = bindingInternalKey(p.binding)
  const { tweak, outputKey, parity } = deriveOutputKey(internalKey, merkleRoot)
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
        internalKey,
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

  const tree: EscrowTree = {
    shape,
    params: freezeInPlace({
      buyer: p.buyer,
      seller: p.seller,
      ...(p.arbiter ? { arbiter: p.arbiter } : {}),
      timeoutTo: p.timeoutTo,
      timeoutBlocks: p.timeoutBlocks,
      ...(p.binding ? { binding: p.binding } : {}),
    }),
    leaves,
    leafList,
    branches,
    merkleRoot,
    internalKey: copy(internalKey),
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

const CONTROL_BLOCK_MAX_NODES = 128
const CONTROL_BLOCK_MAX_SIZE = 33 + 32 * CONTROL_BLOCK_MAX_NODES

/** Re-derive the output key from a script and control block alone, as a BIP-341 verifier does. */
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
