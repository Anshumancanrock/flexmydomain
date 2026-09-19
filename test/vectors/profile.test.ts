/**
 * NIP-39 identities, NIP-89 handlers and NIP-51 lists.
 *
 * The arbiter intersection is the part with consequences: an empty result must
 * mean "no trade", and a client that substitutes a default there picks the
 * arbiter for both parties.
 */

import { test, expect, describe } from 'bun:test'
import { bytesToHex } from '@noble/hashes/utils.js'
import { schnorr } from '@noble/curves/secp256k1.js'

import {
  ARBITER_SET_D,
  FOLLOW_SET_KIND,
  HANDLER_KIND,
  arbiterIntersection,
  buildArbiterSet,
  buildHandlerAdvertisement,
  buildWatchlist,
  identityProofUrl,
  parseArbiterSet,
  parseProfile,
  parseWatchlist,
  profileFilter,
  signEvent,
} from '../../core/nostr/index.ts'

const AUX = new Uint8Array(32)
const key = (fill: number) => {
  const sk = new Uint8Array(32).fill(fill)
  return { sk, pk: bytesToHex(schnorr.getPublicKey(sk)) }
}
const ALICE = key(0x11)
const A1 = key(0x21).pk
const A2 = key(0x22).pk
const A3 = key(0x23).pk
const NOW = 1789430400

describe('kind 0 and NIP-39', () => {
  const profile = signEvent(
    {
      pubkey: ALICE.pk,
      created_at: NOW,
      kind: 0,
      tags: [
        ['i', 'github:alice', 'abc123'],
        ['i', 'twitter:alice', '999'],
        ['i', 'malformed'],
      ],
      content: JSON.stringify({ name: 'alice', nip05: '_@alice.example', lud16: 'alice@wallet.example' }),
    },
    ALICE.sk,
    AUX,
  )

  test('it reads the fields and the identities', () => {
    const parsed = parseProfile(profile)
    expect(parsed?.name).toBe('alice')
    expect(parsed?.nip05).toBe('_@alice.example')
    expect(parsed?.identities).toEqual([
      { platform: 'github', identity: 'alice', proof: 'abc123' },
      { platform: 'twitter', identity: 'alice', proof: '999' },
    ])
  })

  test('unparseable content still identifies the key and its tags', () => {
    const broken = signEvent({ ...profile, content: 'not json' }, ALICE.sk, AUX)
    const parsed = parseProfile(broken)
    expect(parsed?.pubkey).toBe(ALICE.pk)
    expect(parsed?.identities).toHaveLength(2)
    expect(parsed?.name).toBeUndefined()
  })

  test('a proof URL is for a person to open; nothing here claims verification', () => {
    expect(identityProofUrl({ platform: 'github', identity: 'alice', proof: 'abc' }))
      .toBe('https://gist.github.com/alice/abc')
    expect(identityProofUrl({ platform: 'unknown', identity: 'x', proof: 'y' })).toBeUndefined()
    expect(identityProofUrl({ platform: 'github', identity: 'alice' })).toBeUndefined()
  })
})

describe('NIP-89 handler advertisement', () => {
  test('it advertises which kinds this client opens', () => {
    const e = buildHandlerAdvertisement({
      pubkey: ALICE.pk,
      webUrl: 'https://example.com/market.html?a=<bech32>',
      name: 'flexmydomain',
      about: 'domain listings',
      createdAt: NOW,
    })
    expect(e.kind).toBe(HANDLER_KIND)
    expect(e.tags).toContainEqual(['k', '30402'])
    expect(e.tags.some((t) => t[0] === 'web')).toBe(true)
    expect(JSON.parse(e.content).name).toBe('flexmydomain')
  })
})

describe('NIP-51 arbiter sets', () => {
  const setOf = (arbiters: string[]) =>
    signEvent(buildArbiterSet({ pubkey: ALICE.pk, arbiters, createdAt: NOW }), ALICE.sk, AUX)

  test('it round-trips', () => {
    const e = setOf([A1, A2])
    expect(e.kind).toBe(FOLLOW_SET_KIND)
    expect(parseArbiterSet(e)).toEqual([A1, A2])
  })

  test('an empty published list differs from no list', () => {
    // "I will trade with no arbiter at all", which is distinguishable from
    // "no list".
    expect(parseArbiterSet(setOf([]))).toEqual([])
    expect(parseArbiterSet(signEvent({ ...setOf([]), kind: 1 }, ALICE.sk, AUX))).toBeUndefined()
  })

  test('a non-pubkey arbiter is refused at build time', () => {
    expect(() => buildArbiterSet({ pubkey: ALICE.pk, arbiters: ['nope'], createdAt: NOW })).toThrow()
  })

  test('the intersection is what both accept', () => {
    expect(arbiterIntersection([A1, A2], [A2, A3]).arbiters).toEqual([A2])
  })

  test('no overlap means no trade, never a default', () => {
    const result = arbiterIntersection([A1], [A2])
    expect(result.arbiters).toEqual([])
    expect(result.noArbiterPossible).toBe(false) // both wanted one, and disagreed
  })

  test('both publishing empty lists means they agree on no arbiter', () => {
    expect(arbiterIntersection([], [])).toEqual({ arbiters: [], noArbiterPossible: true })
  })

  test('a party who published no list has expressed no constraint', () => {
    expect(arbiterIntersection(undefined, [A1, A2]).arbiters).toEqual([A1, A2])
    expect(arbiterIntersection([A1], undefined).arbiters).toEqual([A1])
    expect(arbiterIntersection(undefined, undefined).noArbiterPossible).toBe(true)
  })
})

describe('NIP-51 watchlist', () => {
  test('it round-trips and stays readable by any client', () => {
    const e = signEvent(
      buildWatchlist({ pubkey: ALICE.pk, domains: ['lumenary.com', 'zeta.io'], createdAt: NOW }),
      ALICE.sk,
      AUX,
    )
    expect(parseWatchlist(e)).toEqual(['lumenary.com', 'zeta.io'])
    expect(parseArbiterSet(e)).toBeUndefined() // different d, different list
  })
})

test('the profile filter fetches the kind 0 and the lists together', () => {
  expect(profileFilter([ALICE.pk])).toEqual([
    { kinds: [0], authors: [ALICE.pk] },
    { kinds: [30000], authors: [ALICE.pk], '#d': [ARBITER_SET_D, 'fmd:watchlist'] },
  ])
})
