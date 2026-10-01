// Every settlement path the escrow page uses, signed in two steps and judged by Bitcoin Core.

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

import {
  BINDING_TAG,
  NUMS_INTERNAL_KEY_HEX,
  completeSettlement,
  leafOfWitness,
  signSettlement,
  taggedHash,
  verifySettlement,
  type Settlement,
} from '../../core/escrow/index.ts'
import { deriveEscrowId, escrowTree, type EscrowParams } from '../../core/nostr/index.ts'
import { haveBitcoind, startRegtest, fundedWallet, type RegtestNode } from './node.ts'

const PORT = 18998
const BUYER = new Uint8Array(32).fill(0x11)
const SELLER = new Uint8Array(32).fill(0x22)
const ARBITER = new Uint8Array(32).fill(0x33)
const KEYS = { buyer: BUYER, seller: SELLER, arbiter: ARBITER }
const PARAMS: EscrowParams = {
  salt: '5a'.repeat(32),
  buyer: schnorr.getPublicKey(BUYER),
  seller: schnorr.getPublicKey(SELLER),
  arbiter: schnorr.getPublicKey(ARBITER),
  timeoutBlocks: 144,
  deliverBlocks: 12,
  network: 'regtest',
  amountSats: 1_000_000,
  domain: 'lumenary.com',
}
// Bound to the escrow id, as the pages build it.
const tree = escrowTree(PARAMS)
const FUND_SATS = 1_000_000n

let node: RegtestNode
let wallet: Awaited<ReturnType<typeof fundedWallet>>

beforeAll(async () => {
  if (!haveBitcoind) return
  node = await startRegtest(PORT)
  wallet = await fundedWallet(node, 'settle', PORT)
}, 60_000)

afterAll(async () => {
  await node?.stop()
})

async function fund(t = tree): Promise<string> {
  const txid = await wallet.send(t.addresses.regtest, 0.01)
  await wallet.mine(1)
  const tx = await node.rpc<{ vout: { n: number; scriptPubKey: { hex: string } }[] }>('getrawtransaction', [txid, true])
  const vout = tx.vout.find((o) => o.scriptPubKey.hex === bytesToHex(t.scriptPubKey))!
  return `${txid}:${vout.n}`
}

