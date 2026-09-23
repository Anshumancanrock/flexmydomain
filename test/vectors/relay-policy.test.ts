/**
 * The relay's write policy: services/relay/policy.ts and write-policy.ts.
 *
 * Every accepted event is built by the core/ builder the site uses, so an
 * accept means the site's own events get stored. Most refusals are near misses
 * of an accepted event (the same event with one thing wrong), so the policy
 * cannot pass by refusing everything.
 */

import { test, expect, describe } from 'bun:test'
import { bytesToHex } from '@noble/hashes/utils.js'
import { schnorr } from '@noble/curves/secp256k1.js'

import { signEvent, type NostrEvent, type UnsignedEvent } from '../../core/nostr/event.js'
import { buildListing } from '../../core/nostr/listing.js'
import { buildPortfolio } from '../../core/nostr/portfolio.js'
import { buildEscrowEvent } from '../../core/nostr/escrow.js'
import { buildDeletion } from '../../core/nostr/deletion.js'
import { buildZapRequest } from '../../core/nostr/zap.js'
import { buildArbiterSet, buildWatchlist } from '../../core/nostr/profile.js'
import { buildRelayList } from '../../core/nostr/relays.js'
import { buildReceipt } from '../../core/nostr/receipt.js'
import { buildAttestation, buildVerifyRequest } from '../../core/nostr/attestation.js'
import { FMD_BADGES, buildBadgeAward, buildBadgeDefinition } from '../../core/nostr/badge.js'
import { createProof, proofEvent } from '../../core/oracle/proof.js'
import { sealMessage } from '../../client/messages.js'
import { OFF_TOPIC, decide, isOurAddress } from '../../services/relay/policy.js'
import { createRateLimiter, handle, optionsFromEnv, rateKey } from '../../services/relay/write-policy.js'

const SK = new Uint8Array(32).fill(7)
const PK = bytesToHex(schnorr.getPublicKey(SK))
const OTHER_SK = new Uint8Array(32).fill(9)
const OTHER = bytesToHex(schnorr.getPublicKey(OTHER_SK))
const ZAPPER_SK = new Uint8Array(32).fill(11)
const NOW = 1_790_000_000
const DOMAIN = 'lumenary.com'
const signer = { getPublicKey: async () => PK, signEvent: async (u: UnsignedEvent) => signEvent(u, SK) }
const sign = (u: UnsignedEvent, sk = SK) => signEvent(u, sk)
const accepts = (e: NostrEvent, opts = {}) => expect(decide(e, opts)).toEqual({ action: 'accept' })
const refuses = (e: NostrEvent, why: RegExp | string, opts = {}) => {
  const d = decide(e, opts)
  expect(d.action).toBe('reject')
  if (d.action === 'reject') expect(d.msg).toMatch(why)
}

const { record, event: proofEvt } = await createProof({ domain: DOMAIN, iat: NOW, signer })
const listing = sign(buildListing({ pubkey: PK, domain: DOMAIN, priceSats: 2_500_000, publishedAt: NOW, proof: record }))

describe('listings (30402)', () => {
  test('a listing with a proof by its own key is stored', () => accepts(listing))

  test('a listing whose embedded proof does not verify is refused', () => {
    const badSig = record.sig.slice(0, -2) + (record.sig.endsWith('00') ? '01' : '00')
    const bad = sign(buildListing({ pubkey: PK, domain: DOMAIN, priceSats: 1, publishedAt: NOW, proof: { ...record, sig: badSig } }))
    refuses(bad, /domain proof signed by its own key/)
  })

  test("another marketplace's listing (no flexmydomain topic) is refused", () => {
    const unsigned = buildListing({ pubkey: PK, domain: DOMAIN, priceSats: 1, publishedAt: NOW, proof: record })
    refuses(sign({ ...unsigned, tags: unsigned.tags.filter((t) => t[0] !== 't') }), OFF_TOPIC)
  })
})

