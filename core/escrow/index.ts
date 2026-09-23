/**
 * core/escrow: the taproot escrow's script tree and addresses, spending, the
 * recovery string, and the registrar-transfer checks that gate funding and
 * release.
 *
 * Produces identical bytes under Bun and in a browser page opened from
 * file://. Uint8Array in, Uint8Array out; no Buffer, node:*, fetch, clock,
 * randomness or config.
 *
 *   import { buildTree } from './core/escrow/index.js'
 *
 * Intra-module specifiers end in .js, not .ts: Bun resolves them to the .ts
 * sources, and they stay valid if the sources are compiled to plain .js.
 *
 *   const tree = buildTree({ buyer, seller, arbiter, timeoutTo: 'buyer', timeoutBlocks: 4320 })
 *   tree.addresses.signet       // fund this
 *   tree.leaves.A.controlBlock  // spend with this
 *   tree.leaves.A.witnessStack  // in this order
 */

export {
  TAG_TAPLEAF,
  TAG_TAPBRANCH,
  TAG_TAPTWEAK,
  TAP_LEAF_VERSION,
  taggedHash,
  compactSize,
  tapLeafHash,
  tapBranchHash,
  tapTweakHash,
  compareBytes,
  bytesEqual,
} from './tagged.js'

export {
  OP,
  XONLY_PUBKEY_BYTES,
  MIN_TIMEOUT_BLOCKS,
  MAX_TIMEOUT_BLOCKS,
  RBF_SEQUENCE,
  scriptNum,
  minimalPushNum,
  cooperativeLeaf,
  timeoutLeaf,
  assertTimeoutBlocks,
  taprootScriptPubKey,
  timeoutSequence,
} from './script.js'

export {
  numsInternalKey,
  NUMS_INTERNAL_KEY_HEX,
  NETWORK_HRP,
  buildTree,
  deriveOutputKey,
  encodeTaprootAddress,
  verifyControlBlock,
} from './tree.js'

export type {
  BuildTreeParams,
  EscrowTree,
  EscrowLeaf,
  BranchStep,
  TweakResult,
  PartyRole,
  TimeoutTo,
  LeafName,
  LeafRole,
  TreeShape,
  NetworkName,
} from './tree.js'

export {
  SIGHASH_DEFAULT,
  outpointBytes,
  p2trScript,
  serializeSigned,
  serializeUnsigned,
  taprootSighash,
  txid,
  u32,
  u64,
  vsize,
} from './tx.js'
export type { Tx, TxInput, TxOutput } from './tx.js'

export { addressToScript, chainOf, decodeAddress } from './address.js'
export type { AddressChain, AddressType, DecodedAddress } from './address.js'

export { RECOVERY_PREFIX, decodeRecovery, encodeRecovery, rebuildFromRecovery } from './recovery.js'
export type { Recovery } from './recovery.js'

export {
  buildSpend,
  escrowPublicKey,
  escrowPublicKeyHex,
  feeOf,
  finaliseSpend,
  sighashFor,
  signSpend,
  spendWith,
  verifySpendSignature,
} from './spend.js'
export type { EscrowOutpoint, SpendDestination } from './spend.js'

export {
  MIN_POLL_GAP_SECONDS,
  REQUIRED_AGREEING_POLLS,
  buildCommitment,
  deriveTransferState,
  fundable,
  registrantActed,
  releasable,
  transferAllowed,
  usable,
} from './transfer.js'
export type { Observation, TransferCommitment, TransferState, TransferVerdict } from './transfer.js'

import { bytesToHex } from '@noble/hashes/utils.js'
import type { EscrowTree } from './tree.js'

/**
 * Render every derived value as hex, so the derivation panel on the escrow
 * page (and anyone auditing an escrow) can read back what was committed to:
 * the leaf bytes, each leaf hash, every branch, the root, the tweak, the
 * output key with its parity, the scriptPubKey, and per leaf the control block
 * and the witness order that leaf requires.
 *
 * The bytes remain the source of truth; this only renders them.
 */
export function describeTree(tree: EscrowTree): {
  shape: string
  internalKey: string
  merkleRoot: string
  tweak: string
  outputKey: string
  parity: 0 | 1
  scriptPubKey: string
  controlBlockLength: number
  txVersion: number
  addresses: Record<string, string>
  branches: { label: string; hash: string }[]
  leaves: {
    name: string
    role: string
    scriptBytes: number
    script: string
    leafHash: string
    merklePath: string[]
    controlBlock: string
    witnessStack: string[]
    sequence: string
  }[]
} {
  return {
    shape: tree.shape,
    internalKey: bytesToHex(tree.internalKey),
    merkleRoot: bytesToHex(tree.merkleRoot),
    tweak: bytesToHex(tree.tweak),
    outputKey: bytesToHex(tree.outputKey),
    parity: tree.parity,
    scriptPubKey: bytesToHex(tree.scriptPubKey),
    controlBlockLength: tree.controlBlockLength,
    txVersion: tree.txVersion,
    addresses: { ...tree.addresses },
    branches: tree.branches.map((b) => ({ label: b.label, hash: bytesToHex(b.hash) })),
    leaves: tree.leafList.map((l) => ({
      name: l.name,
      role: l.role,
      scriptBytes: l.script.length,
      script: bytesToHex(l.script),
      leafHash: bytesToHex(l.hash),
      merklePath: l.merklePath.map(bytesToHex),
      controlBlock: bytesToHex(l.controlBlock),
      witnessStack: l.witnessStack.slice(),
      sequence: `0x${l.sequence.toString(16).padStart(8, '0')} (${l.sequence})`,
    })),
  }
}
