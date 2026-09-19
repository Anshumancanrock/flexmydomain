/**
 * NIP-09 vectors for core/nostr/deletion.ts.
 *
 * The security of this mechanism rests on one check: a deletion request
 * applies only to its own author's events. Without it anyone could hide
 * anyone's listing by publishing a kind 5 naming it, which would give every
 * competitor a delist button.
 */

import { test, expect, describe } from 'bun:test'
import { bytesToHex } from '@noble/hashes/utils.js'
import { schnorr } from '@noble/curves/secp256k1.js'

import {
  DELETION_KIND,
  addressOf,
  applyDeletions,
  buildDeletion,
  buildListing,
  deletionFilter,
  parseDeletion,
  signEvent,
  type NostrEvent,
} from '../../core/nostr/index.ts'
import { proofEvent } from '../../core/oracle/index.ts'

const AUX = new Uint8Array(32)
const key = (fill: number) => {
  const sk = new Uint8Array(32).fill(fill)
  return { sk, pk: bytesToHex(schnorr.getPublicKey(sk)) }
}
const ALICE = key(0x11)
const MALLORY = key(0x22)
const NOW = 1789430400

function listingOf(owner: typeof ALICE, domain: string, createdAt = NOW): NostrEvent {
  const proofSig = signEvent(proofEvent({ domain, pubkey: owner.pk, iat: NOW }), owner.sk, AUX).sig
  return signEvent(
    buildListing({
      pubkey: owner.pk,
      domain,
      priceSats: 1000,
      publishedAt: NOW,
      createdAt,
      proof: { version: 'fmd1', iat: NOW, pubkey: owner.pk, sig: proofSig },
    }),
    owner.sk,
    AUX,
  )
}

const note = (owner: typeof ALICE, content: string, createdAt = NOW): NostrEvent =>
  signEvent({ pubkey: owner.pk, created_at: createdAt, kind: 1, tags: [], content }, owner.sk, AUX)

describe('building a deletion request', () => {
  test('an addressable event is referenced by coordinate, not by id', () => {
    // A listing edited five times has five ids; a seller means all of them.
    const listing = listingOf(ALICE, 'lumenary.com')
    const request = buildDeletion({ pubkey: ALICE.pk, events: [listing], createdAt: NOW })
    expect(request.kind).toBe(DELETION_KIND)
    expect(request.tags).toContainEqual(['a', addressOf(listing)])
    expect(request.tags).toContainEqual(['k', '30402'])
    expect(request.tags.some((t) => t[0] === 'e')).toBe(false)
  })

  test('a regular event is referenced by id', () => {
    const request = buildDeletion({ pubkey: ALICE.pk, events: [note(ALICE, 'hi')], createdAt: NOW })
    expect(request.tags.some((t) => t[0] === 'e')).toBe(true)
    expect(request.tags).toContainEqual(['k', '1'])
  })

  test("requesting deletion of someone else's event is refused at build time", () => {
    expect(() =>
      buildDeletion({ pubkey: MALLORY.pk, events: [listingOf(ALICE, 'lumenary.com')], createdAt: NOW }),
    ).toThrow(/your own events/)
  })

  test('an empty request is refused', () => {
    expect(() => buildDeletion({ pubkey: ALICE.pk, events: [], createdAt: NOW })).toThrow()
  })

  test('the reason travels in content', () => {
    const request = buildDeletion({
      pubkey: ALICE.pk,
      events: [note(ALICE, 'hi')],
      reason: 'delisted',
      createdAt: NOW,
    })
    expect(parseDeletion(signEvent(request, ALICE.sk, AUX))?.reason).toBe('delisted')
  })
})

describe('applying deletions client-side', () => {
  test('an author can hide their own listing', () => {
    const listing = listingOf(ALICE, 'lumenary.com')
    const request = signEvent(
      buildDeletion({ pubkey: ALICE.pk, events: [listing], createdAt: NOW + 10 }),
      ALICE.sk,
      AUX,
    )
    expect(applyDeletions([listing], [request])).toEqual([])
  })

  test("Mallory cannot delete Alice's listing", () => {
    // The attack: forge a kind 5 naming a competitor's listing coordinate.
    // It is a valid event signed by Mallory, and it must do nothing.
    const listing = listingOf(ALICE, 'lumenary.com')
    const forged = signEvent(
      {
        pubkey: MALLORY.pk,
        created_at: NOW + 10,
        kind: DELETION_KIND,
        tags: [['a', addressOf(listing)], ['k', '30402']],
        content: 'not mine to delete',
      },
      MALLORY.sk,
      AUX,
    )
    expect(applyDeletions([listing], [forged])).toEqual([listing])
  })

  test('a relisting published after a deletion request survives it', () => {
    const old = listingOf(ALICE, 'lumenary.com', NOW)
    const request = signEvent(
      buildDeletion({ pubkey: ALICE.pk, events: [old], createdAt: NOW + 10 }),
      ALICE.sk,
      AUX,
    )
    const relisted = listingOf(ALICE, 'lumenary.com', NOW + 100)
    expect(applyDeletions([relisted], [request])).toEqual([relisted])
    expect(applyDeletions([old], [request])).toEqual([])
  })

  test('other listings by the same author are untouched', () => {
    const a = listingOf(ALICE, 'lumenary.com')
    const b = listingOf(ALICE, 'zeta.io')
    const request = signEvent(buildDeletion({ pubkey: ALICE.pk, events: [a], createdAt: NOW + 10 }), ALICE.sk, AUX)
    expect(applyDeletions([a, b], [request])).toEqual([b])
  })

  test('an id-based request removes exactly that event', () => {
    const one = note(ALICE, 'one')
    const two = note(ALICE, 'two', NOW + 1)
    const request = signEvent(buildDeletion({ pubkey: ALICE.pk, events: [one], createdAt: NOW + 10 }), ALICE.sk, AUX)
    expect(applyDeletions([one, two], [request])).toEqual([two])
  })

  test('no requests means nothing is filtered', () => {
    const events = [listingOf(ALICE, 'lumenary.com'), note(ALICE, 'hi')]
    expect(applyDeletions(events, [])).toEqual(events)
  })

  test('a non-deletion event in the request list is ignored', () => {
    const listing = listingOf(ALICE, 'lumenary.com')
    expect(applyDeletions([listing], [note(ALICE, 'not a deletion')])).toEqual([listing])
  })
})

test('parseDeletion refuses a wrong-kind event', () => {
  expect(parseDeletion(note(ALICE, 'hi'))).toBeUndefined()
})

test('the deletion filter asks for every author at once', () => {
  expect(deletionFilter([ALICE.pk, MALLORY.pk])).toEqual({ kinds: [5], authors: [ALICE.pk, MALLORY.pk] })
})
