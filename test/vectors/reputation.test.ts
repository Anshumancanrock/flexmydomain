/**
 * Zaps, trade receipts and badges: the parts that can be gamed for money.
 *
 * Many tests below exercise one attack each. A zap counter or reputation score
 * that skips any of these checks gives a ranking that costs nothing to climb.
 */

import { test, expect, describe } from 'bun:test'
import { bytesToHex } from '@noble/hashes/utils.js'
import { schnorr } from '@noble/curves/secp256k1.js'

import {
  BADGE_DEFINITION_KIND,
  FMD_BADGES,
  MSATS_PER_SAT,
  RECEIPT_KIND,
  ZAP_RECEIPT_KIND,
  addressOf,
  bolt11AmountMsats,
  buildBadgeAward,
  buildBadgeDefinition,
  buildProfileBadges,
  buildReceipt,
  buildZapRequest,
  countsTowardReputation,
  eventId,
  pairReceipts,
  parseBadgeDefinition,
  parseProfileBadges,
  parseReceipt,
  rankByZaps,
  rankFlexDomains,
  receiptFilter,
  signEvent,
  summariseTrades,
  verifiedBadges,
  verifyZapReceipt,
  zapReceiptFilter,
  type NostrEvent,
  type Receipt,
} from '../../core/nostr/index.ts'

const AUX = new Uint8Array(32)
const key = (fill: number) => {
  const sk = new Uint8Array(32).fill(fill)
  return { sk, pk: bytesToHex(schnorr.getPublicKey(sk)) }
}
const ALICE = key(0x11)   // buyer
const BOB = key(0x22)     // seller
const PROVIDER = key(0x33) // the recipient's zapper service
const MALLORY = key(0x44)
const NOW = 1789430400
const LISTING = `30402:${BOB.pk}:fmd:listing:lumenary.com`

// ---------------------------------------------------------------------------
// zaps
// ---------------------------------------------------------------------------

describe('BOLT-11 amounts', () => {
  test('the multipliers are divisors of a bitcoin, not multiples of a sat', () => {
    // The classic bug lands a thousandfold out. These are the BOLT-11 examples.
    expect(bolt11AmountMsats('lnbc2500u1pvjluez')).toBe(250_000_000) // 0.0025 BTC
    expect(bolt11AmountMsats('lnbc20m1pvjluez')).toBe(2_000_000_000) // 0.02 BTC
    expect(bolt11AmountMsats('lnbc1u1p')).toBe(100_000) // 100 sats
    expect(bolt11AmountMsats('lnbc100n1p')).toBe(10_000) // 10 sats
  })

  test('testnet and regtest prefixes parse', () => {
    expect(bolt11AmountMsats('lntb100n1p')).toBe(10_000)
    expect(bolt11AmountMsats('lnbcrt100n1p')).toBe(10_000)
  })

  test('an amountless invoice is undefined, not zero', () => {
    // "any amount" cannot be counted: nothing says what was paid.
    expect(bolt11AmountMsats('lnbc1pabcdef')).toBeUndefined()
    expect(bolt11AmountMsats('not an invoice')).toBeUndefined()
  })
})

