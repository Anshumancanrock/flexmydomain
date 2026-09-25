// core/oracle vectors (spec/PROOF.md section 8). Ports must match exactly, and the spec settles any
// disagreement. The normalised domain is signed, so a one-character mismatch fails with no diagnostic.

import { test, expect, describe } from 'bun:test'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { schnorr } from '@noble/curves/secp256k1.js'

import {
  checkEligibility,
  combineProofs,
  decodeLabel,
  encodeLabel,
  encodeProofRecord,
  fingerprintMatches,
  fingerprintOf,
  foldStatus,
  isNormalisedDomain,
  namesForPubkey,
  normaliseDomain,
  parseNip05Identifier,
  parseProofRecord,
  parseRdapDomain,
  PROOF_D_PREFIX,
  PROOF_KIND,
  proofDTag,
  proofDigestHex,
  proofEvent,
  proofFromEvent,
  proofMessage,
  proofRecordName,
  rdapBaseUrls,
  rdapDomainUrl,
  relayHints,
  snapshotHash,
  splitDomain,
  tldHasRdap,
  tldOf,
  toASCII,
  toUnicode,
  tryNormaliseDomain,
  verifyNip05,
  verifyProofRecord,
  verifyProofRecords,
  type ProofRecord,
} from '../../core/oracle/index.ts'

import { checkEvent, eventId, signEvent, type NostrEvent } from '../../core/nostr/event.ts'

/** Zero aux randomness, so signatures are reproducible. */
const AUX = new Uint8Array(32)

function key(fill: number) {
  const sk = new Uint8Array(32).fill(fill)
  return { sk, pk: bytesToHex(schnorr.getPublicKey(sk)) }
}

const SELLER = key(0x11)
const STRANGER = key(0x22)

/** 2026-09-15T00:00:00Z. */
const IAT = 1789430400
const NOW = IAT + 3600

const DOMAIN = 'lumenary.com'

function makeProof(
  opts: { domain?: string; iat?: number; signer?: typeof SELLER } = {},
): { record: ProofRecord; txt: string; event: NostrEvent } {
  const domain = opts.domain ?? DOMAIN
  const iat = opts.iat ?? IAT
  const signer = opts.signer ?? SELLER
  const event = signEvent(proofEvent({ domain, pubkey: signer.pk, iat }), signer.sk, AUX)
  const record: ProofRecord = { version: 'fmd1', iat, pubkey: signer.pk, sig: event.sig }
  return { record, txt: encodeProofRecord(record), event }
}

describe('punycode', () => {
  // Cross-checked against the host's IDNA (`new URL`), a second RFC 3492 implementation.
  const VECTORS: [string, string][] = [
    ['bücher.de', 'xn--bcher-kva.de'],
    ['münchen.de', 'xn--mnchen-3ya.de'],
    ['españa.com', 'xn--espaa-rta.com'],
    ['日本語.jp', 'xn--wgv71a119e.jp'],
    ['ñ.com', 'xn--ida.com'],
    ['χ.gr', 'xn--8xa.gr'],
    ['faß.de', 'xn--fa-hia.de'],
  ]

  for (const [unicode, ascii] of VECTORS) {
    test(`${unicode} encodes to ${ascii}`, () => {
      expect(toASCII(unicode)).toBe(ascii)
      expect(new URL(`https://${unicode}`).hostname).toBe(ascii)
    })
  }

  test('an ASCII name passes through untouched', () => {
    expect(toASCII('lumenary.com')).toBe('lumenary.com')
  })

  test('decode inverts encode for every vector', () => {
    for (const [unicode, ascii] of VECTORS) {
      expect(toUnicode(ascii)).toBe(unicode)
    }
  })

  test('encode and decode round-trip arbitrary labels', () => {
    const samples = ['müller', '日本', 'ᚠᚢᚦ', 'a1-ü', 'ü', 'straße', '🙂a']
    for (const s of samples) {
      expect(decodeLabel(encodeLabel(s))).toBe(s)
    }
  })

  test('an A-label that decodes to pure ASCII is rejected', () => {
    // `xn--a-` decodes to "a". Two spellings of one domain would mean two signed messages
    // for one claim.
    expect(() => toASCII('xn--a-.com')).toThrow()
    expect(toASCII('a.com')).toBe('a.com')
  })

  test('a bare ACE prefix is not a label', () => {
    expect(() => toASCII('xn--.com')).toThrow()
  })

  test('a decoded surrogate half is refused', () => {
    expect(() => decodeLabel('ib9b')).toThrow() // U+D800, not a code point.
    expect(decodeLabel('ls8h')).toBe('\u{1f4a9}') // Astral plane is fine.
  })
})

