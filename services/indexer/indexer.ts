#!/usr/bin/env bun

import { Database } from 'bun:sqlite'
import {
  DEFAULT_RELAYS,
  LISTING_D_PREFIX,
  checkListing,
  listingFilter,
  parseListing,
  applyDeletions,
  deletionFilter,
  tagValue,
  type NostrEvent,
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
  -- the verification result, refreshed on every sweep that could check DNS
  verified     INTEGER NOT NULL DEFAULT 0,
  dnssec       INTEGER NOT NULL DEFAULT 0,
  reason       TEXT,
  verified_at  INTEGER,            -- the last sweep that could check DNS for this version
  checked_at   INTEGER NOT NULL,   -- the last sweep that saw the listing at all
  misses       INTEGER NOT NULL DEFAULT 0,
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

const MISSES_BEFORE_DROP = 3

/** How long a verdict stands while DNS can't be checked: a resolver is down, say. */
const VERDICT_TTL_SECONDS = 24 * 3600

function migrate(db: Database): void {
  const columns = new Set((db.query('PRAGMA table_info(listings)').all() as { name: string }[]).map((c) => c.name))
  if (!columns.has('verified_at')) db.run('ALTER TABLE listings ADD COLUMN verified_at INTEGER')
  if (!columns.has('misses')) db.run('ALTER TABLE listings ADD COLUMN misses INTEGER NOT NULL DEFAULT 0')
}

async function fetchListings(
  options: Options,
  filter: Record<string, unknown>,
): Promise<{ events: NostrEvent[]; deletions: NostrEvent[]; answered: boolean; majority: boolean }> {
  let finished = 0
  const events = await queryRelays(options.relays, [filter], {
    timeoutMs: 10000,
    onRelayDone: (_relay, _count, _error, complete) => { if (complete) finished++ },
  }).catch(() => [])
  const authors = [...new Set(events.map((e) => e.pubkey))]
  const deletions = authors.length
    ? await queryRelays(options.relays, [deletionFilter(authors)], { timeoutMs: 8000 }).catch(() => [])
    : []
  return {
    events,
    deletions,
    answered: finished === options.relays.length,
    majority: finished > 0 && finished * 2 >= options.relays.length,
  }
}

async function sweep(db: Database, options: Options): Promise<void> {
  const startedAt = Math.floor(Date.now() / 1000)
  const first = await fetchListings(options, listingFilter({ limit: 1000 }))
  const events = [...first.events]
  const deletions = [...first.deletions]
  let answered = first.answered
  let majority = first.majority

  const seen = new Set(newestPerAddress(events).map((e) => e.id))
  const missing = (db.query('SELECT pubkey, domain, event_id FROM listings').all() as
    { pubkey: string; domain: string; event_id: string }[]).filter((r) => !seen.has(r.event_id))
  for (let i = 0; i < missing.length; i += 100) {
    const batch = missing.slice(i, i + 100)
    const found = await fetchListings(options, listingFilter({
      authors: [...new Set(batch.map((r) => r.pubkey))],
      '#d': batch.map((r) => LISTING_D_PREFIX + r.domain),
    }))
    answered &&= found.answered
    majority &&= found.majority
    events.push(...found.events)
    deletions.push(...found.deletions)
  }
  // Newest per address across every answer, so a relay holding an old version can't bring it back.
  const latest = newestPerAddress(events)
  const live = applyDeletions(latest, deletions)

  console.log(`${new Date().toISOString()}  ${live.length} listings fetched`)

  const liveIds = new Set(live.map((e) => e.id))
  let deleted = 0
  for (const event of latest.filter((e) => !liveIds.has(e.id))) {
    deleted += db.run('DELETE FROM listings WHERE address = $address AND created_at <= $at', {
      $address: `${event.kind}:${event.pubkey}:${tagValue(event, 'd')}`,
      $at: event.created_at,
    } as never).changes
  }

  // Never back to an older version: a relay that missed the newest one may still answer with the last.
  const upsert = db.prepare(`
    INSERT INTO listings (address, event_id, pubkey, domain, tld, price_sats, summary, description,
                          status, published_at, created_at, registered_at, verified, dnssec, reason,
                          verified_at, checked_at, misses, raw)
    VALUES ($address, $event_id, $pubkey, $domain, $tld, $price_sats, $summary, $description,
            $status, $published_at, $created_at, $registered_at, $verified, $dnssec, $reason,
            $verified_at, $checked_at, 0, $raw)
    ON CONFLICT(address) DO UPDATE SET
      event_id = excluded.event_id, price_sats = excluded.price_sats, summary = excluded.summary,
      description = excluded.description, status = excluded.status, published_at = excluded.published_at,
      created_at = excluded.created_at, registered_at = excluded.registered_at,
      verified = CASE WHEN $dns = 0 AND $expired = 0 AND excluded.event_id = listings.event_id AND listings.verified_at > $fresh
                      THEN listings.verified ELSE excluded.verified END,
      dnssec = CASE WHEN $dns = 0 AND $expired = 0 AND excluded.event_id = listings.event_id AND listings.verified_at > $fresh
                    THEN listings.dnssec ELSE excluded.dnssec END,
      reason = CASE WHEN $dns = 0 AND $expired = 0 AND excluded.event_id = listings.event_id AND listings.verified_at > $fresh
                    THEN listings.reason ELSE excluded.reason END,
      verified_at = CASE WHEN $dns = 1 THEN excluded.verified_at
                         WHEN excluded.event_id = listings.event_id THEN listings.verified_at ELSE NULL END,
      checked_at = excluded.checked_at, misses = 0, raw = excluded.raw
    WHERE excluded.created_at > listings.created_at
       OR (excluded.created_at = listings.created_at AND excluded.event_id <= listings.event_id)
  `)
  const touch = db.prepare('UPDATE listings SET checked_at = $at, misses = 0 WHERE address = $address')
  const storedOf = db.prepare('SELECT event_id, created_at, raw FROM listings WHERE address = $address')

  let verifiedCount = 0
  let failed = 0
  await pool(live, options.concurrency, async (event) => {
    try {
      await index(event)
    } catch (err) {
      // Anyone can publish a listing. One that breaks here must not stop the sweep.
      failed++
      console.error(`  skipped ${event.id}: ${(err as Error).message}`)
    }
  })

  async function index(fetched: NostrEvent): Promise<void> {
    const first = parseListing(fetched)
    if (!first.ok) return
    const address = `30402:${fetched.pubkey}:fmd:listing:${first.listing.domain}`

    const stored = storedOf.get({ $address: address } as never) as { event_id: string; created_at: number; raw: string } | null
    const newer = stored !== null &&
      (stored.created_at > fetched.created_at || (stored.created_at === fetched.created_at && stored.event_id < fetched.id))
    const event: NostrEvent = newer ? (JSON.parse(stored.raw) as NostrEvent) : fetched
    const parsed = newer ? parseListing(event) : first
    if (!parsed.ok) {
      touch.run({ $at: startedAt, $address: address } as never)
      return
    }
    const listing = parsed.listing

    // Same check the browser runs. Never serve a listing a client would refuse.
    const report = await checkDomainProof({
      domain: listing.domain,
      pubkey: event.pubkey,
      dnsOnly: true,
    }).catch(() => null)
    const check = checkListing({ event, dnsProof: report?.dns, now: startedAt })
    if (check.ok) verifiedCount++
    const dns = report?.answered === true

    const { changes } = upsert.run({
      $address: address,
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
      $verified_at: dns ? startedAt : null,
      $checked_at: startedAt,
      $raw: JSON.stringify(event),
      $dns: dns ? 1 : 0,
      $expired: check.expired ? 1 : 0,
      $fresh: startedAt - VERDICT_TTL_SECONDS,
    } as never)
    if (changes === 0) touch.run({ $at: startedAt, $address: address } as never)
  }

  // bun:sqlite takes named bindings here but only types the positional form.
  let dropped = deleted
  if (answered) {
    dropped += db.run('DELETE FROM listings WHERE checked_at < $at', { $at: startedAt } as never).changes
  } else if (majority) {
    db.run('UPDATE listings SET misses = misses + 1 WHERE checked_at < $at', { $at: startedAt } as never)
    dropped += db.run('DELETE FROM listings WHERE checked_at < $at AND misses >= $k', { $at: startedAt, $k: MISSES_BEFORE_DROP } as never).changes
    console.log(`  not every relay finished answering, so a missing row goes after ${MISSES_BEFORE_DROP} such sweeps`)
  } else {
    console.log('  too few relays finished answering, so nothing was dropped')
  }

  console.log(
    `  ${verifiedCount} verified, ${live.length - verifiedCount - failed} unverified, ` +
      `${failed} skipped, ${dropped} dropped\n`,
  )
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
      // Unverified only on request, and always labelled.
      const includeUnverified = url.searchParams.get('unverified') === '1'
      const asked = Math.trunc(Number(url.searchParams.get('limit') ?? 50))
      const limit = Number.isFinite(asked) ? Math.min(200, Math.max(1, asked)) : 50
      const sort = url.searchParams.get('sort') ?? 'price-desc'

      const order = new Map([
        ['price-desc', 'price_sats DESC'],
        ['price-asc', 'price_sats ASC'],
        ['newest', 'published_at DESC'],
        ['az', 'domain ASC'],
      ]).get(sort) ?? 'price_sats DESC'

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
  migrate(db)

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