describe('zap receipts', () => {
  function zapPair(opts: {
    amountMsats?: number
    invoice?: string
    sender?: typeof ALICE
    recipient?: string
    address?: string
    provider?: typeof PROVIDER
  } = {}) {
    const amountMsats = opts.amountMsats ?? 100_000
    const sender = opts.sender ?? ALICE
    const recipient = opts.recipient ?? BOB.pk
    const provider = opts.provider ?? PROVIDER

    const request = signEvent(
      buildZapRequest({
        pubkey: sender.pk,
        recipient,
        amountMsats,
        relays: ['wss://nos.lol'],
        address: opts.address ?? LISTING,
        createdAt: NOW,
      }),
      sender.sk,
      AUX,
    )
    const receipt = signEvent(
      {
        pubkey: provider.pk,
        created_at: NOW + 5,
        kind: ZAP_RECEIPT_KIND,
        tags: [
          ['p', recipient],
          ['bolt11', opts.invoice ?? `lnbc${amountMsats / MSATS_PER_SAT / 1000}u1pfake`],
          ['description', JSON.stringify(request)],
        ],
        content: '',
      },
      provider.sk,
      AUX,
    )
    return { request, receipt }
  }

  test('a well-formed zap verifies', () => {
    const { receipt } = zapPair({ amountMsats: 100_000, invoice: 'lnbc1u1pfake' })
    const r = verifyZapReceipt({ receipt, recipient: BOB.pk, expectedProvider: PROVIDER.pk })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.zap.amountSats).toBe(100)
      expect(r.zap.sender).toBe(ALICE.pk)
      expect(r.zap.address).toBe(LISTING)
    }
  })

  test('a receipt written by anyone but the published zapper key is refused', () => {
    const { receipt } = zapPair({ provider: MALLORY, invoice: 'lnbc1u1pfake' })
    const r = verifyZapReceipt({ receipt, recipient: BOB.pk, expectedProvider: PROVIDER.pk })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('zapper key')
  })

  test('a request that claims more than the invoice pays is refused', () => {
    // The request says 1,000,000 msats; the invoice is for 100,000.
    const { receipt } = zapPair({ amountMsats: 1_000_000, invoice: 'lnbc1u1pfake' })
    const r = verifyZapReceipt({ receipt, recipient: BOB.pk, expectedProvider: PROVIDER.pk })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('invoice is for')
  })

  test('a zap to someone else is not counted here', () => {
    const { receipt } = zapPair({ recipient: MALLORY.pk, invoice: 'lnbc1u1pfake' })
    const r = verifyZapReceipt({ receipt, recipient: BOB.pk, expectedProvider: PROVIDER.pk })
    expect(r.ok).toBe(false)
  })

  test('a forged zap request inside a real receipt is refused', () => {
    const { request, receipt } = zapPair({ invoice: 'lnbc1u1pfake' })
    const tampered = { ...request, content: 'rewritten after signing' }
    const forged = signEvent(
      {
        ...receipt,
        tags: receipt.tags.map((t) => (t[0] === 'description' ? ['description', JSON.stringify(tampered)] : t)),
      },
      PROVIDER.sk,
      AUX,
    )
    const r = verifyZapReceipt({ receipt: forged, recipient: BOB.pk, expectedProvider: PROVIDER.pk })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('zap request')
  })

  test('a missing zapper key is a refusal, never a pass', () => {
    const { receipt } = zapPair({ invoice: 'lnbc1u1pfake' })
    const r = verifyZapReceipt({ receipt, recipient: BOB.pk, expectedProvider: '' })
    expect(r.ok).toBe(false)
  })

  test('a zap request with no relays is refused at build time', () => {
    expect(() =>
      buildZapRequest({ pubkey: ALICE.pk, recipient: BOB.pk, amountMsats: 1000, relays: [], createdAt: NOW }),
    ).toThrow(/relay/)
  })
})

describe('the featured board ranking', () => {
  const zap = (address: string, sats: number, at: number, id: string) =>
    ({ address, amountSats: sats, at, receipt: { id } } as never)

  test('rank is the bid, and a tie keeps the earlier zap higher', () => {
    const ranked = rankByZaps(
      [zap('a', 100, NOW, '1'), zap('b', 100, NOW - 50, '2'), zap('c', 300, NOW, '3')],
      { now: NOW },
    )
    expect(ranked.map((r) => r.address)).toEqual(['c', 'b', 'a'])
  })

  test('the window is rolling, so an old zap stops counting', () => {
    const ranked = rankByZaps([zap('a', 999, NOW - 8 * 86400, '1'), zap('b', 1, NOW, '2')], { now: NOW })
    expect(ranked.map((r) => r.address)).toEqual(['b'])
  })

  test('the same receipt fetched from five relays counts once', () => {
    const ranked = rankByZaps([zap('a', 100, NOW, 'same'), zap('a', 100, NOW, 'same')], { now: NOW })
    expect(ranked[0].sats).toBe(100)
    expect(ranked[0].zaps).toBe(1)
  })

  test('zaps with no address are not board entries', () => {
    expect(rankByZaps([zap(undefined as never, 100, NOW, '1')], { now: NOW })).toEqual([])
  })
})

test('the zap filter narrows by coordinate and recipient', () => {
  expect(zapReceiptFilter({ addresses: [LISTING], recipient: BOB.pk, since: NOW })).toEqual({
    kinds: [9735],
    '#a': [LISTING],
    '#p': [BOB.pk],
    since: NOW,
  })
})

// ---------------------------------------------------------------------------
// trade receipts
// ---------------------------------------------------------------------------