describe.skipIf(!haveBitcoind)('pre-signed payouts on a real node', () => {
  const paths: [Settlement['kind'], Settlement['leaf'], 'buyer' | 'seller', 'buyer' | 'seller' | 'arbiter'][] = [
    ['release', 'A', 'seller', 'buyer'],
    ['release', 'B', 'seller', 'arbiter'],
    ['refund', 'A', 'buyer', 'seller'],
    ['refund', 'C', 'buyer', 'arbiter'],
  ]

  for (const [kind, leaf, proposer, completer] of paths) {
    test(`${kind} on leaf ${leaf}: the ${proposer} signs, the ${completer} completes, the node accepts`, async () => {
      const outpoint = await fund()
      const dest = await node.rpc<string>('getnewaddress', [], 'settle' as never).catch(() => wallet.address)
      const settlement: Settlement = { kind, leaf, outpoint, dest, fee: 300 }
      const first = signSettlement({ tree, settlement, value: FUND_SATS, network: 'regtest', secretKey: KEYS[proposer] })
      expect(verifySettlement({ tree, signed: first, value: FUND_SATS, network: 'regtest', role: proposer })).toBe(true)
      const second = signSettlement({ tree, settlement, value: FUND_SATS, network: 'regtest', secretKey: KEYS[completer] })
      const done = completeSettlement({
        tree, settlement, value: FUND_SATS, network: 'regtest',
        signatures: { [proposer]: first.sig, [completer]: second.sig },
      })
      const txid = await node.rpc<string>('sendrawtransaction', [done.hex])
      expect(txid).toBe(done.txid)
      await wallet.mine(1)

      // The page reads the path from the spending witness.
      const spent = await node.rpc<{ vin: { txinwitness: string[] }[] }>('getrawtransaction', [txid, true])
      expect(leafOfWitness(tree, spent.vin[0].txinwitness)).toBe(leaf)
    }, 30_000)
  }

  test('a signature for one payout does not complete another', async () => {
    const outpoint = await fund()
    const settlement: Settlement = { kind: 'release', leaf: 'B', outpoint, dest: wallet.address, fee: 300 }
    const seller = signSettlement({ tree, settlement, value: FUND_SATS, network: 'regtest', secretKey: SELLER })
    // The arbiter signs a different fee, so the pair is not a valid spend.
    const arbiter = signSettlement({ tree, settlement: { ...settlement, fee: 400 }, value: FUND_SATS, network: 'regtest', secretKey: ARBITER })
    expect(() => completeSettlement({ tree, settlement, value: FUND_SATS, network: 'regtest', signatures: { seller: seller.sig, arbiter: arbiter.sig } }))
      .toThrow(/does not verify/)
  }, 30_000)

  test('every parity of the bound internal key and of the output key spends', async () => {
    // BIP-341 lifts the internal key to an even y and carries the output key's parity in
    // the control block, so H + r·G with either y, under an output key with either y, must spend.
    const H = secp256k1.Point.fromHex('02' + NUMS_INTERNAL_KEY_HEX)
    const found = new Map<string, ReturnType<typeof escrowTree>>()
    for (let i = 0; found.size < 4 && i < 256; i++) {
      const params = { ...PARAMS, salt: i.toString(16).padStart(2, '0').repeat(32) }
      const r = BigInt('0x' + bytesToHex(taggedHash(BINDING_TAG, hexToBytes(deriveEscrowId(params)))))
      const internalOdd = (H.add(secp256k1.Point.BASE.multiply(r)).toAffine().y & 1n) === 1n
      const t = escrowTree(params)
      const label = `internal y ${internalOdd ? 'odd' : 'even'}, output y ${t.parity ? 'odd' : 'even'}`
      if (!found.has(label)) found.set(label, t)
    }
    expect(found.size).toBe(4)
    for (const [label, t] of found) {
      const outpoint = await fund(t)
      const settlement: Settlement = { kind: 'release', leaf: 'A', outpoint, dest: wallet.address, fee: 300 }
      const sig = (secretKey: Uint8Array) => signSettlement({ tree: t, settlement, value: FUND_SATS, network: 'regtest', secretKey }).sig
      const done = completeSettlement({ tree: t, settlement, value: FUND_SATS, network: 'regtest', signatures: { seller: sig(SELLER), buyer: sig(BUYER) } })
      expect(`${label}: ${await node.rpc<string>('sendrawtransaction', [done.hex])}`).toBe(`${label}: ${done.txid}`)
    }
    await wallet.mine(1)
  }, 90_000)

  test('a payout signed for another escrow between the same keys does not spend this one', async () => {
    const outpoint = await fund()
    // Same keys, another salt: the escrow a party could open to get a one-sided ruling.
    const sibling = escrowTree({ ...PARAMS, salt: 'a5'.repeat(32) })
    expect(sibling.addresses.regtest).not.toBe(tree.addresses.regtest)
    const settlement: Settlement = { kind: 'refund', leaf: 'C', outpoint, dest: wallet.address, fee: 300 }
    const sign = (t: typeof tree, secretKey: Uint8Array) => signSettlement({ tree: t, settlement, value: FUND_SATS, network: 'regtest', secretKey }).sig
    const accepts = async (hex: string) =>
      (await node.rpc<{ allowed: boolean; 'reject-reason'?: string }[]>('testmempoolaccept', [[hex]]))[0]

    const signatures = { buyer: sign(sibling, BUYER), arbiter: sign(sibling, ARBITER) }
    expect(verifySettlement({ tree, signed: { ...settlement, sig: signatures.arbiter }, value: FUND_SATS, network: 'regtest', role: 'arbiter' })).toBe(false)

    // As signed, the sibling's control block doesn't open to this output.
    const asSigned = completeSettlement({ tree: sibling, settlement, value: FUND_SATS, network: 'regtest', signatures })
    expect((await accepts(asSigned.hex)).allowed).toBe(false)

    // With this escrow's control block swapped in, the signatures fail instead.
    const controlBlock = (t: typeof tree) => bytesToHex(t.leaves.C!.controlBlock)
    expect(asSigned.hex).toContain(controlBlock(sibling))
    const swapped = await accepts(asSigned.hex.replace(controlBlock(sibling), controlBlock(tree)))
    expect(swapped.allowed).toBe(false)
    expect(swapped['reject-reason']).toMatch(/schnorr|signature/i)

    const honest = completeSettlement({ tree, settlement, value: FUND_SATS, network: 'regtest', signatures: { buyer: sign(tree, BUYER), arbiter: sign(tree, ARBITER) } })
    expect((await accepts(honest.hex)).allowed).toBe(true)
  }, 30_000)
})
