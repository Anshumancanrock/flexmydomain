// Every escrow leaf, spent on regtest so Bitcoin Core's consensus rules judge the witness.
// Parity with @scure/btc-signer lives in test/vectors/spend.test.ts. Slow: `bun run test:regtest`.

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils.js'

import {
  buildSpend,
  buildTree,
  finaliseSpend,
  signSpend,
  spendWith,
  type EscrowLeaf,
  type EscrowTree,
} from '../../core/escrow/index.ts'
import { haveBitcoind, startRegtest, fundedWallet, type RegtestNode } from './node.ts'

const AUX = new Uint8Array(32)
const secret = (fill: number) => new Uint8Array(32).fill(fill)
const xonly = (sk: Uint8Array) => schnorr.getPublicKey(sk)

const BUYER = secret(0x11)
const SELLER = secret(0x22)
const ARBITER = secret(0x33)
const KEYS = { buyer: BUYER, seller: SELLER, arbiter: ARBITER }

/** Quick to mine through, still a real timelock. */
const TIMEOUT_BLOCKS = 20
const FUND_BTC = 0.01
const FUND_SATS = 1_000_000n
const FEE_SATS = 2_000n

let node: RegtestNode
let wallet: Awaited<ReturnType<typeof fundedWallet>>
let payoutAddress: string
let payoutScript: Uint8Array

beforeAll(async () => {
  if (!haveBitcoind) return
  node = await startRegtest()
  wallet = await fundedWallet(node)
  payoutAddress = wallet.address
  const info = await node.rpc<{ scriptPubKey: string }>('getaddressinfo', [payoutAddress])
  payoutScript = Uint8Array.from(Buffer.from(info.scriptPubKey, 'hex'))
}, 60_000)

afterAll(async () => {
  await node?.stop()
})

/** Fund the escrow address and return the outpoint. */
async function fund(tree: EscrowTree): Promise<{ txid: string; vout: number; amountSats: bigint }> {
  const address = tree.addresses.regtest

  // If Core decodes the address to another scriptPubKey, every test here checks the wrong output.
  const info = await node.rpc<{ scriptPubKey: string; isvalid: boolean }>('validateaddress', [address])
  expect(info.isvalid).toBe(true)
  expect(info.scriptPubKey).toBe(bytesToHex(tree.scriptPubKey))

  const txid = await wallet.send(address, FUND_BTC)
  await wallet.mine(1)

  const tx = await node.rpc<{ vout: { value: number; n: number; scriptPubKey: { hex: string } }[] }>(
    'getrawtransaction',
    [txid, true],
  )
  const vout = tx.vout.find((o) => o.scriptPubKey.hex === bytesToHex(tree.scriptPubKey))
  expect(vout).toBeTruthy()
  return { txid, vout: (vout as { n: number }).n, amountSats: FUND_SATS }
}

async function broadcast(hex: string): Promise<{ accepted: boolean; reason?: string; txid?: string }> {
  try {
    const txid = await node.rpc<string>('sendrawtransaction', [hex])
    return { accepted: true, txid }
  } catch (err) {
    return { accepted: false, reason: (err as Error).message }
  }
}

function spend(tree: EscrowTree, leaf: EscrowLeaf, outpoint: Awaited<ReturnType<typeof fund>>) {
  return spendWith({
    tree,
    leaf,
    outpoint,
    destinations: [{ scriptPubKey: payoutScript, amountSats: outpoint.amountSats - FEE_SATS }],
    secretKeys: KEYS,
    auxRand: AUX,
  })
}