describe('application data (30078)', () => {
  test('a domain proof, a portfolio and an escrow view are stored', () => {
    accepts(proofEvt)
    accepts(sign(buildPortfolio({ pubkey: PK, createdAt: NOW, entries: [{ domain: DOMAIN, iat: NOW, sig: record.sig, source: 'dns', firstSeen: NOW }] })))
    const escrow = sign(buildEscrowEvent({
      pubkey: PK, createdAt: NOW, salt: 'ab'.repeat(32), buyer: schnorr.getPublicKey(SK), seller: schnorr.getPublicKey(OTHER_SK),
      timeoutTo: 'seller', timeoutBlocks: 144, network: 'signet', amountSats: 50_000, domain: DOMAIN,
    }))
    accepts(escrow)
  })

  test('an escrow view whose address its own keys do not produce is refused', () => {
    const unsigned = buildEscrowEvent({
      pubkey: PK, createdAt: NOW, salt: 'ab'.repeat(32), buyer: schnorr.getPublicKey(SK), seller: schnorr.getPublicKey(OTHER_SK),
      timeoutTo: 'seller', timeoutBlocks: 144, network: 'signet', amountSats: 50_000, domain: DOMAIN,
    })
    const body = JSON.parse(unsigned.content)
    body.address = 'tb1p' + 'q'.repeat(58)
    refuses(sign({ ...unsigned, content: JSON.stringify(body) }), /not a valid escrow view/)
  })

  test('a proof whose d tag is not normalised is refused', () => {
    const unsigned = proofEvent({ domain: DOMAIN, pubkey: PK, iat: NOW })
    refuses(sign({ ...unsigned, tags: [['d', 'fmd:proof:WWW.Lumenary.com']] }), /not a valid domain proof/)
  })

  test("another application's kind 30078 is refused", () => {
    refuses(sign({ pubkey: PK, created_at: NOW, kind: 30078, tags: [['d', 'someapp:settings']], content: '{}' }), OFF_TOPIC)
  })
})

