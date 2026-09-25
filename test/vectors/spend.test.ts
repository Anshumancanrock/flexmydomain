// Escrow spends (serialisation, BIP-341 sighash, witness). Every byte is diffed against
// @scure/btc-signer, which core/escrow doesn't import. test/regtest/e2e.test.ts checks against Core.

import { test, expect, describe } from 'bun:test'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import * as btc from '@scure/btc-signer'

import {
  buildSpend,
  buildTree,
  feeOf,
  finaliseSpend,
  p2trScript,
  serializeSigned,
  serializeUnsigned,
  sighashFor,
  signSpend,
  spendWith,
  taprootSighash,
  txid,
  u64,
  verifySpendSignature,
  vsize,
  type EscrowTree,
  type Tx,
} from '../../core/escrow/index.ts'

const AUX = new Uint8Array(32)
const secret = (fill: number) => new Uint8Array(32).fill(fill)
const xonly = (sk: Uint8Array) => schnorr.getPublicKey(sk)

const BUYER_SK = secret(0x11)
const SELLER_SK = secret(0x22)
const ARBITER_SK = secret(0x33)
const STRANGER_SK = secret(0x44)

const KEYS = { buyer: BUYER_SK, seller: SELLER_SK, arbiter: ARBITER_SK }

const TREE: EscrowTree = buildTree({
  buyer: xonly(BUYER_SK),
  seller: xonly(SELLER_SK),
  arbiter: xonly(ARBITER_SK),
  timeoutTo: 'buyer',
  timeoutBlocks: 4320,
})

const NO_ARBITER: EscrowTree = buildTree({
  buyer: xonly(BUYER_SK),
  seller: xonly(SELLER_SK),
  timeoutTo: 'seller',
  timeoutBlocks: 2016,
})

const OUTPOINT = {
  txid: 'f'.repeat(64),
  vout: 0,
  amountSats: 2_500_000n,
}

const PAYOUT_KEY = xonly(secret(0x55))
const DESTINATIONS = [{ outputKey: PAYOUT_KEY, amountSats: 2_499_000n }]

const spendFor = (tree: EscrowTree, name: 'A' | 'B' | 'C' | 'D'): { tx: Tx; leaf: NonNullable<EscrowTree['leaves']['A']> } => {
  const leaf = tree.leafList.find((l) => l.name === name)
  if (!leaf) throw new Error(`no leaf ${name}`)
  return { tx: buildSpend({ tree, leaf, outpoint: OUTPOINT, destinations: DESTINATIONS }), leaf }
}

