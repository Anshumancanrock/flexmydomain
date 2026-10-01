// Settlement (core/escrow/settle.ts). A signature is published before its counterpart, so it must fit exactly one transaction.

import { test, expect, describe } from 'bun:test'
import { bytesToHex } from '@noble/hashes/utils.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import {
  MAX_FEE_RATE,
  buildTree,
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
  type Settlement,
} from '../../core/escrow/index.ts'

const AUX = new Uint8Array(32).fill(9)
const BUYER = new Uint8Array(32).fill(0x11)
const SELLER = new Uint8Array(32).fill(0x22)
const ARBITER = new Uint8Array(32).fill(0x33)
const MALLORY = new Uint8Array(32).fill(0x44)
const x = (sk: Uint8Array) => schnorr.getPublicKey(sk)

const tree = buildTree({ buyer: x(BUYER), seller: x(SELLER), arbiter: x(ARBITER), timeoutTo: 'buyer', timeoutBlocks: 144 })
const network = 'signet' as const
const VALUE = 100_000n
const OUTPOINT = `${'ab'.repeat(32)}:1`
const SELLER_ADDR = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'
const BUYER_ADDR = 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7'

const release = (leaf: 'A' | 'B'): Settlement => ({ kind: 'release', leaf, outpoint: OUTPOINT, dest: SELLER_ADDR, fee: 300 })
const refund = (leaf: 'A' | 'C'): Settlement => ({ kind: 'refund', leaf, outpoint: OUTPOINT, dest: BUYER_ADDR, fee: 300 })
const sign = (settlement: Settlement, secretKey: Uint8Array) =>
  signSettlement({ tree, settlement, value: VALUE, network, secretKey, auxRand: AUX })

describe('every path completes with its own two keys', () => {
  const paths: [Settlement, Uint8Array, 'buyer' | 'seller' | 'arbiter', Uint8Array, 'buyer' | 'seller' | 'arbiter'][] = [
    [release('A'), SELLER, 'seller', BUYER, 'buyer'],
    [release('B'), SELLER, 'seller', ARBITER, 'arbiter'],
    [refund('A'), BUYER, 'buyer', SELLER, 'seller'],
    [refund('C'), BUYER, 'buyer', ARBITER, 'arbiter'],
  ]
  for (const [settlement, proposerKey, proposer, completerKey, completer] of paths) {
    test(`${settlement.kind} on leaf ${settlement.leaf}: ${proposer} then ${completer}`, () => {
      const first = sign(settlement, proposerKey)
      expect(verifySettlement({ tree, signed: first, value: VALUE, network, role: proposer })).toBe(true)
      const second = sign(settlement, completerKey)
      expect(verifySettlement({ tree, signed: second, value: VALUE, network, role: completer })).toBe(true)
      const done = completeSettlement({ tree, settlement, value: VALUE, network, signatures: { [proposer]: first.sig, [completer]: second.sig } })
      expect(done.txid).toMatch(/^[0-9a-f]{64}$/)
      expect(done.hex.length).toBeGreaterThan(200)
    })
  }
})