describe('trade receipts', () => {
  const TXID = 'a'.repeat(64)
  const SETTLE = 'b'.repeat(64)

  function receiptOf(
    author: typeof ALICE,
    role: 'buyer' | 'seller',
    counterparty: string,
    over: Partial<Parameters<typeof buildReceipt>[0]> = {},
  ): Receipt {
    const event = signEvent(
      buildReceipt({
        pubkey: author.pk,
        role,
        counterparty,
        outcome: 'settled',
        domain: 'lumenary.com',
        listing: LISTING,
        escrowId: 'esc-1',
        funding: `${TXID}:0`,
        settlement: SETTLE,
        amountSats: 2_500_000,
        transferSnapshot: 'c'.repeat(64),
        createdAt: NOW,
        ...over,
      }),
      author.sk,
      AUX,
    )
    const parsed = parseReceipt(event)
    if (!parsed.ok) throw new Error(parsed.reason)
    return parsed.receipt
  }

  test('a receipt is a NIP-32 label about the other party', () => {
    const r = receiptOf(ALICE, 'buyer', BOB.pk)
    expect(r.event.kind).toBe(RECEIPT_KIND)
    expect(r.counterparty).toBe(BOB.pk)
    expect(r.author).toBe(ALICE.pk)
    expect(r.event.tags).toContainEqual(['L', 'fmd.trade'])
    expect(r.event.tags).toContainEqual(['l', 'settled', 'fmd.trade'])
  })

  test('a receipt about yourself is refused', () => {
    expect(() =>
      buildReceipt({
        pubkey: ALICE.pk,
        role: 'buyer',
        counterparty: ALICE.pk,
        outcome: 'settled',
        domain: 'lumenary.com',
        escrowId: 'e',
        funding: `${TXID}:0`,
        settlement: SETTLE,
        amountSats: 1,
        createdAt: NOW,
      }),
    ).toThrow(/never about yourself/)
  })

  test('a matched pair is a mutual trade', () => {
    const trades = pairReceipts([receiptOf(ALICE, 'buyer', BOB.pk), receiptOf(BOB, 'seller', ALICE.pk)])
    expect(trades).toHaveLength(1)
    expect(trades[0].mutual).toBe(true)
    expect(trades[0].buyer).toBe(ALICE.pk)
    expect(trades[0].seller).toBe(BOB.pk)
    expect(countsTowardReputation(trades[0])).toBe(true)
  })

  test('one receipt alone is not a trade', () => {
    const trades = pairReceipts([receiptOf(ALICE, 'buyer', BOB.pk)])
    expect(trades[0].mutual).toBe(false)
    expect(countsTowardReputation(trades[0])).toBe(false)
  })

  test('disagreement is recorded, not resolved', () => {
    const trades = pairReceipts([
      receiptOf(ALICE, 'buyer', BOB.pk, { amountSats: 2_500_000 }),
      receiptOf(BOB, 'seller', ALICE.pk, { amountSats: 9_999_999 }),
    ])
    expect(trades[0].mutual).toBe(false)
    expect(trades[0].conflicts).toContain('the two receipts disagree about the amount')
  })

  test('without an observed registry transfer, a trade is weighted at zero', () => {
    const trades = pairReceipts([
      receiptOf(ALICE, 'buyer', BOB.pk, { transferSnapshot: undefined }),
      receiptOf(BOB, 'seller', ALICE.pk, { transferSnapshot: undefined }),
    ])
    expect(trades[0].mutual).toBe(true) // it is a real, agreeing pair
    expect(countsTowardReputation(trades[0])).toBe(false) // and it still counts for nothing

    const summary = summariseTrades(trades, ALICE.pk)
    expect(summary.verified).toBe(0)
    expect(summary.unweighted).toBe(1) // shown, never hidden
  })

  test('ten trades with one partner is one relationship', () => {
    const trades = Array.from({ length: 10 }, (_, i) =>
      pairReceipts([
        receiptOf(ALICE, 'buyer', BOB.pk, { escrowId: `esc-${i}` }),
        receiptOf(BOB, 'seller', ALICE.pk, { escrowId: `esc-${i}` }),
      ])[0],
    )
    const summary = summariseTrades(trades, ALICE.pk)
    expect(summary.verified).toBe(10)
    expect(summary.counterparties).toBe(1)
    expect(summary.partners).toEqual([BOB.pk])
  })

  test('the summary never invents a score', () => {
    const trades = pairReceipts([receiptOf(ALICE, 'buyer', BOB.pk), receiptOf(BOB, 'seller', ALICE.pk)])
    const summary = summariseTrades(trades, ALICE.pk)
    expect(Object.keys(summary).sort()).toEqual(
      ['conflicted', 'counterparties', 'firstTradeAt', 'partners', 'satsSettled', 'unweighted', 'verified'].sort(),
    )
  })

  test('the filter asks both directions, by and about', () => {
    expect(receiptFilter([ALICE.pk])).toEqual([
      { kinds: [1985], authors: [ALICE.pk] },
      { kinds: [1985], '#p': [ALICE.pk] },
    ])
  })
})

// ---------------------------------------------------------------------------
// badges
// ---------------------------------------------------------------------------

