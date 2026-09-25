// NIP-65 vectors for core/nostr/relays.ts. Backwards routing fails silently. You'd see only the
// listings that happened to land on your own relays, and the UI wouldn't say so.

import { test, expect, describe } from 'bun:test'
import { bytesToHex } from '@noble/hashes/utils.js'
import { schnorr } from '@noble/curves/secp256k1.js'

import {
  READ_FANOUT,
  RELAY_LIST_KIND,
  buildRelayList,
  inboxRelaysFor,
  normaliseRelayUrl,
  parseRelayList,
  planAuthorQuery,
  readRelaysFor,
  relayListFilter,
  signEvent,
  writeRelaysFor,
  type NostrEvent,
  type RelayEntry,
} from '../../core/nostr/index.ts'

const AUX = new Uint8Array(32)
const key = (fill: number) => {
  const sk = new Uint8Array(32).fill(fill)
  return { sk, pk: bytesToHex(schnorr.getPublicKey(sk)) }
}
const ALICE = key(0x11)
const BOB = key(0x22)
const NOW = 1789430400
const FALLBACK = ['wss://relay.damus.io', 'wss://nos.lol']

describe('relay URL normalisation', () => {
  const SAME = [
    'wss://relay.example',
    'wss://relay.example/',
    'WSS://Relay.Example/',
    'wss://Relay.Example:443',
    'wss://relay.example#frag',
  ]
  test('every spelling of one relay collapses to one URL', () => {
    const set = new Set(SAME.map(normaliseRelayUrl))
    expect(set.size).toBe(1)
    expect([...set][0]).toBe('wss://relay.example')
  })

  test('a path is kept, and its case is preserved', () => {
    // Some relays route on the path, so lowercasing it points elsewhere.
    expect(normaliseRelayUrl('wss://relay.example/Inbox')).toBe('wss://relay.example/Inbox')
    expect(normaliseRelayUrl('wss://relay.example/Inbox/')).toBe('wss://relay.example/Inbox')
  })

  test('a non-default port survives', () => {
    expect(normaliseRelayUrl('wss://relay.example:7777')).toBe('wss://relay.example:7777')
    expect(normaliseRelayUrl('ws://relay.example:80')).toBe('ws://relay.example')
  })

  test('anything that is not a websocket URL is refused', () => {
    for (const bad of ['https://relay.example', 'relay.example', '', '   ', null, 42, 'wss://']) {
      expect(normaliseRelayUrl(bad)).toBeUndefined()
    }
  })
})

describe('the relay list event', () => {
  const relays: RelayEntry[] = [
    { url: 'wss://both.example', read: true, write: true },
    { url: 'wss://writeonly.example', read: false, write: true },
    { url: 'wss://readonly.example', read: true, write: false },
  ]

  const signed = (): NostrEvent =>
    signEvent(buildRelayList({ pubkey: ALICE.pk, relays, createdAt: NOW }), ALICE.sk, AUX)

  test('it is kind 10002 with one r tag per relay', () => {
    const e = buildRelayList({ pubkey: ALICE.pk, relays, createdAt: NOW })
    expect(e.kind).toBe(RELAY_LIST_KIND)
    expect(e.content).toBe('')
    expect(e.tags).toEqual([
      ['r', 'wss://both.example'],
      ['r', 'wss://writeonly.example', 'write'],
      ['r', 'wss://readonly.example', 'read'],
    ])
  })

  test('it round-trips', () => {
    expect(parseRelayList(signed())).toEqual(relays)
  })

  test('an untagged r is both read and write, per the NIP', () => {
    const e = signEvent(
      { pubkey: ALICE.pk, created_at: NOW, kind: RELAY_LIST_KIND, tags: [['r', 'wss://x.example']], content: '' },
      ALICE.sk,
      AUX,
    )
    expect(parseRelayList(e)).toEqual([{ url: 'wss://x.example', read: true, write: true }])
  })

  test('one relay listed twice with both markers means both', () => {
    const e = signEvent(
      {
        pubkey: ALICE.pk,
        created_at: NOW,
        kind: RELAY_LIST_KIND,
        tags: [['r', 'wss://x.example', 'read'], ['r', 'wss://x.example', 'write']],
        content: '',
      },
      ALICE.sk,
      AUX,
    )
    expect(parseRelayList(e)).toEqual([{ url: 'wss://x.example', read: true, write: true }])
  })

  test('junk tags are skipped, not fatal', () => {
    const e = signEvent(
      {
        pubkey: ALICE.pk,
        created_at: NOW,
        kind: RELAY_LIST_KIND,
        tags: [['r', 'not-a-url'], ['p', ALICE.pk], ['r'], ['r', 'wss://ok.example']],
        content: '',
      },
      ALICE.sk,
      AUX,
    )
    expect(parseRelayList(e)).toEqual([{ url: 'wss://ok.example', read: true, write: true }])
  })

  test('a wrong-kind event yields nothing', () => {
    expect(parseRelayList({ ...signed(), kind: 1 })).toEqual([])
  })
})

