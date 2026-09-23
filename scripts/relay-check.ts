#!/usr/bin/env bun
/**
 * Check a deployed flexmydomain relay end to end.
 *
 *   bun run relay:check wss://relay.example.com --mine
 *
 * It publishes a handful of test events with a throwaway key and checks what
 * the relay does with each: the listing is stored, counted and then deleted;
 * a listing with a broken proof and an off-topic note are refused. The test
 * listing is for example.com and expires on its own after five minutes, so a
 * failed deletion still cleans up.
 *
 * `--mine` is required because this writes to the relay. Run it only against
 * a relay you operate: test data does not belong on infrastructure other
 * people rely on, and the five public relays the site reads are refused.
 */

import { bytesToHex } from '@noble/hashes/utils.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { signEvent, type NostrEvent, type UnsignedEvent } from '../core/nostr/event.js'
import { buildListing, LISTING_TOPIC } from '../core/nostr/listing.js'
import { buildDeletion } from '../core/nostr/deletion.js'
import { DEFAULT_RELAYS } from '../core/nostr/index.js'
import { createProof } from '../core/oracle/proof.js'
import { countOnRelay, fetchRelayInfo, publishToRelay, queryRelay } from '../net/relay.js'

const url = process.argv[2]
if (!url || !/^wss?:\/\//.test(url)) {
  console.error('usage: bun run relay:check <wss://your.relay> --mine')
  process.exit(2)
}
if (!process.argv.includes('--mine')) {
  console.error('relay:check publishes test events. Pass --mine to confirm this is your own relay.')
  process.exit(2)
}
if ((DEFAULT_RELAYS as readonly string[]).includes(url.toLowerCase().replace(/\/+$/, ''))) {
  console.error(`${url} is a public relay the site reads, not yours. Refusing to publish test events to it.`)
  process.exit(2)
}

const sk = schnorr.utils.randomSecretKey()
const pubkey = bytesToHex(schnorr.getPublicKey(sk))
const now = Math.floor(Date.now() / 1000)
const sign = (u: UnsignedEvent): NostrEvent => signEvent(u, sk)

let failures = 0
function report(ok: boolean, what: string, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? 'pass' : 'FAIL'}  ${what}${detail ? `: ${detail}` : ''}`)
}

// 1. The relay says what it is and what it supports.
const info = (await fetchRelayInfo(url).catch(() => undefined)) as { name?: string; supported_nips?: number[] } | undefined
report(Boolean(info?.name), 'serves a NIP-11 document', info?.name ?? 'none')
report(Boolean(info?.supported_nips?.includes(45)), 'advertises NIP-45 COUNT')
report(Boolean(info?.supported_nips?.includes(77)), 'advertises NIP-77 negentropy, so it can be mirrored')

// 2. A real listing, proof and all, is stored.
const { record } = await createProof({
  domain: 'example.com',
  iat: now,
  signer: { getPublicKey: async () => pubkey, signEvent: async (u: UnsignedEvent) => sign(u) },
})
const listing = sign(buildListing({
  pubkey, domain: 'example.com', priceSats: 1, publishedAt: now, proof: record,
  summary: 'relay:check test listing', expiration: now + 300,
}))
const stored = await publishToRelay(url, listing)
report(stored.ok, 'stores a flexmydomain listing with a valid proof', stored.message ?? '')

// 3. What it must refuse.
const brokenSig = record.sig.slice(0, -2) + (record.sig.endsWith('00') ? '01' : '00')
const forged = sign(buildListing({
  pubkey, domain: 'example.com', priceSats: 1, publishedAt: now + 1, proof: { ...record, sig: brokenSig },
  expiration: now + 300,
}))
const forgedResult = await publishToRelay(url, forged)
report(!forgedResult.ok && /^blocked:/.test(forgedResult.message ?? ''), 'refuses a listing whose proof does not verify', forgedResult.message ?? 'accepted')

const note = sign({ pubkey, created_at: now, kind: 1, tags: [], content: 'relay:check off-topic note' })
const noteResult = await publishToRelay(url, note)
report(!noteResult.ok && /^blocked:/.test(noteResult.message ?? ''), 'refuses an off-topic note', noteResult.message ?? 'accepted')

// 4. Reads and counts what it stored.
const filter = { kinds: [listing.kind], authors: [pubkey], '#t': [LISTING_TOPIC] }
const found = await queryRelay(url, [filter], { timeoutMs: 5000 }).catch(() => [])
report(found.some((e) => e.id === listing.id), 'returns the stored listing to a REQ')
const count = await countOnRelay(url, [filter]).catch(() => undefined)
report(count === 1, 'COUNT returns exactly that one listing', String(count))

// 5. Delisting: a NIP-09 deletion that names the listing by its `a` coordinate.
const deletion = sign(buildDeletion({ pubkey, events: [listing], reason: 'relay:check cleanup', createdAt: now + 2 }))
const deleted = await publishToRelay(url, deletion)
report(deleted.ok, 'stores the deletion', deleted.message ?? '')
const after = await queryRelay(url, [filter], { timeoutMs: 5000 }).catch(() => [])
report(!after.some((e) => e.id === listing.id), 'honours the deletion: the listing is gone')

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