describe('deletions (5)', () => {
  test('a delisting (a deletion naming kind 30402 by k and a) is stored', () => {
    accepts(sign(buildDeletion({ pubkey: PK, events: [listing], reason: 'sold', createdAt: NOW })))
  })

  test('a deletion of a kind this project does not publish is refused', () => {
    const note = sign({ pubkey: PK, created_at: NOW, kind: 1, tags: [], content: 'gm' })
    refuses(sign(buildDeletion({ pubkey: PK, events: [note], createdAt: NOW })), OFF_TOPIC)
  })

  test('deleting a proof, the portfolio or an escrow view is stored', () => {
    const portfolio = sign(buildPortfolio({ pubkey: PK, createdAt: NOW, entries: [{ domain: DOMAIN, iat: NOW, sig: record.sig, source: 'dns', firstSeen: NOW }] }))
    const escrow = sign(buildEscrowEvent({
      pubkey: PK, createdAt: NOW, salt: 'ab'.repeat(32), buyer: schnorr.getPublicKey(SK), seller: schnorr.getPublicKey(OTHER_SK),
      timeoutTo: 'seller', timeoutBlocks: 144, network: 'signet', amountSats: 50_000, domain: DOMAIN,
    }))
    for (const event of [proofEvt, portfolio, escrow]) accepts(sign(buildDeletion({ pubkey: PK, events: [event], createdAt: NOW })))
  })

  /* Other apps share kinds 30402 and 30078 and publish their deletions to the
     same public relays; the mirror's #k filter sees every one of them. */
  test("another marketplace's delisting, or another app's 30078 deletion, is refused", () => {
    const theirs = (kind: number, d: string) => sign({
      pubkey: PK, created_at: NOW, kind: 5, content: '', tags: [['a', `${kind}:${PK}:${d}`], ['k', String(kind)]],
    })
    refuses(theirs(30402, 'product_1'), OFF_TOPIC)
    refuses(theirs(30402, 'listing:lumenary.com'), OFF_TOPIC)
    refuses(theirs(30078, 'someapp:settings'), OFF_TOPIC)
    refuses(theirs(30009, 'bravery'), OFF_TOPIC)
    refuses(theirs(30000, 'friends'), OFF_TOPIC)
  })

  test('a deletion by event id alone is refused: it names nothing that can be told apart as ours', () => {
    refuses(sign({ pubkey: PK, created_at: NOW, kind: 5, content: '', tags: [['e', listing.id], ['k', '30402']] }), OFF_TOPIC)
  })

  test('one address of ours among others is enough', () => {
    const mixed = sign({ pubkey: PK, created_at: NOW, kind: 5, content: '', tags: [
      ['a', `30402:${PK}:product_1`], ['a', `30402:${PK}:fmd:listing:${DOMAIN}`], ['k', '30402'],
    ] })
    accepts(mixed)
  })

  test('addresses are read in full: the d tag keeps its colons, and a malformed coordinate is not ours', () => {
    expect(isOurAddress(`30402:${PK}:fmd:listing:${DOMAIN}`)).toBe(true)
    expect(isOurAddress(`30078:${PK}:fmd:portfolio`)).toBe(true)
    expect(isOurAddress(`30078:${PK}:fmd:escrow:${'ab'.repeat(16)}`)).toBe(true)
    expect(isOurAddress(`30000:${PK}:fmd:arbiters`)).toBe(true)
    expect(isOurAddress(`30009:${PK}:fmd-verified-sale`)).toBe(true)
    expect(isOurAddress(`31990:${PK}:fmd-client`)).toBe(true)
    expect(isOurAddress(`30402:${PK}:`)).toBe(false)
    expect(isOurAddress(`30402:${PK}`)).toBe(false)
    expect(isOurAddress(`30402:npub1nope:fmd:listing:${DOMAIN}`)).toBe(false)
    expect(isOurAddress(`3O402:${PK}:fmd:listing:${DOMAIN}`)).toBe(false)
    expect(isOurAddress(`30078:${PK}:fmd:portfolio:extra`)).toBe(false)
  })
})

describe('zap receipts (9735)', () => {
  const receiptFor = (request: NostrEvent, recipient = OTHER) => sign({
    pubkey: bytesToHex(schnorr.getPublicKey(ZAPPER_SK)), created_at: NOW, kind: 9735, content: '',
    tags: [['p', recipient], ['bolt11', 'lnbc210n1placeholder'], ['description', JSON.stringify(request)]],
  }, ZAPPER_SK)
  const flexRequest = sign(buildZapRequest({ pubkey: PK, recipient: OTHER, amountMsats: 21_000, relays: ['wss://nos.lol'], flexDomain: DOMAIN, createdAt: NOW }))
  const plainRequest = sign(buildZapRequest({ pubkey: PK, recipient: OTHER, amountMsats: 21_000, relays: ['wss://nos.lol'], createdAt: NOW }))

  test('a receipt for a flex-board zap is stored', () => accepts(receiptFor(flexRequest)))
  test('a receipt for an ordinary zap is refused', () => refuses(receiptFor(plainRequest), OFF_TOPIC))
  test('with a configured recipient, a receipt paid to anyone else is refused', () => {
    accepts(receiptFor(flexRequest), { flexRecipient: OTHER })
    refuses(receiptFor(flexRequest), OFF_TOPIC, { flexRecipient: PK })
  })
  test('a receipt without its zap request is refused', () => {
    const noDescription = sign({ pubkey: PK, created_at: NOW, kind: 9735, tags: [['p', OTHER]], content: '' })
    refuses(noDescription, /must carry its zap request/)
  })
})