describe('differential against @scure/btc-signer', () => {
  /** The same spend, built with scure. */
  function scureTx(tree: EscrowTree, leafScript: Uint8Array, sequence: number) {
    const payment = btc.p2tr(
      undefined,
      tree.leafList.map((l) => ({ script: l.script, leafVersion: l.leafVersion })).length === 4
        ? btc.taprootListToTree(tree.leafList.map((l) => ({ script: l.script, leafVersion: l.leafVersion })))
        : btc.taprootListToTree(tree.leafList.map((l) => ({ script: l.script, leafVersion: l.leafVersion }))),
      btc.NETWORK,
      true,
    )
    const tx = new btc.Transaction({ allowUnknownOutputs: true, version: tree.txVersion })
    tx.addInput({
      // scure wants wire order. buildSpend takes explorer display order and reverses it.
      txid: hexToBytes(OUTPOINT.txid).reverse(),
      index: OUTPOINT.vout,
      sequence,
      witnessUtxo: { script: payment.script, amount: OUTPOINT.amountSats },
      tapLeafScript: payment.tapLeafScript,
    })
    tx.addOutput({ script: p2trScript(PAYOUT_KEY), amount: DESTINATIONS[0].amountSats })
    void leafScript
    return { tx, payment }
  }

  test('the derived scriptPubKey is the one scure derives', () => {
    const { payment } = scureTx(TREE, TREE.leaves.A.script, TREE.leaves.A.sequence)
    expect(bytesToHex(payment.script)).toBe(bytesToHex(TREE.scriptPubKey))
  })

  for (const name of ['A', 'B', 'C', 'D'] as const) {
    test(`leaf ${name}: sighashFor equals scure's preimageWitnessV1`, () => {
      const { tx, leaf } = spendFor(TREE, name)
      const { tx: reference } = scureTx(TREE, leaf.script, leaf.sequence)

      const ours = sighashFor(tx, leaf)
      // Parameter 6 is the leaf script, not its hash, so scure derives the TapLeaf hash itself.
      const theirs = reference.preimageWitnessV1(
        0,
        [TREE.scriptPubKey],
        btc.SigHash.DEFAULT,
        [OUTPOINT.amountSats],
        undefined,
        leaf.script,
        leaf.leafVersion,
      )
      expect(bytesToHex(ours)).toBe(bytesToHex(theirs))
    })
  }

  test('the unsigned serialisation matches scure', () => {
    const { tx, leaf } = spendFor(TREE, 'A')
    const { tx: reference } = scureTx(TREE, leaf.script, leaf.sequence)
    expect(bytesToHex(serializeUnsigned(tx))).toBe(bytesToHex(reference.unsignedTx))
  })

  test('the txid matches scure', () => {
    const { tx, leaf } = spendFor(TREE, 'A')
    const { tx: reference } = scureTx(TREE, leaf.script, leaf.sequence)
    expect(txid(tx)).toBe(reference.id)
  })

  test('the no-arbiter tree agrees too', () => {
    const { tx, leaf } = spendFor(NO_ARBITER, 'A')
    const payment = btc.p2tr(
      undefined,
      btc.taprootListToTree(NO_ARBITER.leafList.map((l) => ({ script: l.script, leafVersion: l.leafVersion }))),
      btc.NETWORK,
      true,
    )
    expect(bytesToHex(payment.script)).toBe(bytesToHex(NO_ARBITER.scriptPubKey))

    const reference = new btc.Transaction({ allowUnknownOutputs: true, version: NO_ARBITER.txVersion })
    reference.addInput({
      txid: hexToBytes(OUTPOINT.txid).reverse(),
      index: OUTPOINT.vout,
      sequence: leaf.sequence,
      witnessUtxo: { script: payment.script, amount: OUTPOINT.amountSats },
      tapLeafScript: payment.tapLeafScript,
    })
    reference.addOutput({ script: p2trScript(PAYOUT_KEY), amount: DESTINATIONS[0].amountSats })

    expect(bytesToHex(sighashFor(tx, leaf))).toBe(
      bytesToHex(
        reference.preimageWitnessV1(
          0,
          [NO_ARBITER.scriptPubKey],
          btc.SigHash.DEFAULT,
          [OUTPOINT.amountSats],
          undefined,
          leaf.script,
          leaf.leafVersion,
        ),
      ),
    )
  })
})

// These fail quietly when wrong.
describe('serialisation', () => {
  test('amounts are eight bytes little-endian', () => {
    expect(bytesToHex(u64(1000n))).toBe('e803000000000000')
    expect(bytesToHex(u64(0n))).toBe('0000000000000000')
    expect(bytesToHex(u64(2_100_000_000_000_000n))).toBe('0040075af0750700')
  })

  test('the txid in a serialised input is the reverse of the one a person reads', () => {
    const tx = buildSpend({
      tree: TREE,
      leaf: TREE.leaves.A,
      outpoint: { ...OUTPOINT, txid: '00'.repeat(31) + 'ff' },
      destinations: DESTINATIONS,
    })
    const serialised = bytesToHex(serializeUnsigned(tx))
    // Version (4 bytes) and input count (1 byte) put the outpoint at hex offset 10.
    expect(serialised.slice(10, 12)).toBe('ff')
    expect(serialised.slice(12, 14)).toBe('00')
  })

  test('the witness is not in the txid, so a taproot spend is not malleable', () => {
    const { tx, leaf } = spendFor(TREE, 'D')
    const before = txid(tx)
    const signed = finaliseSpend({
      tree: TREE,
      leaf,
      tx,
      signatures: { buyer: signSpend({ tx, leaf, secretKey: BUYER_SK, auxRand: AUX }) },
    })
    expect(signed.txid).toBe(before)
    expect(serializeSigned(signed.tx).length).toBeGreaterThan(serializeUnsigned(signed.tx).length)
  })

  test('vsize is computed from the real bytes, not a table of guesses', () => {
    const { tx, leaf } = spendFor(TREE, 'A')
    const signed = spendWith({
      tree: TREE,
      leaf,
      outpoint: OUTPOINT,
      destinations: DESTINATIONS,
      secretKeys: KEYS,
      auxRand: AUX,
    })
    expect(signed.vbytes).toBe(vsize(signed.tx))
    // Leaf D needs one signature fewer.
    const sweep = spendWith({
      tree: TREE,
      leaf: TREE.leaves.D,
      outpoint: OUTPOINT,
      destinations: DESTINATIONS,
      secretKeys: KEYS,
      auxRand: AUX,
    })
    expect(sweep.vbytes).toBeLessThan(signed.vbytes)
    void tx
  })

  test('the fee is estimable before anything is signed, and exactly right after', () => {
    const { tx } = spendFor(TREE, 'A')
    const estimate = feeOf(tx, false, TREE.leaves.A)
    expect(estimate.sats).toBe(1000n)
    expect(estimate.vbytes).toBeGreaterThan(0)
  })

  /* No key path here. Sizing for a 64-byte key-path witness under-counts every spend (about a
     third for the cooperative leaf), so the fee would pay less than the rate shown. */
  test('the unsigned estimate equals the signed size exactly, for every leaf', () => {
    for (const name of ['A', 'B', 'C', 'D'] as const) {
      const leaf = TREE.leaves[name]
      const tx = buildSpend({ tree: TREE, leaf, outpoint: OUTPOINT, destinations: DESTINATIONS })
      const signed = spendWith({ tree: TREE, leaf, outpoint: OUTPOINT, destinations: DESTINATIONS, secretKeys: KEYS, auxRand: AUX })
      expect(feeOf(tx, false, leaf).vbytes).toBe(signed.vbytes)
      expect(feeOf(signed.tx, true).vbytes).toBe(signed.vbytes)
    }
  })

  test('an unsigned spend cannot be sized without its leaf', () => {
    const { tx } = spendFor(TREE, 'A')
    expect(() => feeOf(tx, false)).toThrow(/sized by its leaf/)
  })
})