describe.skipIf(!haveBitcoind)('the four-leaf tree, against consensus', () => {
  const tree = buildTree({
    buyer: xonly(BUYER),
    seller: xonly(SELLER),
    arbiter: xonly(ARBITER),
    timeoutTo: 'buyer',
    timeoutBlocks: TIMEOUT_BLOCKS,
  })

  test('leaf A (cooperative): buyer and seller, with no third party', async () => {
    const outpoint = await fund(tree)
    const result = await broadcast(spend(tree, tree.leaves.A, outpoint).hex)
    expect(result.reason ?? 'accepted').toBe('accepted')
    expect(result.accepted).toBe(true)
  }, 60_000)

  test('leaf B (dispute resolved for the seller): arbiter and seller', async () => {
    const outpoint = await fund(tree)
    const result = await broadcast(spend(tree, tree.leaves.B as EscrowLeaf, outpoint).hex)
    expect(result.reason ?? 'accepted').toBe('accepted')
  }, 60_000)

  test('leaf C (dispute resolved for the buyer): arbiter and buyer', async () => {
    const outpoint = await fund(tree)
    const result = await broadcast(spend(tree, tree.leaves.C as EscrowLeaf, outpoint).hex)
    expect(result.reason ?? 'accepted').toBe('accepted')
  }, 60_000)

  test('leaf D (timeout): rejected before the timelock, accepted after', async () => {
    const outpoint = await fund(tree)
    const sweep = spend(tree, tree.leaves.D, outpoint)

    // The same tx Core refuses now must pass unchanged after the timelock.
    const early = await broadcast(sweep.hex)
    expect(early.accepted).toBe(false)
    expect(early.reason).toMatch(/non-BIP68|Locktime|final/i)

    await wallet.mine(TIMEOUT_BLOCKS)

    const late = await broadcast(sweep.hex)
    expect(late.reason ?? 'accepted').toBe('accepted')
    expect(late.accepted).toBe(true)
  }, 90_000)

  test('the arbiter alone cannot spend', async () => {
    const outpoint = await fund(tree)

    for (const leaf of tree.leafList) {
      const tx = buildSpend({
        tree,
        leaf,
        outpoint,
        destinations: [{ scriptPubKey: payoutScript, amountSats: outpoint.amountSats - FEE_SATS }],
      })

      // finaliseSpend knows which signatures the leaf needs.
      expect(() =>
        finaliseSpend({
          tree,
          leaf,
          tx,
          signatures: { arbiter: signSpend({ tx, leaf, secretKey: ARBITER, auxRand: AUX }) },
        }),
      ).toThrow()

      // Core must reject a hand-built witness with only the arbiter's signature too.
      const forced = {
        ...tx,
        inputs: tx.inputs.map((input, i) =>
          i === 0
            ? {
                ...input,
                witness: [signSpend({ tx, leaf, secretKey: ARBITER, auxRand: AUX }), leaf.script, leaf.controlBlock],
              }
            : input,
        ),
      }
      const { serializeSigned } = await import('../../core/escrow/tx.ts')
      const result = await broadcast(bytesToHex(serializeSigned(forced)))
      expect(result.accepted).toBe(false)
    }
  }, 120_000)
})

describe.skipIf(!haveBitcoind)('the two-leaf tree, against consensus', () => {
  // With no arbiter the timeout pays the seller. Otherwise a buyer who already
  // has the domain could just wait out the timeout.
  const tree = buildTree({
    buyer: xonly(BUYER),
    seller: xonly(SELLER),
    timeoutTo: 'seller',
    timeoutBlocks: TIMEOUT_BLOCKS,
  })

  test('the tree has two leaves and no arbiter', () => {
    expect(tree.shape).toBe('no-arbiter-2leaf')
    expect(tree.leafList).toHaveLength(2)
    expect(tree.params.arbiter).toBeUndefined()
  })

  test('leaf A (cooperative)', async () => {
    const outpoint = await fund(tree)
    const result = await broadcast(spend(tree, tree.leaves.A, outpoint).hex)
    expect(result.reason ?? 'accepted').toBe('accepted')
  }, 60_000)

  test('leaf D (timeout) pays the seller after the timelock', async () => {
    const outpoint = await fund(tree)
    const sweep = spend(tree, tree.leaves.D, outpoint)

    expect((await broadcast(sweep.hex)).accepted).toBe(false)
    await wallet.mine(TIMEOUT_BLOCKS)
    const late = await broadcast(sweep.hex)
    expect(late.reason ?? 'accepted').toBe('accepted')
  }, 90_000)
})