describe('the rest of what the site publishes', () => {
  test('relay lists, which the outbox model reads, are stored up to a bound', () => {
    accepts(sign(buildRelayList({ pubkey: PK, createdAt: NOW, relays: [{ url: 'wss://nos.lol', read: true, write: true }] })))
    const many = Array.from({ length: 51 }, (_, i) => ['r', `wss://relay${i}.example.com`])
    refuses(sign({ pubkey: PK, created_at: NOW, kind: 10002, tags: many, content: '' }), /at most 50 relays/)
    refuses(sign({ pubkey: PK, created_at: NOW, kind: 10002, tags: [['r', 'https://not-a-relay.example']], content: '' }), /ws:\/\/ or wss:\/\//)
    refuses(sign({ pubkey: PK, created_at: NOW, kind: 10002, tags: [['r', 'wss://nos.lol']], content: 'x'.repeat(2000) }), /no content/)
  })

  test('profiles are refused: the site never publishes one, and anyone can mint them', () => {
    refuses(sign({ pubkey: PK, created_at: NOW, kind: 0, tags: [], content: '{"name":"x"}' }), OFF_TOPIC)
  })

  test('arbiter sets and watchlists are stored; other follow sets are not', () => {
    accepts(sign(buildArbiterSet({ pubkey: PK, arbiters: [OTHER], createdAt: NOW })))
    accepts(sign(buildWatchlist({ pubkey: PK, domains: [DOMAIN], createdAt: NOW })))
    refuses(sign({ pubkey: PK, created_at: NOW, kind: 30000, tags: [['d', 'friends'], ['p', OTHER]], content: '' }), OFF_TOPIC)
  })

  test('trade receipts, verification requests and attestations are stored', () => {
    accepts(sign(buildReceipt({
      pubkey: PK, role: 'buyer', counterparty: OTHER, outcome: 'settled', domain: DOMAIN, escrowId: 'ab'.repeat(16),
      funding: 'cd'.repeat(32) + ':0', settlement: 'ef'.repeat(32), amountSats: 50_000, createdAt: NOW,
    })))
    accepts(sign(buildVerifyRequest({ pubkey: PK, domain: DOMAIN, claimant: OTHER, createdAt: NOW })))
    accepts(sign(buildAttestation({ pubkey: PK, domain: DOMAIN, claimant: OTHER, verdict: 'proven', observedAt: NOW, createdAt: NOW })))
  })

  test('labels in another namespace are refused', () => {
    refuses(sign({ pubkey: PK, created_at: NOW, kind: 1985, tags: [['L', 'ugc'], ['l', 'spam', 'ugc']], content: '' }), OFF_TOPIC)
  })

  test("the marketplace's badges are stored; other badges are not", () => {
    accepts(sign(buildBadgeDefinition({ pubkey: PK, badge: FMD_BADGES.verifiedSale, createdAt: NOW })))
    accepts(sign(buildBadgeAward({ pubkey: PK, definition: `30009:${PK}:fmd-verified-sale`, recipients: [OTHER], createdAt: NOW })))
    refuses(sign({ pubkey: PK, created_at: NOW, kind: 30009, tags: [['d', 'bravery'], ['name', 'Brave']], content: '' }), OFF_TOPIC)
  })

  test('job feedback is kept only from the verifiers the operator names', () => {
    const feedback = sign({ pubkey: PK, created_at: NOW, kind: 7000, tags: [['status', 'processing', ''], ['e', 'ab'.repeat(32)]], content: '' })
    refuses(feedback, OFF_TOPIC)
    accepts(feedback, { verifiers: [PK] })
  })

  test('a plain note is refused with a reason a client can show', () => {
    refuses(sign({ pubkey: PK, created_at: NOW, kind: 1, tags: [], content: 'gm' }), /^blocked: this relay stores flexmydomain events only$/)
  })
})

describe('gift wraps (1059)', () => {
  const wrap = sealMessage({ senderSecretKey: SK, recipient: OTHER, content: 'the auth code', now: NOW })
  test('refused by default: nothing reads them yet, and a relay cannot inspect them', () => {
    refuses(wrap, /private messages are not stored here yet/)
  })
  test('stored when the operator turns them on', () => accepts(wrap, { acceptGiftWraps: true }))
})

describe('the plugin process', () => {
  const input = (event: NostrEvent, sourceType = 'IP4', sourceInfo = '203.0.113.7') =>
    ({ type: 'new', event, receivedAt: NOW, sourceType, sourceInfo })
  const note = sign({ pubkey: PK, created_at: NOW, kind: 1, tags: [], content: 'gm' })

  test('echoes the id, and tells a client why', () => {
    const out = handle(input(note), {}, () => true, NOW)
    expect(out).toEqual({ id: note.id, action: 'reject', msg: `blocked: ${OFF_TOPIC}` })
    expect(handle(input(listing), {}, () => true, NOW)).toEqual({ id: listing.id, action: 'accept' })
  })

  test('is silent about refusals from a router stream, so the log does not flood', () => {
    expect(handle(input(note, 'Stream', 'wss://nos.lol'), {}, () => true, NOW)).toEqual({ id: note.id, action: 'reject', msg: '' })
  })

  test('rate-limits clients per address, and never the operator’s own streams', () => {
    const allow = createRateLimiter(60, 2)
    expect(handle(input(listing), {}, allow, NOW).action).toBe('accept')
    expect(handle(input(listing), {}, allow, NOW).action).toBe('accept')
    expect(handle(input(listing), {}, allow, NOW)).toEqual({ id: listing.id, action: 'reject', msg: 'rate-limited: slow down' })
    expect(handle(input(listing, 'IP4', '198.51.100.1'), {}, allow, NOW).action).toBe('accept')
    expect(handle(input(listing), {}, allow, NOW + 1).action).toBe('accept') // one token refilled
    for (let i = 0; i < 10; i++) expect(handle(input(listing, 'Stream', 'wss://nos.lol'), {}, allow, NOW).action).toBe('accept')
  })

  test('limits an IPv6 client by its /64, the part of its address it cannot choose', () => {
    expect(rateKey('IP6', '2001:db8:1:2:aaaa::1')).toBe('2001:0db8:0001:0002::/64')
    expect(rateKey('IP6', '2001:DB8:1:2:BBBB:CCCC:DDDD:EEEE')).toBe('2001:0db8:0001:0002::/64')
    expect(rateKey('IP6', '2001:db8::')).toBe('2001:0db8:0000:0000::/64')
    expect(rateKey('IP6', '::1')).toBe('0000:0000:0000:0000::/64')
    expect(rateKey('IP6', '::ffff:198.51.100.1')).toBe('198.51.100.1')
    expect(rateKey('IP6', 'not an address')).toBe('not an address')
    expect(rateKey('IP4', '198.51.100.1')).toBe('198.51.100.1')
    const allow = createRateLimiter(60, 1)
    expect(handle(input(listing, 'IP6', '2001:db8:1:2::1'), {}, allow, NOW).action).toBe('accept')
    expect(handle(input(listing, 'IP6', '2001:db8:1:2:ffff::9'), {}, allow, NOW)).toEqual({ id: listing.id, action: 'reject', msg: 'rate-limited: slow down' })
    expect(handle(input(listing, 'IP6', '2001:db8:1:3::1'), {}, allow, NOW).action).toBe('accept')
  })

  test('reads its options from the environment and ignores malformed keys', () => {
    expect(optionsFromEnv({ FMD_FLEX_RECIPIENT: PK.toUpperCase(), FMD_VERIFIERS: `${OTHER}, nope`, FMD_ACCEPT_GIFT_WRAPS: '1' }))
      .toEqual({ flexRecipient: PK, verifiers: [OTHER], acceptGiftWraps: true })
    expect(optionsFromEnv({ FMD_FLEX_RECIPIENT: 'npub1whatever' })).toEqual({ flexRecipient: undefined, verifiers: [], acceptGiftWraps: false })
  })
})