// Normalisation, spec/PROOF.md section 4.
describe('normaliseDomain', () => {
  const TABLE: [string, string][] = [
    ['lumenary.com', 'lumenary.com'],
    ['  Lumenary.COM  ', 'lumenary.com'],
    ['lumenary.com.', 'lumenary.com'],
    ['www.lumenary.com', 'lumenary.com'],
    ['WWW.Lumenary.Com.', 'lumenary.com'],
    ['https://www.MyShop.io/pricing?x=1', 'myshop.io'],
    ['http://user:pw@shop.example.org:8443/a/b#c', 'shop.example.org'],
    ['MÜNCHEN.de', 'xn--mnchen-3ya.de'],
    ['a.b.c.example.com', 'a.b.c.example.com'],
    ['www.www.example.com', 'example.com'],
    ['xn--mnchen-3ya.de', 'xn--mnchen-3ya.de'],
    ['//cdn.example.net/path', 'cdn.example.net'],
  ]

  for (const [input, expected] of TABLE) {
    test(`${JSON.stringify(input)} -> ${expected}`, () => {
      expect(normaliseDomain(input)).toBe(expected)
    })
  }

  test('normalisation is idempotent across the whole table', () => {
    for (const [, expected] of TABLE) {
      expect(normaliseDomain(expected)).toBe(expected)
      expect(isNormalisedDomain(expected)).toBe(true)
    }
  })

  const REJECTED: [string, string][] = [
    ['', 'empty'],
    ['   ', 'empty'],
    ['com', 'single label'],
    ['my shop.io', 'whitespace'],
    ['exa..mple.com', 'empty label'],
    ['-bad.com', 'valid hostname label'],
    ['bad-.com', 'valid hostname label'],
    ['under_score.com', 'valid hostname label'],
    ['example.c', 'top-level domain'],
    ['example.123', 'top-level domain'],
    ['[2001:db8::1]', 'IPv6'],
    ['пример.рф', 'top-level domain'], // xn--p1ai, a known limit of spec section 4.
  ]

  for (const [input, fragment] of REJECTED) {
    test(`${JSON.stringify(input)} is rejected (${fragment})`, () => {
      const r = tryNormaliseDomain(input)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain(fragment)
      expect(() => normaliseDomain(input)).toThrow()
    })
  }

  test('www is not stripped down to a bare TLD', () => {
    expect(normaliseDomain('www.com')).toBe('www.com')
  })

  test('a 64-character label is refused, a 63-character one is not', () => {
    expect(() => normaliseDomain(`${'a'.repeat(64)}.com`)).toThrow()
    expect(normaliseDomain(`${'a'.repeat(63)}.com`)).toBe(`${'a'.repeat(63)}.com`)
  })

  test('254 characters is refused, 253 is not', () => {
    const label = 'a'.repeat(49)
    const ok = `${Array.from({ length: 5 }, () => label).join('.')}.com`
    expect(ok.length).toBe(253)
    expect(normaliseDomain(ok)).toBe(ok)

    const long = `b.${ok}`
    expect(long.length).toBeGreaterThan(253)
    expect(() => normaliseDomain(long)).toThrow()
  })

  test('tldOf and splitDomain read the last label', () => {
    expect(tldOf('a.b.example.co')).toBe('co')
    expect(splitDomain('shop.example.com')).toEqual(['shop.example', 'com'])
  })

  test('the record name carries its underscore label', () => {
    expect(proofRecordName('WWW.Lumenary.com')).toBe('_flexmydomain.lumenary.com')
  })
})

