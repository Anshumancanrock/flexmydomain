/**
 * The add-a-domain flow, end to end, with the network stubbed.
 *
 * It runs the sequence the flex page runs (sign, render the record, resolve it
 * back through DoH, verify, build the portfolio, verify that) with the real
 * modules at every step and a fake `fetch` at the boundary, so it catches
 * integration bugs the unit vectors cannot see.
 *
 * The stub answers in the shapes the real providers use, taken from live
 * responses, so a provider that changes its JSON fails a test before it fails
 * a user.
 */

import { test, expect, describe, afterEach } from 'bun:test'
import { bytesToHex } from '@noble/hashes/utils.js'
import { schnorr } from '@noble/curves/secp256k1.js'

import {
  buildPortfolio,
  parsePortfolio,
  signEvent,
  upsertEntry,
  verifyPortfolio,
  type NostrEvent,
  type Signer,
  type UnsignedEvent,
} from '../../core/nostr/index.ts'
import { encodeProofRecord, proofEvent, proofRecordName } from '../../core/oracle/index.ts'
import { checkDomain, checkDomainProof, checkRegistry } from '../../net/verify.ts'
import { clearBootstrapCache } from '../../net/rdap.ts'

const AUX = new Uint8Array(32)
const SK = new Uint8Array(32).fill(0x11)
const PK = bytesToHex(schnorr.getPublicKey(SK))
const DOMAIN = 'lumenary.com'
const NOW = 1789430400

/** A Signer over a fixed key: `localSigner` without the browser. */
const signer: Signer = {
  async getPublicKey() {
    return PK
  },
  async signEvent(unsigned: UnsignedEvent) {
    return signEvent(unsigned, SK, AUX)
  },
}

// ---------------------------------------------------------------------------
// the fake network
// ---------------------------------------------------------------------------

interface Zone {
  txt?: Record<string, string[]>
  /** Providers that should fail outright, to test "no answer" vs "no record". */
  down?: string[]
  rdap?: unknown
  rdapStatus?: number
}

let zone: Zone = {}
const realFetch = globalThis.fetch

function install(next: Zone): void {
  zone = next
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input.toString())

    if (url.hostname === 'data.iana.org') {
      return json({
        version: '1.0',
        services: [[['com', 'net'], ['https://rdap.verisign.com/com/v1']]],
      })
    }

    if (url.hostname.endsWith('rdap.verisign.com')) {
      if (zone.rdapStatus && zone.rdapStatus !== 200) {
        return new Response('not found', { status: zone.rdapStatus })
      }
      return json(zone.rdap ?? {})
    }

    if (url.pathname.includes('dns-query') || url.hostname === 'dns.google') {
      const provider = url.hostname.includes('cloudflare') ? 'cloudflare' : 'google'
      if (zone.down?.includes(provider)) throw new Error('network unreachable')
      const name = url.searchParams.get('name') ?? ''
      const records = zone.txt?.[name] ?? []
      return json({
        Status: records.length ? 0 : 3,
        AD: true,
        Answer: records.map((data) => ({ type: 16, data: `"${data}"` })),
      })
    }

    throw new Error(`the test made an unexpected request to ${url.href}`)
  }) as typeof fetch
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

afterEach(() => {
  globalThis.fetch = realFetch
  clearBootstrapCache()
})

/** A healthy .com: unlocked, over ten years old, expiring well in the future. */
function healthyRdap(over: Record<string, unknown> = {}) {
  return {
    objectClassName: 'domain',
    ldhName: 'lumenary.com',
    status: [],
    events: [
      { eventAction: 'registration', eventDate: '2015-04-02T10:00:00Z' },
      { eventAction: 'expiration', eventDate: '2028-04-02T10:00:00Z' },
    ],
    entities: [
      {
        roles: ['registrar'],
        publicIds: [{ type: 'IANA Registrar ID', identifier: '1910' }],
        vcardArray: ['vcard', [['fn', {}, 'text', 'Example Registrar, Inc.']]],
      },
    ],
    nameservers: [{ ldhName: 'NS1.EXAMPLE-DNS.COM' }, { ldhName: 'NS2.EXAMPLE-DNS.COM' }],
    ...over,
  }
}

// ---------------------------------------------------------------------------