describe('a signature completes nothing else', () => {
  const signed = sign(release('A'), SELLER)

  test('not another leaf, even with the same destination and fee', () => {
    expect(verifySettlement({ tree, signed: { ...signed, leaf: 'B' }, value: VALUE, network, role: 'seller' })).toBe(false)
  })

  test('not another destination, fee, output or amount', () => {
    expect(verifySettlement({ tree, signed: { ...signed, dest: BUYER_ADDR }, value: VALUE, network, role: 'seller' })).toBe(false)
    expect(verifySettlement({ tree, signed: { ...signed, fee: 301 }, value: VALUE, network, role: 'seller' })).toBe(false)
    expect(verifySettlement({ tree, signed: { ...signed, outpoint: `${'ab'.repeat(32)}:0` }, value: VALUE, network, role: 'seller' })).toBe(false)
    // The chain's amount, not the party's: a signature over another amount fails.
    expect(verifySettlement({ tree, signed, value: VALUE + 1n, network, role: 'seller' })).toBe(false)
  })

  test('not as somebody else, and not from another escrow', () => {
    expect(verifySettlement({ tree, signed, value: VALUE, network, role: 'buyer' })).toBe(false)
    const other = buildTree({ buyer: x(BUYER), seller: x(MALLORY), arbiter: x(ARBITER), timeoutTo: 'buyer', timeoutBlocks: 144 })
    expect(verifySettlement({ tree: other, signed, value: VALUE, network, role: 'seller' })).toBe(false)
  })

  test('completing with a bad or missing signature throws before anything is broadcast', () => {
    const buyer = sign(release('A'), BUYER)
    expect(() => completeSettlement({ tree, settlement: release('A'), value: VALUE, network, signatures: { seller: signed.sig } }))
      .toThrow(/buyer's signature/)
    expect(() => completeSettlement({ tree, settlement: release('A'), value: VALUE, network, signatures: { seller: signed.sig, buyer: signed.sig } }))
      .toThrow(/does not verify/)
    expect(() => completeSettlement({ tree, settlement: { ...release('A'), fee: 301 }, value: VALUE, network, signatures: { seller: signed.sig, buyer: buyer.sig } }))
      .toThrow(/does not verify/)
  })
})

describe('who can sign what', () => {
  test('a key outside the leaf cannot sign it', () => {
    expect(() => sign(release('B'), BUYER)).toThrow(/two signers/)
    expect(() => sign(refund('C'), SELLER)).toThrow(/two signers/)
    expect(() => sign(release('A'), ARBITER)).toThrow(/two signers/)
    expect(() => sign(release('A'), MALLORY)).toThrow(/two signers/)
  })

  test('each leaf names its two signers, and the arbiter is never alone', () => {
    expect(signersOf('A')).toEqual(['buyer', 'seller'])
    expect(signersOf('B')).toEqual(['seller', 'arbiter'])
    expect(signersOf('C')).toEqual(['buyer', 'arbiter'])
    for (const leaf of ['A', 'B', 'C'] as const) expect(signersOf(leaf).filter((r) => r !== 'arbiter').length).toBeGreaterThan(0)
    expect(roleOf(tree, x(ARBITER))).toBe('arbiter')
    expect(roleOf(tree, x(MALLORY))).toBeUndefined()
  })
})

describe('the transaction', () => {
  test('one input, one output: everything less the fee, to the destination', () => {
    const tx = settlementTx({ tree, settlement: release('A'), value: VALUE, network })
    expect(tx.inputs).toHaveLength(1)
    expect(tx.inputs[0]).toMatchObject({ txid: 'ab'.repeat(32), vout: 1, amountSats: VALUE, sequence: tree.leaves.A.sequence })
    expect(tx.outputs).toEqual([{ amountSats: VALUE - 300n, scriptPubKey: expect.any(Uint8Array) }])
  })

  test('a fee that eats the escrow, dust, another network or the escrow itself is refused', () => {
    expect(() => settlementTx({ tree, settlement: { ...release('A'), fee: 100_000 }, value: VALUE, network })).toThrow(/leaves nothing/)
    expect(() => settlementTx({ tree, settlement: { ...release('A'), fee: 99_900 }, value: VALUE, network })).toThrow(/dust/)
    expect(() => settlementTx({ tree, settlement: { ...release('A'), dest: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' }, value: VALUE, network })).toThrow(/signet/)
    expect(() => settlementTx({ tree, settlement: { ...release('A'), dest: tree.addresses.signet }, value: VALUE, network })).toThrow(/escrow address/)
  })

  test('the fee is the rate times the size, rounded up, and the same on every leaf', () => {
    const { fee: _f, ...draft } = release('A')
    const a = settlementFee({ tree, settlement: draft, value: VALUE, network, rate: 2.5 })
    for (const leaf of ['B', 'C'] as const) {
      expect(settlementFee({ tree, settlement: { ...draft, leaf, kind: leaf === 'B' ? 'release' : 'refund' }, value: VALUE, network, rate: 2.5 })).toBe(a)
    }
    const vbytes = settlementFee({ tree, settlement: draft, value: VALUE, network, rate: 1 })
    expect(vbytes).toBeGreaterThan(100)
    expect(a).toBe(Math.ceil(2.5 * vbytes))
    expect(() => settlementFee({ tree, settlement: draft, value: VALUE, network, rate: MAX_FEE_RATE + 1 })).toThrow()
    expect(() => settlementFee({ tree, settlement: draft, value: VALUE, network, rate: 0 })).toThrow()
  })
})

describe('reading a settlement off a relay', () => {
  const good = { ...release('A'), sig: 'ee'.repeat(64) }

  test('a well-formed one passes, anything else says why', () => {
    expect(settlementProblem(good)).toBeUndefined()
    expect(settlementProblem({ ...good, kind: 'steal' })).toMatch(/kind/)
    expect(settlementProblem({ ...good, leaf: 'C' })).toMatch(/leaf C/)
    expect(settlementProblem({ ...good, kind: 'refund', leaf: 'B' })).toMatch(/leaf B/)
    expect(settlementProblem({ ...good, outpoint: 'nope' })).toMatch(/outpoint/)
    expect(settlementProblem({ ...good, outpoint: `${'ab'.repeat(32)}:4294967296` })).toMatch(/outpoint/)
    expect(settlementProblem({ ...good, dest: '' })).toMatch(/destination/)
    expect(settlementProblem({ ...good, fee: 0 })).toMatch(/fee/)
    expect(settlementProblem({ ...good, fee: 1.5 })).toMatch(/fee/)
    expect(settlementProblem({ ...good, sig: 'ee' })).toMatch(/signature/)
    expect(settlementProblem(null)).toMatch(/object/)
  })

  test('two settlements share a key exactly when one signature fits both', () => {
    expect(settlementKey(release('A'))).toBe(settlementKey({ ...release('A') }))
    expect(settlementKey(release('A'))).not.toBe(settlementKey(release('B')))
    expect(settlementKey(release('A'))).not.toBe(settlementKey({ ...release('A'), fee: 301 }))
  })
})

describe('naming the leaf a spend used', () => {
  const witnessFor = (leaf: 'A' | 'B' | 'C' | 'D') =>
    ['aa'.repeat(64), 'bb'.repeat(64), bytesToHex(tree.leaves[leaf]!.script), bytesToHex(tree.leaves[leaf]!.controlBlock)]

  test('from the script in the witness', () => {
    for (const leaf of ['A', 'B', 'C', 'D'] as const) expect(leafOfWitness(tree, witnessFor(leaf))).toBe(leaf)
  })

  test('with an annex on top too', () => {
    expect(leafOfWitness(tree, [...witnessFor('C'), '50aa'])).toBe('C')
  })

  test('and nothing for a witness that is not this escrow', () => {
    expect(leafOfWitness(tree, ['aa'.repeat(64), '51', 'c0'])).toBeUndefined()
    expect(leafOfWitness(tree, [])).toBeUndefined()
  })
})

describe('the board: which payouts exist and which are complete', () => {
  const sources = (over: Partial<Record<'buyer' | 'seller' | 'arbiter', ReturnType<typeof sign>[]>>) =>
    (['buyer', 'seller', 'arbiter'] as const).map((role) => ({ role, sigs: over[role] ?? [] }))
  const board = (over: Parameters<typeof sources>[0]) =>
    collectSettlements({ tree, network, outpoint: OUTPOINT, value: VALUE, sources: sources(over) })

  test("the seller's release and the buyer's co-signature make one complete payout", () => {
    const b = board({ seller: [sign(release('A'), SELLER), sign(release('B'), SELLER)], buyer: [sign(release('A'), BUYER)] })
    expect(b).toHaveLength(2)
    expect(b.find((e) => e.settlement.leaf === 'A')?.complete).toBe(true)
    expect(b.find((e) => e.settlement.leaf === 'B')?.complete).toBe(false)
    expect(proposalOf(b, 'release', 'B')?.sigs.seller).toBeDefined()
  })

  test("a signature for another output, or that is not its claimed signer's, is dropped", () => {
    const other = signSettlement({ tree, settlement: { ...release('A'), outpoint: `${'cd'.repeat(32)}:0` }, value: VALUE, network, secretKey: SELLER })
    expect(board({ seller: [other] })).toEqual([])
    // The buyer's signature filed under the seller's name.
    expect(board({ seller: [sign(release('A'), BUYER)] })).toEqual([])
    expect(board({ arbiter: [sign(release('A'), SELLER)] })).toEqual([])
    const tampered = { ...sign(release('A'), SELLER), fee: 1000 }
    expect(board({ seller: [tampered] })).toEqual([])
  })

  test("a payout made up for the other side is never a proposal, so nobody co-signs it", () => {
    // The buyer signs a "release" to their own address: not the seller's offer.
    const fake = sign({ ...release('A'), dest: BUYER_ADDR }, BUYER)
    expect(proposalOf(board({ buyer: [fake] }), 'release', 'A')).toBeUndefined()
    // The seller signs a "refund" that pays the seller.
    const fake2 = sign({ ...refund('A'), dest: SELLER_ADDR }, SELLER)
    expect(proposalOf(board({ seller: [fake2] }), 'refund', 'A')).toBeUndefined()
    expect(proposalOf(board({ buyer: [sign(refund('C'), BUYER)] }), 'refund', 'C')?.settlement.dest).toBe(BUYER_ADDR)
  })

  test('a complete pair completes into a valid transaction', () => {
    const b = board({ buyer: [sign(refund('C'), BUYER)], arbiter: [sign(refund('C'), ARBITER)] })
    expect(b).toHaveLength(1)
    expect(b[0].complete).toBe(true)
    const done = completeSettlement({ tree, settlement: b[0].settlement, value: VALUE, network, signatures: b[0].sigs })
    expect(done.txid).toMatch(/^[0-9a-f]{64}$/)
  })
})