// spec/PROOF.md sections 1 to 3.
describe('proof record', () => {
  test('the signed message is the spec string', () => {
    expect(proofMessage('WWW.Lumenary.COM', IAT)).toBe(`flexmydomain:v1:lumenary.com:${IAT}`)
  })

  test('the canonical event is reconstructible from the record alone', () => {
    const e = proofEvent({ domain: DOMAIN, pubkey: SELLER.pk, iat: IAT })
    expect(e.kind).toBe(PROOF_KIND)
    expect(e.created_at).toBe(IAT)
    expect(e.tags).toEqual([['d', `${PROOF_D_PREFIX}${DOMAIN}`]])
    expect(e.content).toBe(proofMessage(DOMAIN, IAT))
    expect(proofDTag(DOMAIN)).toBe('fmd:proof:lumenary.com')
    // Every field follows from (domain, pubkey, iat), so the digest can be an event id.
    expect(proofDigestHex({ domain: DOMAIN, pubkey: SELLER.pk, iat: IAT })).toBe(eventId(e))
  })

  test('the record is one token of 209 characters', () => {
    const { txt } = makeProof()
    expect(txt.length).toBe(209)
    expect(txt).toMatch(/^fmd1\.\d+\.[0-9a-f]{64}\.[0-9a-f]{128}$/)
    expect(txt).not.toContain(' ')
  })

  test('a fresh record verifies', () => {
    const { txt } = makeProof()
    const v = verifyProofRecord({ domain: DOMAIN, pubkey: SELLER.pk, record: txt, now: NOW })
    expect(v.ok).toBe(true)
    expect(v.ageSeconds).toBe(3600)
  })

  test('the same proof verifies as a published event', () => {
    const { event } = makeProof()
    expect(checkEvent(event).ok).toBe(true)
    const r = proofFromEvent(event)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.domain).toBe(DOMAIN)
      // The TXT value and the relay copy carry the same 64-byte signature.
      expect(encodeProofRecord(r.record)).toBe(makeProof().txt)
    }
  })

  describe('rejections', () => {
    test('a record copied to another zone does not verify', () => {
      const { txt } = makeProof()
      const v = verifyProofRecord({ domain: 'otherbrand.com', pubkey: SELLER.pk, record: txt, now: NOW })
      expect(v.ok).toBe(false)
      expect(v.reason).toContain('signature')
    })

    test('a record does not verify for a key that did not sign it', () => {
      const { txt } = makeProof()
      const v = verifyProofRecord({ domain: DOMAIN, pubkey: STRANGER.pk, record: txt, now: NOW })
      expect(v.ok).toBe(false)
      expect(v.reason).toContain('different pubkey')
    })

    test('editing iat invalidates the signature', () => {
      const { record } = makeProof()
      const tampered = encodeProofRecord({ ...record, iat: record.iat + 1 })
      const v = verifyProofRecord({ domain: DOMAIN, pubkey: SELLER.pk, record: tampered, now: NOW })
      expect(v.ok).toBe(false)
      expect(v.reason).toContain('signature')
    })

    test('flipping one bit of the signature invalidates it', () => {
      const { record } = makeProof()
      const bytes = hexToBytes(record.sig)
      bytes[40] ^= 0x01
      const v = verifyProofRecord({
        domain: DOMAIN,
        pubkey: SELLER.pk,
        record: { ...record, sig: bytesToHex(bytes) },
        now: NOW,
      })
      expect(v.ok).toBe(false)
    })

    test('a record dated in the future beyond the skew guard is refused', () => {
      const future = makeProof({ iat: NOW + 600 })
      const v = verifyProofRecord({ domain: DOMAIN, pubkey: SELLER.pk, record: future.txt, now: NOW })
      expect(v.ok).toBe(false)
      expect(v.reason).toContain('future')
    })

    test('a record inside the skew guard is accepted', () => {
      const future = makeProof({ iat: NOW + 120 })
      expect(verifyProofRecord({ domain: DOMAIN, pubkey: SELLER.pk, record: future.txt, now: NOW }).ok).toBe(true)
    })

    test('age alone never invalidates a proof', () => {
      const old = makeProof({ iat: IAT - 400 * 86400 })
      const v = verifyProofRecord({ domain: DOMAIN, pubkey: SELLER.pk, record: old.txt, now: NOW })
      expect(v.ok).toBe(true)
      expect(v.ageSeconds).toBeGreaterThan(400 * 86400)
    })

    test('an event whose content was rewritten does not pass proofFromEvent', () => {
      const { event } = makeProof()
      const r = proofFromEvent({ ...event, content: proofMessage('otherbrand.com', IAT) })
      expect(r.ok).toBe(false)
    })

    test('an event claiming a domain its content does not name is refused', () => {
      const { event } = makeProof()
      const r = proofFromEvent({ ...event, tags: [['d', `${PROOF_D_PREFIX}otherbrand.com`]] })
      expect(r.ok).toBe(false)
    })

    test('a d tag that is not normalised is refused', () => {
      const { event } = makeProof()
      expect(proofFromEvent({ ...event, tags: [['d', `${PROOF_D_PREFIX}LUMENARY.com`]] }).ok).toBe(false)
    })

    test('a proof-shaped event of the wrong kind is refused', () => {
      const { event } = makeProof()
      expect(proofFromEvent({ ...event, kind: 1 }).ok).toBe(false)
    })
  })

  describe('parsing is liberal, spec section 1', () => {
    const { record, txt } = makeProof()
    const ACCEPTED = [
      txt,
      `  ${txt}  `,
      `"${txt}"`,
      `fmd1 ${record.iat} ${record.pubkey} ${record.sig}`,
      `"fmd1" "${record.iat}" "${record.pubkey}" "${record.sig}"`,
      txt.toUpperCase(),
    ]
    for (const [i, value] of ACCEPTED.entries()) {
      test(`form ${i} parses to the same record`, () => {
        const p = parseProofRecord(value)
        expect(p.ok).toBe(true)
        if (p.ok) expect(p.record).toEqual(record)
      })
    }

    const REFUSED: [unknown, string][] = [
      ['', 'empty'],
      [null, 'not a string'],
      [`fmd2.${record.iat}.${record.pubkey}.${record.sig}`, 'unknown version'],
      [`fmd1.${record.pubkey}.${record.sig}`, 'expected 4 fields'],
      [`fmd1.now.${record.pubkey}.${record.sig}`, 'not decimal'],
      [`fmd1.${record.iat}.zz.${record.sig}`, 'pubkey'],
      [`fmd1.${record.iat}.${record.pubkey}.beef`, 'sig'],
      ['v=spf1 include:example.com ~all', 'version'],
    ]
    for (const [value, fragment] of REFUSED) {
      test(`${JSON.stringify(value)} is refused (${fragment})`, () => {
        const p = parseProofRecord(value)
        expect(p.ok).toBe(false)
        if (!p.ok) expect(p.reason).toContain(fragment)
      })
    }
  })

  describe('an RRset, which is what a zone holds', () => {
    test('one good record among junk still proves the domain', () => {
      const { txt } = makeProof()
      const result = verifyProofRecords({
        domain: DOMAIN,
        pubkey: SELLER.pk,
        now: NOW,
        records: [
          'v=spf1 -all',
          'google-site-verification=abc123',
          makeProof({ signer: STRANGER }).txt, // Previous owner's proof.
          txt,
        ],
      })
      expect(result.ok).toBe(true)
      expect(result.checked).toBe(4)
      expect(result.rejected).toHaveLength(3)
    })

    test('the newest verifying record wins', () => {
      const older = makeProof({ iat: IAT - 86400 })
      const newer = makeProof({ iat: IAT })
      const result = verifyProofRecords({
        domain: DOMAIN,
        pubkey: SELLER.pk,
        now: NOW,
        records: [newer.txt, older.txt],
      })
      expect(result.ok).toBe(true)
      expect(result.record?.iat).toBe(IAT)
    })

    test('an empty zone is a negative result, not a crash', () => {
      const result = verifyProofRecords({ domain: DOMAIN, pubkey: SELLER.pk, records: [], now: NOW })
      expect(result.ok).toBe(false)
      expect(result.reason).toContain('no records')
    })
  })
})

