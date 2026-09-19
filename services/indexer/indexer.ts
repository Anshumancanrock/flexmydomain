#!/usr/bin/env bun
/**
 * The indexer: subscribes to relays, verifies every listing, writes SQLite and
 * serves one read-only search endpoint.
 *
 *   bun services/indexer/indexer.ts [--db ./fmd.db] [--port 8788] [--once]
 *
 * It is a cache: delete the database and it rebuilds from the relays. Nothing
 * may live only here; everything it holds must be rebuildable from relays and
 * the chain. The market page queries relays directly and does not depend on
 * it. What it adds is search, TLD facets and sorting across thousands of
 * listings, which relays cannot do.
 *
 * Listings are checked with the functions the browser runs, imported from
 * core/ and net/, so the index and the pages cannot disagree about a listing.
 */

import { Database } from 'bun:sqlite'
import {
  DEFAULT_RELAYS,
  checkListing,
  listingFilter,
  parseListing,
  applyDeletions,
  deletionFilter,
} from '../../core/nostr/index.js'
import { newestPerAddress, queryRelays } from '../../net/relay.js'
import { checkDomainProof } from '../../net/verify.js'
import { tldOf } from '../../core/oracle/index.js'

interface Options {
  dbPath: string
  relays: string[]
  port: number
  intervalSeconds: number
  once: boolean
  concurrency: number
}

function parseArgs(argv: string[]): Options {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`)
    return i === -1 ? undefined : argv[i + 1]
  }
  return {
    dbPath: get('db') ?? './fmd-index.db',
    relays: get('relays')?.split(',').map((r) => r.trim()).filter(Boolean) ?? [...DEFAULT_RELAYS],
    port: Number(get('port') ?? 8788),
    intervalSeconds: Number(get('interval') ?? 600),
    once: argv.includes('--once'),
    concurrency: Number(get('concurrency') ?? 4),
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS listings (
  address      TEXT PRIMARY KEY,   -- 30402:<pubkey>:fmd:listing:<domain>
  event_id     TEXT NOT NULL,
  pubkey       TEXT NOT NULL,
  domain       TEXT NOT NULL,
  tld          TEXT NOT NULL,
  price_sats   INTEGER NOT NULL,
  summary      TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'active',
  published_at INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  registered_at INTEGER,
  -- the verification result, refreshed on every sweep
  verified     INTEGER NOT NULL DEFAULT 0,
  dnssec       INTEGER NOT NULL DEFAULT 0,
  reason       TEXT,
  checked_at   INTEGER NOT NULL,
  raw          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS listings_domain ON listings(domain);
CREATE INDEX IF NOT EXISTS listings_tld    ON listings(tld);
CREATE INDEX IF NOT EXISTS listings_price  ON listings(price_sats);
CREATE INDEX IF NOT EXISTS listings_verified ON listings(verified);
`

async function pool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  await Promise.all(
    Array.from({ length: Math.max(1, limit) }, async () => {
      for (;;) {
        const item = queue.shift()
        if (item === undefined) return
        await fn(item)
      }
    }),
  )
}

async function sweep(db: Database, options: Options): Promise<void> {
  const startedAt = Math.floor(Date.now() / 1000)
  const events = await queryRelays(options.relays, [listingFilter({ limit: 1000 })], { timeoutMs: 10000 }).catch(() => [])
  const current = newestPerAddress(events)

  const authors = [...new Set(current.map((e) => e.pubkey))]
  const deletions = authors.length
    ? await queryRelays(options.relays, [deletionFilter(authors)], { timeoutMs: 8000 }).catch(() => [])
    : []
  const live = applyDeletions(current, deletions)

  console.log(`${new Date().toISOString()}  ${live.length} listings fetched`)

  const upsert = db.prepare(`
    INSERT INTO listings (address, event_id, pubkey, domain, tld, price_sats, summary, description,
                          status, published_at, created_at, registered_at, verified, dnssec, reason, checked_at, raw)
    VALUES ($address, $event_id, $pubkey, $domain, $tld, $price_sats, $summary, $description,
            $status, $published_at, $created_at, $registered_at, $verified, $dnssec, $reason, $checked_at, $raw)
    ON CONFLICT(address) DO UPDATE SET
      event_id = excluded.event_id, price_sats = excluded.price_sats, summary = excluded.summary,
      description = excluded.description, status = excluded.status, published_at = excluded.published_at,
      created_at = excluded.created_at, registered_at = excluded.registered_at,
      verified = excluded.verified, dnssec = excluded.dnssec, reason = excluded.reason,
      checked_at = excluded.checked_at, raw = excluded.raw
  `)

  let verifiedCount = 0
  await pool(live, options.concurrency, async (event) => {
    const parsed = parseListing(event)
    if (!parsed.ok) return
    const listing = parsed.listing

    /* The browser's check: signature, embedded proof, and the zone still
       agreeing. The index must not serve a listing the client would refuse. */
    const report = await checkDomainProof({
      domain: listing.domain,
      pubkey: event.pubkey,
      dnsOnly: true,
    }).catch(() => null)
    const check = checkListing({ event, dnsProof: report?.dns, now: startedAt })
    if (check.ok) verifiedCount++

    upsert.run({
      $address: `30402:${event.pubkey}:fmd:listing:${listing.domain}`,
      $event_id: event.id,
      $pubkey: event.pubkey,
      $domain: listing.domain,
      $tld: tldOf(listing.domain),
      $price_sats: listing.priceSats,
      $summary: listing.summary,
      $description: listing.description,
      $status: listing.status,
      $published_at: listing.publishedAt,
      $created_at: event.created_at,
      $registered_at: listing.registeredAt ?? null,
      $verified: check.ok ? 1 : 0,
      $dnssec: report?.dnssec ? 1 : 0,
      $reason: check.ok ? null : (check.reason ?? 'unverified'),
      $checked_at: startedAt,
      $raw: JSON.stringify(event),
    })
  })

  /* Drop listings that no longer appear on the relays, so the index holds
     nothing its source has lost. Every row written by this sweep carries this
     sweep's timestamp, so an older row was not seen. */
  // bun:sqlite accepts a named-binding object here, but its types only
  // describe the positional form, hence the cast.
  const dropped = db.run('DELETE FROM listings WHERE checked_at < $at', {
    $at: startedAt,
  } as never).changes

  console.log(`  ${verifiedCount} verified, ${live.length - verifiedCount} unverified, ${dropped} dropped\n`)
}

