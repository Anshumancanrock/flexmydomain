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
  bindingInternalKey,
  numsInternalKey,
  BINDING_TAG,
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
  dustThreshold,
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
  MAX_FEE_RATE,
  PROPOSER,
  SETTLEMENT_LEAVES,
  collectSettlements,
  completeSettlement,
  leafOfWitness,
  proposalOf,
  roleOf,
  settlementFee,
  settlementKey,
  settlementProblem,
  settlementTx,
  signSettlement,
  signersOf,
  verifySettlement,
} from './settle.js'
export type { BoardEntry, Settlement, SettlementKind, SettlementLeaf, SignedSettlement } from './settle.js'

export { SPACESHIP_IANA_ID, TRANSFER_LOCK_DAYS, normaliseAccount, registrarFindings } from './registrar.js'

export { MIN_ARBITER_BLOCKS, SITE_RULES, arbiterRule, deadlines, rulesProblem } from './trade.js'
export type { Deadlines, RuleAction, RuleVerdict, Stage, TradeFacts, TradeRules } from './trade.js'

import { bytesToHex } from '@noble/hashes/utils.js'
import type { EscrowTree } from './tree.js'

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