describe('NIP-05', () => {
  const doc = {
    names: { _: SELLER.pk, alice: SELLER.pk, bob: STRANGER.pk },
    relays: { [SELLER.pk]: ['wss://relay.damus.io', 'http://not-a-relay'] },
  }

  test('any name mapping to the key proves control', () => {
    const v = verifyNip05({ domain: DOMAIN, pubkey: SELLER.pk, document: doc })
    expect(v.ok).toBe(true)
    expect(v.names).toEqual(['_', 'alice'])
    expect(v.identifier).toBe(DOMAIN) // `_` renders as the bare domain.
  })

  test('a document that never mentions the key proves nothing', () => {
    const v = verifyNip05({ domain: DOMAIN, pubkey: STRANGER.pk, document: { names: { x: SELLER.pk } } })
    expect(v.ok).toBe(false)
  })

  test('a malformed document returns a reason instead of throwing', () => {
    expect(verifyNip05({ domain: DOMAIN, pubkey: SELLER.pk, document: null }).ok).toBe(false)
    expect(verifyNip05({ domain: DOMAIN, pubkey: SELLER.pk, document: '{}' }).ok).toBe(false)
    expect(namesForPubkey(doc, 'nothex')).toEqual([])
  })

  test('relay hints are filtered to websocket URLs', () => {
    expect(relayHints(doc, SELLER.pk)).toEqual(['wss://relay.damus.io'])
  })

  test('identifiers split both ways', () => {
    expect(parseNip05Identifier('Alice@Lumenary.com')).toMatchObject({ name: 'alice', domain: DOMAIN })
    expect(parseNip05Identifier('lumenary.com')).toMatchObject({ name: '_', domain: DOMAIN })
    expect(parseNip05Identifier('a b@x.com').ok).toBe(false)
  })
})

