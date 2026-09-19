#!/usr/bin/env bun
/**
 * The domain verifier: a NIP-90 daemon that publishes kind 6970 attestations.
 *
 * It watches listings and portfolios, re-resolves each domain's proof from
 * wherever this machine sits, and publishes what it saw as a signed
 * attestation. Anyone can run one. Verifiers count as independent only when
 * they run on different networks behind different resolvers.
 *
 * It is optional: every page in web/ resolves DNS itself and reaches its own
 * verdict, so turning this off leaves the marketplace unchanged. Attestations
 * add a second opinion from another network; a client that relies on them
 * instead of its own lookup trades a check it controls for one it does not.
 *
 *   bun services/verifier/verifier.ts --nsec <nsec1...> [--once] [--interval 3600]
 *
 * Give it a key that signs attestations and nothing else, so a compromise
 * cannot cost funds or an identity.
 */

import { readFileSync } from 'node:fs'
import {
  DEFAULT_RELAYS,
  buildAttestation,
  decodeNip19,
  listingFilter,
  parseListing,
  parsePortfolio,
  signEvent,
  type NostrEvent,
} from '../../core/nostr/index.js'
import { PORTFOLIO_KIND, PORTFOLIO_D } from '../../core/nostr/portfolio.js'
import { newestPerAddress, publishToRelays, queryRelays } from '../../net/relay.js'
import { checkDomainProof } from '../../net/verify.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils.js'

interface Options {
  secretKey: Uint8Array
  relays: string[]
  intervalSeconds: number
  once: boolean
  /** At most this many DoH lookups at once; providers rate-limit. */
  concurrency: number
}

function parseArgs(argv: string[]): Options {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`)
    return i === -1 ? undefined : argv[i + 1]
  }

  const nsec = get('nsec') ?? process.env.FMD_VERIFIER_NSEC
  const keyFile = get('key-file')
  const raw = keyFile ? readFileSync(keyFile, 'utf8').trim() : nsec
  if (!raw) {
    throw new Error(
      'No key. Pass --nsec <nsec1...>, --key-file <path>, or set FMD_VERIFIER_NSEC.\n' +
        'Use a key that does nothing else: it signs attestations and holds no funds.',
    )
  }

  const decoded = decodeNip19(raw)
  if (decoded.type !== 'nsec') throw new Error('That is not an nsec')

  return {
    secretKey: decoded.data,
    relays: get('relays')?.split(',').map((r) => r.trim()).filter(Boolean) ?? [...DEFAULT_RELAYS],
    intervalSeconds: Number(get('interval') ?? 3600),
    once: argv.includes('--once'),
    concurrency: Number(get('concurrency') ?? 4),
  }
}

/** Every (domain, claimant) pair named by a listing or a portfolio. */
async function collectSubjects(relays: string[]): Promise<Map<string, { domain: string; claimant: string }>> {
  const subjects = new Map<string, { domain: string; claimant: string }>()

  const listings = await queryRelays(relays, [listingFilter({ limit: 500 })], { timeoutMs: 8000 }).catch(() => [])
  for (const event of newestPerAddress(listings)) {
    const parsed = parseListing(event)
    if (parsed.ok) subjects.set(`${parsed.listing.domain}|${event.pubkey}`, { domain: parsed.listing.domain, claimant: event.pubkey })
  }

  const portfolios = await queryRelays(
    relays,
    [{ kinds: [PORTFOLIO_KIND], '#d': [PORTFOLIO_D], limit: 500 }],
    { timeoutMs: 8000 },
  ).catch(() => [] as NostrEvent[])
  for (const event of newestPerAddress(portfolios)) {
    const parsed = parsePortfolio(event)
    if (!parsed.ok) continue
    for (const entry of parsed.portfolio.entries) {
      subjects.set(`${entry.domain}|${event.pubkey}`, { domain: entry.domain, claimant: event.pubkey })
    }
  }

  return subjects
}

/** Run `fn` over `items`, `limit` at a time. DoH providers rate-limit. */
async function pool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    for (;;) {
      const item = queue.shift()
      if (item === undefined) return
      await fn(item)
    }
  })
  await Promise.all(workers)
}

async function sweep(options: Options, pubkey: string): Promise<void> {
  const startedAt = new Date().toISOString()
  const subjects = [...(await collectSubjects(options.relays)).values()]
  console.log(`${startedAt}  ${subjects.length} domains to check`)

  let proven = 0
  let absent = 0
  let unreachable = 0

  await pool(subjects, options.concurrency, async (subject) => {
    const observedAt = Math.floor(Date.now() / 1000)
    let report
    try {
      report = await checkDomainProof({ domain: subject.domain, pubkey: subject.claimant, now: observedAt })
    } catch (err) {
      console.error(`  ${subject.domain}: ${(err as Error).message}`)
      return
    }

    /* `unreachable` means no resolver answered, which says nothing about the
       domain. Recording it as `absent` would make a network problem here look
       like a vanished proof to everyone reading. A failed lookup is never a
       negative result (spec/PROOF.md). */
    const verdict = report.status.proven ? 'proven' : report.answered ? 'absent' : 'unreachable'
    if (verdict === 'proven') proven++
    else if (verdict === 'absent') absent++
    else unreachable++

    const event = signEvent(
      buildAttestation({
        pubkey,
        domain: subject.domain,
        claimant: subject.claimant,
        verdict,
        source: report.status.source,
        iat: report.status.iat,
        dnssec: report.dnssec,
        resolvers: report.lookup.observations.filter((o) => !o.error).map((o) => o.provider),
        observedAt,
        createdAt: observedAt,
      }),
      options.secretKey,
    )

    const results = await publishToRelays(options.relays, event).catch(() => [])
    const accepted = results.filter((r) => r.ok).length
    console.log(`  ${subject.domain.padEnd(28)} ${verdict.padEnd(12)} published to ${accepted}/${options.relays.length}`)
  })

  console.log(`${new Date().toISOString()}  done: ${proven} proven, ${absent} absent, ${unreachable} unreachable\n`)
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const pubkey = bytesToHex(schnorr.getPublicKey(options.secretKey))

  console.log('flexmydomain verifier')
  console.log(`  pubkey   ${pubkey}`)
  console.log(`  relays   ${options.relays.join(', ')}`)
  console.log(`  interval ${options.once ? 'once' : `${options.intervalSeconds}s`}`)
  console.log('  This daemon is optional. Every page verifies DNS for itself.\n')

  for (;;) {
    await sweep(options, pubkey).catch((err) => console.error(`sweep failed: ${(err as Error).message}`))
    if (options.once) return
    await new Promise((resolve) => setTimeout(resolve, options.intervalSeconds * 1000))
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