describe('witness assembly', () => {
  test('the stack is [ ...signatures, script, controlBlock ]', () => {
    const signed = spendWith({
      tree: TREE,
      leaf: TREE.leaves.A,
      outpoint: OUTPOINT,
      destinations: DESTINATIONS,
      secretKeys: KEYS,
      auxRand: AUX,
    })
    const witness = signed.tx.inputs[0].witness as Uint8Array[]
    expect(witness).toHaveLength(TREE.leaves.A.signatureOrder.length + 2)
    expect(bytesToHex(witness[witness.length - 2])).toBe(bytesToHex(TREE.leaves.A.script))
    expect(bytesToHex(witness[witness.length - 1])).toBe(bytesToHex(TREE.leaves.A.controlBlock))
    for (let i = 0; i < TREE.leaves.A.signatureOrder.length; i++) expect(witness[i]).toHaveLength(64)
  })

  test('signatures go in the order the script consumes them', () => {
    // finaliseSpend reads buildTree's order and never re-derives it, so they can't disagree.
    const leaf = TREE.leaves.A
    const tx = buildSpend({ tree: TREE, leaf, outpoint: OUTPOINT, destinations: DESTINATIONS })
    const sigs = {
      buyer: signSpend({ tx, leaf, secretKey: BUYER_SK, auxRand: AUX }),
      seller: signSpend({ tx, leaf, secretKey: SELLER_SK, auxRand: AUX }),
    }
    const signed = finaliseSpend({ tree: TREE, leaf, tx, signatures: sigs })
    const witness = signed.tx.inputs[0].witness as Uint8Array[]
    leaf.signatureOrder.forEach((role, i) => {
      expect(bytesToHex(witness[i])).toBe(bytesToHex(sigs[role as 'buyer' | 'seller']))
    })
  })

  test('each leaf carries its own sequence: D has the timelock, A signals RBF', () => {
    const cooperative = buildSpend({ tree: TREE, leaf: TREE.leaves.A, outpoint: OUTPOINT, destinations: DESTINATIONS })
    const sweep = buildSpend({ tree: TREE, leaf: TREE.leaves.D, outpoint: OUTPOINT, destinations: DESTINATIONS })
    expect(cooperative.inputs[0].sequence).toBe(TREE.leaves.A.sequence)
    expect(sweep.inputs[0].sequence).toBe(TREE.leaves.D.sequence)
    expect(sweep.inputs[0].sequence).not.toBe(cooperative.inputs[0].sequence)
  })
})