describe('combineProofs', () => {
  const dnsOk = verifyProofRecord({ domain: DOMAIN, pubkey: SELLER.pk, record: makeProof().txt, now: NOW })
  const nip05Ok = verifyNip05({ domain: DOMAIN, pubkey: SELLER.pk, document: { names: { _: SELLER.pk } } })

  test('DNS wins, and carries the signed timestamp', () => {
    const s = combineProofs({ domain: DOMAIN, pubkey: SELLER.pk, dns: dnsOk, nip05: nip05Ok })
    expect(s).toMatchObject({ proven: true, source: 'dns', iat: IAT })
  })

  test('NIP-05 alone proves the domain, and says so', () => {
    const s = combineProofs({ domain: DOMAIN, pubkey: SELLER.pk, nip05: nip05Ok })
    expect(s).toMatchObject({ proven: true, source: 'nip05' })
    expect(s.iat).toBeUndefined()
  })

  test('neither is an unproven domain with a reason attached', () => {
    const s = combineProofs({ domain: DOMAIN, pubkey: SELLER.pk })
    expect(s.proven).toBe(false)
    expect(s.reason).toBeTruthy()
  })
})

const BOOTSTRAP = {
  version: '1.0',
  services: [
    [['com', 'net'], ['https://rdap.verisign.com/com/v1']],
    [['io'], ['https://rdap.identitydigital.services/rdap/']],
    [['uk'], ['https://rdap.nominet.uk/uk/']],
    [['co.uk'], ['https://rdap.nominet.uk/couk/']],
  ],
}

function rdapResponse(over: Record<string, unknown> = {}) {
  return {
    objectClassName: 'domain',
    ldhName: 'LUMENARY.COM',
    status: ['client transfer prohibited'],
    events: [
      { eventAction: 'registration', eventDate: '2015-04-02T10:00:00Z' },
      { eventAction: 'expiration', eventDate: '2027-04-02T10:00:00Z' },
      { eventAction: 'last changed', eventDate: '2026-01-11T10:00:00Z' },
    ],
    entities: [
      {
        objectClassName: 'entity',
        roles: ['registrar'],
        publicIds: [{ type: 'IANA Registrar ID', identifier: 1910 }],
        vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'Example Registrar, Inc.']]],
      },
    ],
    nameservers: [{ ldhName: 'NS2.EXAMPLE-DNS.COM.' }, { ldhName: 'NS1.EXAMPLE-DNS.COM' }],
    ...over,
  }
}

describe('RDAP bootstrap', () => {
  test('a TLD resolves to its base URL, with the trailing slash RFC 7484 wants', () => {
    expect(rdapBaseUrls(BOOTSTRAP, 'lumenary.com')).toEqual(['https://rdap.verisign.com/com/v1/'])
  })

  test('the longest suffix wins', () => {
    expect(rdapBaseUrls(BOOTSTRAP, 'shop.co.uk')).toEqual(['https://rdap.nominet.uk/couk/'])
    expect(rdapBaseUrls(BOOTSTRAP, 'shop.org.uk')).toEqual(['https://rdap.nominet.uk/uk/'])
  })

  test('an unlisted TLD has no service, which is an answer and not an error', () => {
    expect(rdapBaseUrls(BOOTSTRAP, 'something.ai')).toEqual([])
    expect(tldHasRdap(BOOTSTRAP, 'something.ai')).toBe(false)
  })

  test('a malformed bootstrap file yields nothing rather than throwing', () => {
    expect(rdapBaseUrls(null, 'lumenary.com')).toEqual([])
    expect(rdapBaseUrls({ services: 'no' }, 'lumenary.com')).toEqual([])
  })

  test('the query URL is the base plus domain/<name>', () => {
    expect(rdapDomainUrl('https://rdap.verisign.com/com/v1/', 'WWW.Lumenary.com')).toBe(
      'https://rdap.verisign.com/com/v1/domain/lumenary.com',
    )
  })
})