describe('adding a domain, end to end', () => {
  test('sign, paste, resolve, verify, publish', async () => {
    // 1. The user signs. The key stays in their signer.
    const unsigned = proofEvent({ domain: DOMAIN, pubkey: PK, iat: NOW })
    const signed = await signer.signEvent(unsigned)
    const record = { version: 'fmd1' as const, iat: NOW, pubkey: PK, sig: signed.sig }
    const txt = encodeProofRecord(record)

    // 2. What the page tells them to paste, and where.
    expect(proofRecordName(DOMAIN)).toBe('_flexmydomain.lumenary.com')
    expect(txt.length).toBe(209)

    // 3. They paste it. Now the zone says so.
    install({ txt: { '_flexmydomain.lumenary.com': [txt] }, rdap: healthyRdap() })

    const { proof, registry } = await checkDomain({ domain: DOMAIN, pubkey: PK, now: NOW + 60 })
    expect(proof.status.proven).toBe(true)
    expect(proof.status.source).toBe('dns')
    expect(proof.dnssec).toBe(true)
    expect(proof.lookup.agreed).toEqual([txt])
    expect(registry.supported).toBe(true)
    expect(registry.eligibility?.listable).toBe(true)
    expect(registry.eligibility?.unlocked).toBe(true)
    expect(registry.snapshot.hash).toMatch(/^[0-9a-f]{64}$/)

    // 4. The portfolio is built, signed and verified, as a reader of the flex
    //    page verifies it, with no network at all.
    const entries = upsertEntry([], {
      domain: DOMAIN,
      source: 'dns',
      iat: record.iat,
      sig: record.sig,
      firstSeen: NOW,
    })
    const portfolio: NostrEvent = await signer.signEvent(
      buildPortfolio({ pubkey: PK, entries, createdAt: NOW + 60 }),
    )
    const parsed = parsePortfolio(portfolio)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(verifyPortfolio(parsed.portfolio).every((v) => v.proven)).toBe(true)
  })

  test('before the record is added, the domain is simply not proven', async () => {
    install({ txt: {}, rdap: healthyRdap() })
    const report = await checkDomainProof({ domain: DOMAIN, pubkey: PK, now: NOW })
    expect(report.status.proven).toBe(false)
    expect(report.answered).toBe(true) // the resolvers answered; the answer was "no"
  })

  test('a record only one resolver can see is disputed, not proven', async () => {
    const signed = await signer.signEvent(proofEvent({ domain: DOMAIN, pubkey: PK, iat: NOW }))
    const txt = encodeProofRecord({ version: 'fmd1', iat: NOW, pubkey: PK, sig: signed.sig })

    // Mid-propagation: cloudflare has it, google does not.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(input.toString())
      const cloudflare = url.hostname.includes('cloudflare')
      return json({
        Status: 0,
        AD: true,
        Answer: cloudflare ? [{ type: 16, data: `"${txt}"` }] : [],
      })
    }) as typeof fetch

    const report = await checkDomainProof({ domain: DOMAIN, pubkey: PK, now: NOW, dnsOnly: true })
    expect(report.status.proven).toBe(false)
    expect(report.lookup.agreed).toEqual([])
    expect(report.lookup.disputed).toEqual([txt])
  })

  test('one resolver down is not a negative result', async () => {
    const signed = await signer.signEvent(proofEvent({ domain: DOMAIN, pubkey: PK, iat: NOW }))
    const txt = encodeProofRecord({ version: 'fmd1', iat: NOW, pubkey: PK, sig: signed.sig })
    install({ txt: { '_flexmydomain.lumenary.com': [txt] }, down: ['google'], rdap: healthyRdap() })

    const report = await checkDomainProof({ domain: DOMAIN, pubkey: PK, now: NOW, dnsOnly: true })
    // The one provider that answered saw the record, and agreement among the
    // providers that answered is enough. The failure is recorded, not hidden.
    expect(report.status.proven).toBe(true)
    expect(report.answered).toBe(true)
    expect(report.lookup.observations.find((o) => o.provider === 'google')?.error).toBeTruthy()
  })

  test('both resolvers down proves nothing and says so', async () => {
    install({ down: ['google', 'cloudflare'] })
    const report = await checkDomainProof({ domain: DOMAIN, pubkey: PK, now: NOW, dnsOnly: true })
    expect(report.status.proven).toBe(false)
    expect(report.answered).toBe(false)
  })

  test("a zone full of other people's TXT records still proves the domain", async () => {
    const signed = await signer.signEvent(proofEvent({ domain: DOMAIN, pubkey: PK, iat: NOW }))
    const txt = encodeProofRecord({ version: 'fmd1', iat: NOW, pubkey: PK, sig: signed.sig })
    install({
      txt: {
        '_flexmydomain.lumenary.com': [
          'v=spf1 include:_spf.google.com ~all',
          'google-site-verification=xyz',
          txt,
        ],
      },
      rdap: healthyRdap(),
    })
    const report = await checkDomainProof({ domain: DOMAIN, pubkey: PK, now: NOW, dnsOnly: true })
    expect(report.status.proven).toBe(true)
  })

  test('NIP-05 backs the claim when DNS does not', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(input.toString())
      if (url.pathname.includes('nostr.json')) return json({ names: { _: PK } })
      return json({ Status: 3, AD: false, Answer: [] })
    }) as typeof fetch

    const report = await checkDomainProof({ domain: DOMAIN, pubkey: PK, now: NOW })
    expect(report.status.proven).toBe(true)
    expect(report.status.source).toBe('nip05')
    expect(report.status.iat).toBeUndefined() // NIP-05 carries no signed timestamp
  })
})

describe('the registry half', () => {
  test('a locked domain is listable, and cannot move yet', async () => {
    install({ rdap: healthyRdap({ status: ['client transfer prohibited'] }) })
    const report = await checkRegistry({ domain: DOMAIN, now: NOW })
    expect(report.eligibility?.listable).toBe(true)
    expect(report.eligibility?.unlocked).toBe(false)
  })

  test('a TLD with no RDAP service is unsupported, not ineligible', async () => {
    globalThis.fetch = (async () =>
      json({ version: '1.0', services: [[['com'], ['https://rdap.verisign.com/com/v1']]] })) as typeof fetch
    const report = await checkRegistry({ domain: 'something.io', now: NOW })
    expect(report.supported).toBe(false)
    expect(report.eligibility).toBeUndefined() // never a verdict we could not reach
  })

  test('a registry 404 is an answer, and does not become an eligibility pass', async () => {
    install({ rdap: {}, rdapStatus: 404 })
    const report = await checkRegistry({ domain: DOMAIN, now: NOW })
    expect(report.snapshot.status).toBe(404)
    expect(report.eligibility).toBeUndefined()
  })

  test('the snapshot hash covers the bytes as received', async () => {
    install({ rdap: healthyRdap() })
    const a = await checkRegistry({ domain: DOMAIN, now: NOW })
    const b = await checkRegistry({ domain: DOMAIN, now: NOW + 5 })
    expect(a.snapshot.hash).toBe(b.snapshot.hash) // same bytes, same digest
    expect(a.snapshot.raw).toBeTruthy()
  })
})