describe('what must not work', () => {
  test('the arbiter cannot spend alone through any leaf', () => {
    for (const leaf of TREE.leafList) {
      // Every leaf that names the arbiter also names a party.
      if (leaf.signatureOrder.includes('arbiter')) {
        expect(leaf.signatureOrder.length).toBeGreaterThan(1)
      }
      const tx = buildSpend({ tree: TREE, leaf, outpoint: OUTPOINT, destinations: DESTINATIONS })
      expect(() =>
        finaliseSpend({
          tree: TREE,
          leaf,
          tx,
          signatures: { arbiter: signSpend({ tx, leaf, secretKey: ARBITER_SK, auxRand: AUX }) },
        }),
      ).toThrow()
    }
  })

  test('a signature for one leaf does not work on another', () => {
    // A and B both hold the seller's key. Without the leaf hash in the sighash a signature
    // would replay between them.
    const leafA = TREE.leaves.A
    const leafB = TREE.leaves.B as NonNullable<typeof TREE.leaves.B>
    const tx = buildSpend({ tree: TREE, leaf: leafA, outpoint: OUTPOINT, destinations: DESTINATIONS })
    const forA = signSpend({ tx, leaf: leafA, secretKey: SELLER_SK, auxRand: AUX })
    expect(verifySpendSignature({ tx, leaf: leafA, signature: forA, pubkey: xonly(SELLER_SK) })).toBe(true)
    expect(verifySpendSignature({ tx, leaf: leafB, signature: forA, pubkey: xonly(SELLER_SK) })).toBe(false)
  })

  test('a signature for one transaction does not work on another', () => {
    const leaf = TREE.leaves.A
    const tx = buildSpend({ tree: TREE, leaf, outpoint: OUTPOINT, destinations: DESTINATIONS })
    const other = buildSpend({
      tree: TREE,
      leaf,
      outpoint: OUTPOINT,
      // One more sat to the payee, so a different fee.
      destinations: [{ outputKey: PAYOUT_KEY, amountSats: 2_499_001n }],
    })
    const sig = signSpend({ tx, leaf, secretKey: BUYER_SK, auxRand: AUX })
    expect(verifySpendSignature({ tx: other, leaf, signature: sig, pubkey: xonly(BUYER_SK) })).toBe(false)
  })

  test('a signature from a stranger is refused at assembly', () => {
    const leaf = TREE.leaves.A
    const tx = buildSpend({ tree: TREE, leaf, outpoint: OUTPOINT, destinations: DESTINATIONS })
    expect(() =>
      finaliseSpend({
        tree: TREE,
        leaf,
        tx,
        signatures: {
          buyer: signSpend({ tx, leaf, secretKey: STRANGER_SK, auxRand: AUX }),
          seller: signSpend({ tx, leaf, secretKey: SELLER_SK, auxRand: AUX }),
        },
      }),
    ).toThrow(/does not verify/)
  })

  test('spending more than the input holds is refused', () => {
    expect(() =>
      buildSpend({
        tree: TREE,
        leaf: TREE.leaves.A,
        outpoint: OUTPOINT,
        destinations: [{ outputKey: PAYOUT_KEY, amountSats: OUTPOINT.amountSats + 1n }],
      }),
    ).toThrow(/outputs total/)
  })

  test('a dust output is refused rather than made unspendable', () => {
    expect(() =>
      buildSpend({
        tree: TREE,
        leaf: TREE.leaves.A,
        outpoint: OUTPOINT,
        destinations: [{ outputKey: PAYOUT_KEY, amountSats: 300n }],
      }),
    ).toThrow(/dust/)
  })

  test('a missing signature names the party that owes one', () => {
    const leaf = TREE.leaves.A
    const tx = buildSpend({ tree: TREE, leaf, outpoint: OUTPOINT, destinations: DESTINATIONS })
    expect(() =>
      finaliseSpend({ tree: TREE, leaf, tx, signatures: { buyer: signSpend({ tx, leaf, secretKey: BUYER_SK, auxRand: AUX }) } }),
    ).toThrow(/needs a signature from the seller/)
  })
})

describe('every leaf produces a finalised transaction', () => {
  for (const name of ['A', 'B', 'C', 'D'] as const) {
    test(`leaf ${name} (four-leaf tree)`, () => {
      const leaf = TREE.leafList.find((l) => l.name === name)!
      const signed = spendWith({
        tree: TREE,
        leaf,
        outpoint: OUTPOINT,
        destinations: DESTINATIONS,
        secretKeys: KEYS,
        auxRand: AUX,
      })
      expect(signed.hex).toMatch(/^[0-9a-f]+$/)
      expect(signed.txid).toMatch(/^[0-9a-f]{64}$/)
      expect(signed.tx.inputs[0].witness).toBeTruthy()
    })
  }

  for (const name of ['A', 'D'] as const) {
    test(`leaf ${name} (two-leaf tree)`, () => {
      const leaf = NO_ARBITER.leafList.find((l) => l.name === name)!
      const signed = spendWith({
        tree: NO_ARBITER,
        leaf,
        outpoint: OUTPOINT,
        destinations: DESTINATIONS,
        secretKeys: KEYS,
        auxRand: AUX,
      })
      expect(signed.hex).toMatch(/^[0-9a-f]+$/)
    })
  }
})