function serve(db: Database, options: Options): void {
  const cors = {
    'access-control-allow-origin': '*',
    'content-type': 'application/json',
    'cache-control': 'public, max-age=30',
  }

  Bun.serve({
    port: options.port,
    fetch(request) {
      const url = new URL(request.url)

      if (url.pathname === '/health') {
        const row = db.query('SELECT COUNT(*) AS n, MAX(checked_at) AS at FROM listings').get() as { n: number; at: number | null }
        return Response.json({ ok: true, listings: row.n, lastSweep: row.at, cache: true }, { headers: cors })
      }

      if (url.pathname !== '/search') {
        return Response.json(
          { error: 'This is a cache with one endpoint: /search. The relays are the source.' },
          { status: 404, headers: cors },
        )
      }

      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
      const tld = (url.searchParams.get('tld') ?? '').trim().toLowerCase()
      // Unverified listings are served only on request, and always labelled.
      const includeUnverified = url.searchParams.get('unverified') === '1'
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50)))
      const sort = url.searchParams.get('sort') ?? 'price-desc'

      const order = {
        'price-desc': 'price_sats DESC',
        'price-asc': 'price_sats ASC',
        newest: 'published_at DESC',
        az: 'domain ASC',
      }[sort] ?? 'price_sats DESC'

      const rows = db
        .query(
          `SELECT address, event_id, pubkey, domain, tld, price_sats, summary, status,
                  published_at, registered_at, verified, dnssec, reason, checked_at, raw
             FROM listings
            WHERE status = 'active'
              AND ($verified = 0 OR verified = 1)
              AND ($tld = '' OR tld = $tld)
              AND ($q = '' OR domain LIKE $like OR LOWER(summary) LIKE $like)
            ORDER BY ${order}
            LIMIT $limit`,
        )
        .all({ $verified: includeUnverified ? 0 : 1, $tld: tld, $q: q, $like: `%${q}%`, $limit: limit }) as Record<string, unknown>[]

      return Response.json(
        {
          // Every response says it comes from a cache of the relays, so no
          // consumer mistakes it for the marketplace itself.
          cache: true,
          source: 'nostr relays',
          relays: options.relays,
          filter: { kinds: [30402], '#t': ['flexmydomain'] },
          note: 'Verify the events yourself. The raw event is in every row.',
          count: rows.length,
          listings: rows.map((r) => ({ ...r, event: JSON.parse(r.raw as string), raw: undefined })),
        },
        { headers: cors },
      )
    },
  })

  console.log(`  search   http://localhost:${options.port}/search?q=&tld=&sort=price-desc`)
  console.log(`  health   http://localhost:${options.port}/health\n`)
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const db = new Database(options.dbPath)
  db.run('PRAGMA journal_mode = WAL')
  db.run(SCHEMA)

  console.log('flexmydomain indexer (a cache of the relays)')
  console.log(`  db       ${options.dbPath}`)
  console.log(`  relays   ${options.relays.join(', ')}`)
  console.log(`  filter   {"kinds":[30402],"#t":["flexmydomain"]}`)
  console.log(`  Delete the db and it rebuilds. Turn this off and the client queries relays directly.\n`)

  if (!options.once) serve(db, options)

  for (;;) {
    await sweep(db, options).catch((err) => console.error(`sweep failed: ${(err as Error).message}`))
    if (options.once) {
      db.close()
      return
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalSeconds * 1000))
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