describe('outbox routing', () => {
  const alice: RelayEntry[] = [
    { url: 'wss://alice-writes.example', read: false, write: true },
    { url: 'wss://alice-reads.example', read: true, write: false },
  ]

  test('to read Alice, go where Alice writes', () => {
    expect(readRelaysFor(alice, [])).toEqual(['wss://alice-writes.example'])
  })

  test('to reach Alice, go where Alice reads', () => {
    expect(inboxRelaysFor(alice, [])).toEqual(['wss://alice-reads.example'])
  })

  test('to publish as Alice, use her write relays first', () => {
    expect(writeRelaysFor(alice, FALLBACK)[0]).toBe('wss://alice-writes.example')
  })

  test('a published list replaces the fallback instead of leading it', () => {
    // Appending defaults would push a user who chose one relay onto public ones they didn't pick.
    const relays = readRelaysFor(alice, FALLBACK)
    expect(relays).toEqual(['wss://alice-writes.example'])
    expect(relays).not.toContain('wss://relay.damus.io')
  })

  test('publishing honours the list the same way', () => {
    expect(writeRelaysFor(alice, FALLBACK)).toEqual(['wss://alice-writes.example'])
  })

  test('a list with only read relays still falls back for publishing', () => {
    // The list says nothing about where they write, so the fallback applies.
    const readOnly = [{ url: 'wss://only-reads.example', read: true, write: false }]
    expect(writeRelaysFor(readOnly, FALLBACK)).toEqual(FALLBACK)
    expect(inboxRelaysFor(readOnly, FALLBACK)).toEqual(['wss://only-reads.example'])
  })

  test('a key with no list falls back entirely', () => {
    expect(readRelaysFor([], FALLBACK)).toEqual(FALLBACK)
  })

  test('the read fanout caps how many relays are used', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      url: `wss://r${i}.example`,
      read: true,
      write: true,
    }))
    expect(readRelaysFor(many, FALLBACK).length).toBe(READ_FANOUT)
  })

  test('a list naming a default relay is still just their list', () => {
    const overlap: RelayEntry[] = [{ url: 'wss://relay.damus.io/', read: true, write: true }]
    expect(readRelaysFor(overlap, FALLBACK)).toEqual(['wss://relay.damus.io'])
  })

  test('duplicates inside one list collapse', () => {
    const dupes: RelayEntry[] = [
      { url: 'wss://a.example', read: true, write: true },
      { url: 'wss://a.example/', read: true, write: true },
    ]
    expect(readRelaysFor(dupes, FALLBACK)).toEqual(['wss://a.example'])
  })
})

describe('planAuthorQuery groups by relay instead of by author', () => {
  test('two authors sharing a relay are asked once', () => {
    const lists = new Map<string, RelayEntry[]>([
      [ALICE.pk, [{ url: 'wss://shared.example', read: false, write: true }]],
      [BOB.pk, [{ url: 'wss://shared.example', read: false, write: true }]],
    ])
    const plan = planAuthorQuery(lists, [ALICE.pk, BOB.pk], [])
    expect(plan.size).toBe(1)
    expect(plan.get('wss://shared.example')).toEqual([ALICE.pk, BOB.pk])
  })

  test('authors on different relays each get their own', () => {
    const lists = new Map<string, RelayEntry[]>([
      [ALICE.pk, [{ url: 'wss://a.example', read: false, write: true }]],
      [BOB.pk, [{ url: 'wss://b.example', read: false, write: true }]],
    ])
    const plan = planAuthorQuery(lists, [ALICE.pk, BOB.pk], [])
    expect(plan.get('wss://a.example')).toEqual([ALICE.pk])
    expect(plan.get('wss://b.example')).toEqual([BOB.pk])
  })

  test('an author with no list rides the fallback', () => {
    const plan = planAuthorQuery(new Map(), [ALICE.pk], FALLBACK)
    expect(plan.get('wss://relay.damus.io')).toEqual([ALICE.pk])
  })
})

test('the relay-list filter asks for every key at once', () => {
  expect(relayListFilter([ALICE.pk, BOB.pk])).toEqual({ kinds: [10002], authors: [ALICE.pk, BOB.pk] })
})
