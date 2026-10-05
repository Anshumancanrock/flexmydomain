// On-chain flex payments (core/nostr/flex.ts): claims, and pairing them with payments.

import { test, expect, describe } from 'bun:test'
import { bytesToHex } from '@noble/hashes/utils.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { signEvent } from '../../core/nostr/event.ts'
import { buildFlexClaim, flexClaimFilter, flexNearAmounts, flexPaymentZap, matchFlexPayments, parseFlexClaim, type FlexClaim, type FlexPayment } from '../../core/nostr/flex.ts'
import { rankFlexDomains } from '../../core/nostr/zap.ts'
import { decide, isOurAddress } from '../../services/relay/policy.ts'

const SK = new Uint8Array(32).fill(7)
const PK = bytesToHex(schnorr.getPublicKey(SK))
const OTHER_SK = new Uint8Array(32).fill(8)
const ADDRESS = 'tb1qh0wfj00cysg9qencrq7g27w2ams89qazlw9uzt'
const NOW = 1_791_200_000

const claim = (over: Partial<Parameters<typeof buildFlexClaim>[0]> = {}, sk = SK): FlexClaim => {
  const pubkey = bytesToHex(schnorr.getPublicKey(sk))
  const event = signEvent(buildFlexClaim({ pubkey, claimId: 'ab'.repeat(8), domain: 'lumenary.com', amountSats: 10_123, address: ADDRESS, createdAt: NOW - 600, ...over }), sk)
  const parsed = parseFlexClaim(event)
  if (!parsed.ok) throw new Error(parsed.reason)
  return parsed.claim
}
const pay = (valueSats: number, at: number | undefined, txid = 'cd'.repeat(32), vout = 0): FlexPayment =>
  ({ txid, vout, valueSats, at, confirmed: at !== undefined })

describe('a claim', () => {
  test('round-trips, names the domain normalised, and is tagged for the board', () => {
    const c = claim({ domain: 'LumenAry.com' })
    expect(c).toMatchObject({ id: 'ab'.repeat(8), author: PK, domain: 'lumenary.com', amountSats: 10_123, address: ADDRESS, at: NOW - 600 })
    expect(c.event.tags).toContainEqual(['t', 'fmd-flex'])
    expect(c.event.tags).toContainEqual(['t', 'fmd-flex-10123'])
    expect(flexClaimFilter({ since: NOW })).toEqual({ kinds: [30078], '#t': ['fmd-flex'], limit: 500, since: NOW })
    // Asked by amount, each paid amount once.
    expect(flexClaimFilter({ amounts: [10_123, 555, 10_123] })).toEqual({ kinds: [30078], '#t': ['fmd-flex-10123', 'fmd-flex-555'], limit: 500 })
    // A claim may be a few sats off its payment, so the board asks for the amounts around each one.
    expect(flexNearAmounts([100, 5], 2)).toEqual([3, 4, 5, 6, 7, 98, 99, 100, 101, 102])
    expect(flexNearAmounts([1], 2)).toEqual([1, 2, 3])
  })

  test('refuses a malformed one, whoever signed it', () => {
    const good = claim().event
    const resign = (tags: string[][], content = '') => signEvent({ ...good, tags, content }, SK)
    const without = (name: string) => good.tags.filter((t) => t[0] !== name)
    expect(parseFlexClaim(resign([...without('fmd_amount'), ['fmd_amount', '0']])).ok).toBe(false)
    expect(parseFlexClaim(resign([...without('fmd_amount'), ['fmd_amount', '12.5']])).ok).toBe(false)
    // The amount topic has to say the same amount.
    expect(parseFlexClaim(resign([...without('fmd_amount'), ['fmd_amount', '10124']])).ok).toBe(false)
    expect(parseFlexClaim(resign(good.tags.filter((t) => t[1] !== 'fmd-flex-10123'))).ok).toBe(false)
    expect(parseFlexClaim(resign([...without('fmd_address'), ['fmd_address', 'not-an-address']])).ok).toBe(false)
    expect(parseFlexClaim(resign([...without('fmd_domain'), ['fmd_domain', 'not a domain']])).ok).toBe(false)
    expect(parseFlexClaim(resign([...without('d'), ['d', 'fmd:flex:xyz']])).ok).toBe(false)
    expect(parseFlexClaim(resign(good.tags, 'hello')).ok).toBe(false)
    expect(() => buildFlexClaim({ pubkey: PK, claimId: 'ab'.repeat(8), domain: 'lumenary.com', amountSats: 0, address: ADDRESS, createdAt: NOW })).toThrow()
  })

  test('our relay keeps claims, refuses look-alikes, and counts their address as ours', () => {
    const good = claim().event
    expect(decide(good)).toEqual({ action: 'accept' })
    expect(decide(signEvent({ ...good, content: 'x' }, SK)).action).toBe('reject')
    expect(isOurAddress(`30078:${PK}:fmd:flex:${'ab'.repeat(8)}`)).toBe(true)
  })
})

