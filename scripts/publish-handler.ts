#!/usr/bin/env bun
/**
 * Publish this deployment's NIP-89 handler advertisement (kind 31990), once per
 * deployment. Tells other clients which kinds we open (listings, portfolios)
 * and at what URL.
 *
 *   bun scripts/publish-handler.ts --nsec nsec1... --url https://example.com
 */

import {
  DEFAULT_RELAYS,
  LISTING_KIND,
  buildHandlerAdvertisement,
  decodeNip19,
  signEvent,
} from '../core/nostr/index.js'
import { publishToRelays } from '../net/relay.js'
import { PORTFOLIO_KIND } from '../core/nostr/portfolio.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

const nsec = arg('nsec') ?? process.env.FMD_OPERATOR_NSEC
if (!nsec) {
  console.error('No key. Pass --nsec <nsec1...> or set FMD_OPERATOR_NSEC.')
  process.exit(1)
}

const decoded = decodeNip19(nsec)
if (decoded.type !== 'nsec') {
  console.error('That is not an nsec.')
  process.exit(1)
}

const base = (arg('url') ?? 'https://flexmydomain.example').replace(/\/$/, '')
const relays = arg('relays')?.split(',').map((r) => r.trim()).filter(Boolean) ?? [...DEFAULT_RELAYS]

const { schnorr } = await import('@noble/curves/secp256k1.js')
const { bytesToHex } = await import('@noble/hashes/utils.js')
const pubkey = bytesToHex(schnorr.getPublicKey(decoded.data))

const event = signEvent(
  buildHandlerAdvertisement({
    pubkey,
    // NIP-89 replaces `<bech32>` with the naddr.
    webUrl: `${base}/market.html?a=<bech32>`,
    name: 'flexmydomain',
    about:
      'A non-custodial domain marketplace. Listings carry their own DNS proof, ' +
      'so any client can verify one without asking us anything.',
    kinds: [LISTING_KIND, PORTFOLIO_KIND],
    createdAt: Math.floor(Date.now() / 1000),
  }),
  decoded.data,
)

console.log('flexmydomain handler advertisement')
console.log(`  pubkey ${pubkey}`)
console.log(`  kinds  ${LISTING_KIND}, ${PORTFOLIO_KIND}`)
console.log(`  opens  ${base}/market.html?a=<bech32>\n`)

const results = await publishToRelays(relays, event)
for (const r of results) {
  console.log(`  ${r.ok ? 'ok    ' : 'refused'} ${r.relay}${r.message ? `: ${r.message}` : ''}`)
}
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} relays accepted it.`)