describe('badges', () => {
  const definition = signEvent(
    buildBadgeDefinition({ pubkey: ALICE.pk, badge: FMD_BADGES.verifiedSale, createdAt: NOW }),
    ALICE.sk,
    AUX,
  )
  const coordinate = addressOf(definition)
  const award = signEvent(
    buildBadgeAward({ pubkey: ALICE.pk, definition: coordinate, recipients: [BOB.pk], createdAt: NOW }),
    ALICE.sk,
    AUX,
  )

  test('a definition round-trips', () => {
    const parsed = parseBadgeDefinition(definition)
    expect(parsed?.slug).toBe('fmd-verified-sale')
    expect(parsed?.issuer).toBe(ALICE.pk)
    expect(coordinate.startsWith(`${BADGE_DEFINITION_KIND}:${ALICE.pk}:`)).toBe(true)
  })

  test('profile badges are ordered a/e pairs', () => {
    const profile = signEvent(
      buildProfileBadges({ pubkey: BOB.pk, badges: [{ definition: coordinate, awardId: award.id }], createdAt: NOW }),
      BOB.sk,
      AUX,
    )
    expect(parseProfileBadges(profile)).toEqual([{ definition: coordinate, awardId: award.id }])
    expect(verifiedBadges({ pubkey: BOB.pk, profile, awards: [award] })).toHaveLength(1)
  })

  test('a badge you were never awarded does not verify', () => {
    // Mallory publishes a 30008 naming Bob's award. It is a valid event.
    const profile = signEvent(
      buildProfileBadges({ pubkey: MALLORY.pk, badges: [{ definition: coordinate, awardId: award.id }], createdAt: NOW }),
      MALLORY.sk,
      AUX,
    )
    expect(parseProfileBadges(profile)).toHaveLength(1) // it claims one
    expect(verifiedBadges({ pubkey: MALLORY.pk, profile, awards: [award] })).toEqual([]) // and it backs none
  })

  test("an award of somebody else's badge does not verify", () => {
    const forged = signEvent(
      buildBadgeAward({ pubkey: MALLORY.pk, definition: coordinate, recipients: [MALLORY.pk], createdAt: NOW }),
      MALLORY.sk,
      AUX,
    )
    const profile = signEvent(
      buildProfileBadges({ pubkey: MALLORY.pk, badges: [{ definition: coordinate, awardId: forged.id }], createdAt: NOW }),
      MALLORY.sk,
      AUX,
    )
    // The definition belongs to Alice; Mallory cannot issue it.
    expect(verifiedBadges({ pubkey: MALLORY.pk, profile, awards: [forged] })).toEqual([])
  })

  test('a half pair is dropped rather than guessed at', () => {
    const profile: NostrEvent = signEvent(
      {
        pubkey: BOB.pk,
        created_at: NOW,
        kind: 30008,
        tags: [['d', 'profile_badges'], ['a', coordinate]],
        content: '',
      },
      BOB.sk,
      AUX,
    )
    expect(parseProfileBadges(profile)).toEqual([])
  })

  test('an award for a non-badge coordinate is refused at build time', () => {
    expect(() =>
      buildBadgeAward({ pubkey: ALICE.pk, definition: LISTING, recipients: [BOB.pk], createdAt: NOW }),
    ).toThrow(/badge definition coordinate/)
  })
})

describe('a market "Feature" payment reaches the flex board', () => {
  /*
   * The flex board counts zaps by domain and drops any zap with no `fmd_flex`
   * tag, so a feature zap carrying only the listing's `a` coordinate would be
   * paid for and never appear. The market page must pass flexDomain too.
   * These two tests pin both halves: without flexDomain the zap is dropped,
   * with it the zap counts.
   */
  const receiptFor = (withFlex: boolean) => {
    const request = signEvent(
      buildZapRequest({
        pubkey: ALICE.pk,
        recipient: BOB.pk,
        amountMsats: 100_000,
        relays: ['wss://nos.lol'],
        address: LISTING,
        ...(withFlex ? { flexDomain: 'lumenary.com' } : {}),
        createdAt: NOW,
      }),
      ALICE.sk,
      AUX,
    )
    const receipt = signEvent(
      {
        pubkey: PROVIDER.pk,
        created_at: NOW + 5,
        kind: ZAP_RECEIPT_KIND,
        tags: [['p', BOB.pk], ['bolt11', 'lnbc1u1pfake'], ['description', JSON.stringify(request)]],
        content: '',
      },
      PROVIDER.sk,
      AUX,
    )
    const verified = verifyZapReceipt({ receipt, recipient: BOB.pk, expectedProvider: PROVIDER.pk })
    if (!verified.ok) throw new Error(verified.reason)
    return verified.zap
  }

  test('a zap carrying only the listing coordinate is invisible to the board', () => {
    expect(rankFlexDomains([receiptFor(false)], { now: NOW + 10 })).toEqual([])
  })

  test('a zap carrying flexDomain and the coordinate is counted', () => {
    const ranked = rankFlexDomains([receiptFor(true)], { now: NOW + 10 })
    expect(ranked).toHaveLength(1)
    expect(ranked[0].domain).toBe('lumenary.com')
    expect(ranked[0].sats).toBe(100)
  })
})