describe('pairing payments with claims', () => {
  test('a payment of the exact amount goes to the claim, and the domain gets the sats', () => {
    const c = claim()
    const m = matchFlexPayments([c], [pay(10_123, NOW)], { address: ADDRESS, now: NOW })
    expect(m).toHaveLength(1)
    expect(m[0].claim.domain).toBe('lumenary.com')
  })

  test('the claimed amount is a minimum: paying more counts in full, paying less not at all', () => {
    const c = claim()
    expect(matchFlexPayments([c], [pay(10_124, NOW)], { address: ADDRESS, now: NOW })).toHaveLength(1)
    const big = matchFlexPayments([c], [pay(50_000, NOW)], { address: ADDRESS, now: NOW })
    expect(big.map((m) => [m.claim.domain, m.payment.valueSats])).toEqual([['lumenary.com', 50_000]])
    expect(matchFlexPayments([c], [pay(10_122, NOW)], { address: ADDRESS, now: NOW })).toEqual([])
  })

  test('odd sats name their claim first, and a bigger payment takes the closest open claim below it', () => {
    // Bob claims 2,345 and pays 10,000; Carol claims 8,000 and pays exactly that, later.
    const bob = claim({ claimId: '05'.repeat(8), createdAt: NOW - 900, amountSats: 2_345, domain: 'bob.com' })
    const carol = claim({ claimId: '06'.repeat(8), createdAt: NOW - 600, amountSats: 8_000, domain: 'carol.com' }, OTHER_SK)
    const paid = matchFlexPayments([bob, carol], [pay(10_000, NOW, 'aa'.repeat(32)), pay(8_000, NOW + 60, 'bb'.repeat(32))], { address: ADDRESS, now: NOW + 600 })
    expect(paid.map((x) => [x.claim.domain, x.payment.valueSats])).toEqual([['bob.com', 10_000], ['carol.com', 8_000]])
    // An exact claim beats an earlier near one, which still takes the next payment near it.
    const near = claim({ claimId: '03'.repeat(8), createdAt: NOW - 900, amountSats: 10_120, domain: 'near.com' })
    const exact = claim({ claimId: '04'.repeat(8), createdAt: NOW - 300, domain: 'exact.com' }, OTHER_SK)
    const m = matchFlexPayments([near, exact], [pay(10_123, NOW, 'aa'.repeat(32)), pay(10_121, NOW + 60, 'bb'.repeat(32))], { address: ADDRESS, now: NOW + 600 })
    expect(m.map((x) => [x.claim.domain, x.payment.valueSats])).toEqual([['exact.com', 10_123], ['near.com', 10_121]])
  })

  test('too little, another address, or nobody claiming it: the payment does not count', () => {
    const c = claim()
    expect(matchFlexPayments([c], [pay(9_000, NOW)], { address: ADDRESS, now: NOW })).toEqual([])
    expect(matchFlexPayments([claim({ address: 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7' })], [pay(10_123, NOW)], { address: ADDRESS, now: NOW })).toEqual([])
    expect(matchFlexPayments([], [pay(10_123, NOW)], { address: ADDRESS, now: NOW })).toEqual([])
  })

  test('a claim made after the payment, beyond clock slack, or more than a day before it, does not take it', () => {
    const late = claim({ createdAt: NOW + 3600 })
    expect(matchFlexPayments([late], [pay(10_123, NOW)], { address: ADDRESS, now: NOW })).toEqual([])
    const stale = claim({ createdAt: NOW - 2 * 86400 })
    expect(matchFlexPayments([stale], [pay(10_123, NOW)], { address: ADDRESS, now: NOW })).toEqual([])
  })

  test('the earliest claim for an amount wins, and each claim and payment is used once', () => {
    const first = claim({ claimId: '01'.repeat(8), createdAt: NOW - 900, domain: 'first.com' })
    const second = claim({ claimId: '02'.repeat(8), createdAt: NOW - 300, domain: 'second.com' }, OTHER_SK)
    const m = matchFlexPayments([second, first], [pay(10_123, NOW, 'aa'.repeat(32)), pay(10_123, NOW + 60, 'bb'.repeat(32)), pay(10_123, NOW + 120, 'cc'.repeat(32))], { address: ADDRESS, now: NOW + 600 })
    expect(m.map((x) => x.claim.domain)).toEqual(['first.com', 'second.com'])
    // The same output reported twice counts once.
    expect(matchFlexPayments([first, second], [pay(10_123, NOW), pay(10_123, NOW)], { address: ADDRESS, now: NOW })).toHaveLength(1)
  })

  test('a payment still in the mempool counts at the current time', () => {
    const c = claim()
    expect(matchFlexPayments([c], [pay(10_123, undefined)], { address: ADDRESS, now: NOW })).toHaveLength(1)
  })

  test('paying more than #1 takes the top, and #1 slips to #2; matching it later does not', () => {
    const ranks = (claims: FlexClaim[], payments: FlexPayment[]) =>
      rankFlexDomains(matchFlexPayments(claims, payments, { address: ADDRESS, now: NOW + 900 })
        .map(({ claim, payment }) => flexPaymentZap(claim, payment, NOW + 900)), { now: NOW + 900 })
        .map((r) => [r.domain, r.sats])
    const first = claim({ claimId: '07'.repeat(8), createdAt: NOW - 900, amountSats: 1_601, domain: 'anshuman.lol' })
    const firstPaid = pay(1_602, NOW - 600, 'aa'.repeat(32))
    expect(ranks([first], [firstPaid])).toEqual([['anshuman.lol', 1_602]])

    const top = claim({ claimId: '08'.repeat(8), createdAt: NOW - 300, amountSats: 1_603, domain: 'lumenary.com' }, OTHER_SK)
    expect(ranks([first, top], [firstPaid, pay(1_603, NOW - 60, 'bb'.repeat(32))]))
      .toEqual([['lumenary.com', 1_603], ['anshuman.lol', 1_602]])

    // A tie keeps the earlier payment higher, and a claim made after a payment can't take it
    // from the claim made before it, even with a closer amount.
    const tie = claim({ claimId: '09'.repeat(8), createdAt: NOW - 300, amountSats: 1_602, domain: 'later.com' }, OTHER_SK)
    expect(ranks([first, tie], [firstPaid, pay(1_602, NOW - 60, 'cc'.repeat(32))]))
      .toEqual([['anshuman.lol', 1_602], ['later.com', 1_602]])
  })
})