describe('RDAP parsing', () => {
  test('both spellings of a status fold to one', () => {
    expect(foldStatus('client transfer prohibited')).toBe(foldStatus('clientTransferProhibited'))
  })

  test('the facts come out of a real-shaped response', () => {
    const f = parseRdapDomain(rdapResponse())
    expect(f.domain).toBe('lumenary.com')
    expect(f.statuses).toEqual(['clienttransferprohibited'])
    expect(f.registrarName).toBe('Example Registrar, Inc.')
    expect(f.registrarIanaId).toBe('1910')
    expect(f.nameservers).toEqual(['ns1.example-dns.com', 'ns2.example-dns.com'])
    expect(f.registration).toBe(Math.floor(Date.parse('2015-04-02T10:00:00Z') / 1000))
  })

  test('an empty or hostile response parses to empty facts', () => {
    for (const input of [null, undefined, 42, {}, { status: 'locked', events: 'none' }]) {
      const f = parseRdapDomain(input)
      expect(f.statuses).toEqual([])
      expect(f.nameservers).toEqual([])
      expect(f.registration).toBeUndefined()
    }
  })
})

describe('eligibility', () => {
  const NOW_2026 = Math.floor(Date.parse('2026-09-19T00:00:00Z') / 1000)
  const check = (over: Record<string, unknown> = {}, bootstrap: unknown = BOOTSTRAP) =>
    checkEligibility({ domain: 'lumenary.com', response: rdapResponse(over), now: NOW_2026, bootstrap })

  test('a healthy but locked domain is listable, and cannot move yet', () => {
    const e = check()
    expect(e.listable).toBe(true)
    expect(e.unlocked).toBe(false) // clientTransferProhibited is present.
  })

  test('removing the lock lets it move and changes nothing else', () => {
    const e = check({ status: [] })
    expect(e.listable).toBe(true)
    expect(e.unlocked).toBe(true)
  })

  test('a name registered inside the 60-day lock is refused', () => {
    const e = check({ events: [{ eventAction: 'registration', eventDate: '2026-09-01T00:00:00Z' }] })
    expect(e.listable).toBe(false)
    expect(e.findings.map((f) => f.code)).toContain('transfer-lock:registration')
  })

  test('a name transferred inside the 60-day lock is refused', () => {
    const e = check({
      events: [
        { eventAction: 'registration', eventDate: '2015-04-02T10:00:00Z' },
        { eventAction: 'expiration', eventDate: '2027-04-02T10:00:00Z' },
        { eventAction: 'transfer', eventDate: '2026-08-30T00:00:00Z' },
      ],
    })
    expect(e.listable).toBe(false)
    expect(e.findings.map((f) => f.code)).toContain('transfer-lock:transfer')
  })

  test('expiry inside 45 days is refused', () => {
    const e = check({
      events: [
        { eventAction: 'registration', eventDate: '2015-04-02T10:00:00Z' },
        { eventAction: 'expiration', eventDate: '2026-10-01T00:00:00Z' },
      ],
    })
    expect(e.listable).toBe(false)
    expect(e.findings.map((f) => f.code)).toContain('expiring')
  })

  test('each refusing status refuses', () => {
    for (const status of ['pending delete', 'redemptionPeriod', 'server transfer prohibited']) {
      expect(check({ status: [status] }).listable).toBe(false)
    }
  })

  test('a hold warns without blocking the listing', () => {
    const e = check({ status: ['client hold'] })
    expect(e.listable).toBe(true)
    expect(e.findings.some((f) => f.level === 'warn' && f.code === 'status:clienthold')).toBe(true)
  })

  test('a TLD with no RDAP service is refused', () => {
    const e = checkEligibility({
      domain: 'something.ai',
      response: rdapResponse({ ldhName: 'something.ai' }),
      now: NOW_2026,
      bootstrap: BOOTSTRAP,
    })
    expect(e.listable).toBe(false)
    expect(e.findings.map((f) => f.code)).toContain('no-rdap')
  })

  test('omitting the bootstrap file skips the TLD rule', () => {
    const e = checkEligibility({ domain: 'something.ai', response: rdapResponse({ ldhName: 'something.ai' }), now: NOW_2026 })
    expect(e.findings.map((f) => f.code)).not.toContain('no-rdap')
  })

  test('a registry answering about another name is not evidence about this one', () => {
    const e = check({ ldhName: 'someone-else.com' })
    expect(e.listable).toBe(false)
    expect(e.findings.map((f) => f.code)).toContain('domain-mismatch')
  })

  test('pendingTransfer is surfaced as the point of no return', () => {
    expect(check({ status: ['pending transfer'] }).pendingTransfer).toBe(true)
  })

  test('missing dates warn instead of silently passing', () => {
    const e = check({ events: [] })
    const codes = e.findings.map((f) => f.code)
    expect(codes).toContain('no-expiry')
    expect(codes).toContain('no-registration')
    expect(e.listable).toBe(true)
  })
})

describe('the release fingerprint', () => {
  const before = fingerprintOf(parseRdapDomain(rdapResponse()))

  test('a registrar change is a match', () => {
    const after = fingerprintOf(
      parseRdapDomain(
        rdapResponse({
          entities: [
            { roles: ['registrar'], publicIds: [{ type: 'IANA Registrar ID', identifier: '292' }] },
          ],
        }),
      ),
    )
    expect(fingerprintMatches(after, { registrarIanaId: '292', nameservers: [] })).toBe(true)
    expect(fingerprintMatches(before, { registrarIanaId: '292', nameservers: [] })).toBe(false)
  })

  test('a same-registrar push is caught by the nameservers instead', () => {
    const after = fingerprintOf(
      parseRdapDomain(rdapResponse({ nameservers: [{ ldhName: 'ns1.buyer.example' }, { ldhName: 'ns2.buyer.example' }] })),
    )
    // Registrar id unchanged, only the nameservers moved.
    expect(after.registrarIanaId).toBe(before.registrarIanaId)
    expect(fingerprintMatches(after, { registrarIanaId: undefined, nameservers: ['ns1.buyer.example'] })).toBe(true)
    expect(fingerprintMatches(before, { registrarIanaId: undefined, nameservers: ['ns1.buyer.example'] })).toBe(false)
  })

  test('an empty commitment never matches', () => {
    expect(fingerprintMatches(before, { registrarIanaId: undefined, nameservers: [] })).toBe(false)
  })
})

describe('the verifier in spec/PROOF.md', () => {
  /**
   * The verifier printed in spec/PROOF.md, minus comments. People will implement against it,
   * so we run it. Uses only @noble and nothing from this repo, so it's a second implementation.
   */
  function specVerify(value: string, domain: string): boolean {
    const [version, iat, pubkey, sig] = value.split('.')
    if (version !== 'fmd1') return false

    const event = [0, pubkey, Number(iat), 30078, [['d', `fmd:proof:${domain}`]], `flexmydomain:v1:${domain}:${iat}`]
    const id = sha256(utf8ToBytes(JSON.stringify(event)))

    return schnorr.verify(hexToBytes(sig), id, hexToBytes(pubkey))
  }

  test('it verifies a real record', () => {
    expect(specVerify(makeProof().txt, DOMAIN)).toBe(true)
  })

  test('it rejects the same record under another domain', () => {
    expect(specVerify(makeProof().txt, 'otherbrand.com')).toBe(false)
  })

  test('it agrees with core/oracle on every case in this file', () => {
    for (const [domain, signer, iat] of [
      [DOMAIN, SELLER, IAT],
      ['zeta.io', SELLER, IAT - 99],
      [DOMAIN, STRANGER, IAT],
    ] as const) {
      const { txt } = makeProof({ domain, signer, iat })
      const mine = verifyProofRecord({ domain, pubkey: signer.pk, record: txt }).ok
      expect(specVerify(txt, domain)).toBe(mine)
    }
  })
})

describe('snapshotHash', () => {
  test('hashes the bytes as received, so re-serialising changes the digest', () => {
    const raw = '{"objectClassName":"domain","ldhName":"lumenary.com"}'
    const reserialised = JSON.stringify(JSON.parse(raw), null, 2)
    expect(snapshotHash(raw)).toMatch(/^[0-9a-f]{64}$/)
    expect(snapshotHash(reserialised)).not.toBe(snapshotHash(raw))
  })
})
