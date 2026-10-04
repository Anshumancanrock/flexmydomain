import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, normalize } from 'node:path'
import { bytesToHex } from '@noble/hashes/utils.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { checkEvent, type NostrEvent } from '../core/nostr/event.js'
import { npubEncode, nsecEncode } from '../core/nostr/nip19.js'
import { decide } from '../services/relay/policy.js'
import { matches } from '../test/harness/relay.ts'
import { haveBitcoind, startRegtest } from '../test/regtest/node.ts'
import { PAGES, compilePage } from './pages.ts'

const ROOT = join(import.meta.dir, '..')
const API_PORT = 3002
const RELAY_PORT = 7447
const WEB_PORT = 8100
const RPC_PORT = 18990
const API = `http://127.0.0.1:${API_PORT}`
const RELAY = `ws://127.0.0.1:${RELAY_PORT}`
const PASSPHRASE = 'sandbox-pass'

if (!haveBitcoind) {
  console.error('The sandbox needs Bitcoin Core under tools/bitcoin-31.1 (spec/VERIFY.md section 5).')
  process.exit(1)
}

/* ---------- Test identities, fresh on every start ---------- */

const identity = (role: string) => {
  const secret = schnorr.utils.randomSecretKey()
  const pubkey = bytesToHex(schnorr.getPublicKey(secret))
  return { role, secret: bytesToHex(secret), pubkey, npub: npubEncode(pubkey), nsec: nsecEncode(secret) }
}
const people = { buyer: identity('buyer'), seller: identity('seller'), arbiter: identity('arbiter') }

/* ---------- The served copy, built first: a stale patch fails before anything starts ---------- */

console.log('Building the pages from the current sources…')
const site = mkdtempSync(join(tmpdir(), 'fmd-sandbox-'))
cpSync(join(ROOT, 'web'), site, { recursive: true })

const built = await Bun.build({ entrypoints: [join(ROOT, 'client/index.ts')], target: 'browser', format: 'esm', minify: false, sourcemap: 'none' })
if (!built.success) {
  for (const log of built.logs) console.error(log)
  throw new Error('sandbox: the bundle did not build')
}
let bundle = await built.outputs[0].text()
const patch = (what: string, from: string | RegExp, to: string, expected = 1) => {
  const hits = typeof from === 'string' ? bundle.split(from).length - 1 : (bundle.match(new RegExp(from.source, 'g')) ?? []).length
  if (hits !== expected) throw new Error(`sandbox: expected ${expected} ${what} in the bundle, found ${hits}`)
  bundle = typeof from === 'string' ? bundle.replaceAll(from, to) : bundle.replace(new RegExp(from.source, 'g'), to)
}
patch('relay list', /var DEFAULT_RELAYS = \[[^\]]*\]/, `var DEFAULT_RELAYS = ["${RELAY}"]`)
patch('RDAP bootstraps', '"https://data.iana.org/rdap/dns.json"', `"${API}/rdap/dns.json"`, 2)
patch('RDAP https rule', 'best.filter((u) => /^https:\\/\\//i.test(u))', `best.filter((u) => /^(https:\\/\\/|${API.replace(/[/.:]/g, (c) => `\\${c}`)}\\/)/i.test(u))`)
patch('first resolver', '"https://cloudflare-dns.com/dns-query"', `"${API}/doh/cloudflare"`)
patch('second resolver', '"https://dns.google/resolve"', `"${API}/doh/google"`)
writeFileSync(join(site, 'assets/fmd.js'), bundle)
for (const page of PAGES) {
  writeFileSync(join(site, `assets/${page}.js`), compilePage(page, readFileSync(join(ROOT, `web/src/${page}.ts`), 'utf8')))
}

let config = readFileSync(join(ROOT, 'web/assets/config.js'), 'utf8')
const setting = (key: string, value: string) => {
  const re = new RegExp(`(\\n  ${key}: )[^\\n]*,`)
  if (!re.test(config)) throw new Error(`sandbox: config.js has no ${key}`)
  config = config.replace(re, `$1${value},`)
}
setting('network', '"regtest"')
setting('chainApiBase', `"${API}/api"`)
setting('arbiterPubkey', `"${people.arbiter.npub}"`)
setting('extraRelays', '[]')
writeFileSync(join(site, 'assets/config.js'), config)

writeFileSync(join(site, 'sandbox-seed.html'), `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sandbox key</title>
<body style="font:15px/1.6 system-ui,sans-serif;padding:24px;max-width:640px">
<p id="out">Storing the sandbox key in this origin…</p>
<script type="module">
  import { storeKey } from "./assets/fmd.js";
  const out = document.getElementById("out");
  const role = new URL(location.href).searchParams.get("role");
  try {
    const who = await (await fetch("${API}/sandbox/identity/" + role)).json();
    const secret = Uint8Array.from(who.secret.match(/../g).map((h) => parseInt(h, 16)));
    await storeKey(secret, "${PASSPHRASE}", { replace: true });
    out.innerHTML = "This origin now holds the sandbox <b>" + role + "</b> key, " + who.npub.slice(0, 16) + "…, "
      + "under the passphrase <b>${PASSPHRASE}</b>. <a href=\\"escrow.html\\">Open the escrow page</a>, click "
      + "Connect, and unlock the stored key.";
  } catch (err) {
    out.textContent = "Could not store the key: " + err.message;
  }
</script>`)

/* ---------- Bitcoin ---------- */

console.log('Starting a regtest node…')
let node: Awaited<ReturnType<typeof startRegtest>>
try {
  node = await startRegtest(RPC_PORT)
} catch (err) {
  rmSync(site, { recursive: true, force: true })
  throw err
}
let stopping = false
async function stop(code = 0): Promise<never> {
  if (!stopping) {
    stopping = true
    console.log('\nStopping: the chain and the served copy are deleted.')
    await node.stop().catch(() => {})
    rmSync(site, { recursive: true, force: true })
  }
  process.exit(code)
}
process.on('SIGINT', () => void stop())
process.on('SIGTERM', () => void stop())
process.on('uncaughtException', (err) => { console.error(err); void stop(1) })
process.on('unhandledRejection', (err) => { console.error(err); void stop(1) })

const rpc = node.rpc
await rpc('createwallet', ['sandbox', false, false, '', false, true, true])
const miner = await rpc<string>('getnewaddress')
await rpc('generatetoaddress', [101, miner])

const sats = (btc: number): number => Math.round(btc * 1e8)

interface EsploraTx {
  txid: string
  status: { confirmed: boolean; block_height?: number; block_hash?: string; block_time?: number }
  vin: Record<string, unknown>[]
  vout: { scriptpubkey: string; scriptpubkey_address?: string; scriptpubkey_type: string; value: number }[]
}

function esplora(tx: any, status: EsploraTx['status']): EsploraTx {
  return {
    txid: tx.txid,
    status,
    vin: tx.vin.map((i: any) => i.coinbase
      ? { is_coinbase: true, prevout: null, witness: i.txinwitness ?? [], sequence: i.sequence }
      : {
          txid: i.txid,
          vout: i.vout,
          sequence: i.sequence,
          witness: i.txinwitness ?? [],
          prevout: i.prevout
            ? { scriptpubkey: i.prevout.scriptPubKey.hex, scriptpubkey_address: i.prevout.scriptPubKey.address, value: sats(i.prevout.value) }
            : null,
        }),
    vout: tx.vout.map((o: any) => ({
      scriptpubkey: o.scriptPubKey.hex,
      scriptpubkey_address: o.scriptPubKey.address,
      scriptpubkey_type: o.scriptPubKey.type,
      value: sats(o.value),
    })),
  }
}

// An address index over the blocks, caught up on each request.
const confirmed = new Map<string, EsploraTx>()
const byAddress = new Map<string, string[]>()
let indexed = -1
let catching: Promise<void> = Promise.resolve()

function addressesOf(tx: EsploraTx): Set<string> {
  const out = new Set<string>()
  for (const o of tx.vout) if (o.scriptpubkey_address) out.add(o.scriptpubkey_address)
  for (const i of tx.vin) {
    const a = (i.prevout as { scriptpubkey_address?: string } | null)?.scriptpubkey_address
    if (a) out.add(a)
  }
  return out
}

function catchUp(): Promise<void> {
  catching = catching.then(async () => {
    const tip = await rpc<number>('getblockcount')
    for (let h = indexed + 1; h <= tip; h++) {
      const hash = await rpc<string>('getblockhash', [h])
      const block = await rpc<any>('getblock', [hash, 3])
      for (const raw of block.tx) {
        const tx = esplora(raw, { confirmed: true, block_height: h, block_hash: hash, block_time: block.time })
        confirmed.set(tx.txid, tx)
        for (const a of addressesOf(tx)) byAddress.set(a, [...(byAddress.get(a) ?? []), tx.txid])
      }
      indexed = h
    }
  })
  return catching
}

async function mempool(): Promise<EsploraTx[]> {
  const ids = await rpc<string[]>('getrawmempool')
  const txs: EsploraTx[] = []
  for (const id of ids) {
    const raw = await rpc<any>('getrawtransaction', [id, 2])
    for (const i of raw.vin) {
      if (i.coinbase || i.prevout) continue
      const parent = await rpc<any>('getrawtransaction', [i.txid, 1])
      i.prevout = parent.vout[i.vout]
    }
    txs.push(esplora(raw, { confirmed: false }))
  }
  return txs
}

async function history(address: string): Promise<{ chain: EsploraTx[]; pending: EsploraTx[] }> {
  await catchUp()
  const chain = (byAddress.get(address) ?? []).map((id) => confirmed.get(id)!).reverse() // Newest first, as Esplora.
  const pending = (await mempool()).filter((tx) => addressesOf(tx).has(address))
  return { chain, pending }
}

async function utxos(address: string) {
  const { chain, pending } = await history(address)
  const spent = new Set<string>()
  for (const tx of [...chain, ...pending]) for (const i of tx.vin) if (i.txid) spent.add(`${i.txid}:${i.vout}`)
  const out: { txid: string; vout: number; value: number; status: EsploraTx['status'] }[] = []
  for (const tx of [...chain, ...pending]) {
    tx.vout.forEach((o, n) => {
      if (o.scriptpubkey_address === address && !spent.has(`${tx.txid}:${n}`)) out.push({ txid: tx.txid, vout: n, value: o.value, status: tx.status })
    })
  }
  return out
}

/* ---------- The registry and DNS ---------- */

const movedAt = new Map<string, number>()
const pendingTransfer = new Set<string>()
const zone = new Map<string, string[]>()

const TLDS = ['com', 'net', 'org', 'io', 'dev', 'app', 'xyz', 'lol', 'co', 'ai', 'me', 'info', 'site', 'online', 'store', 'tech', 'test']
const DAY = 86400

function rdapRecord(domain: string): unknown {
  const now = Math.floor(Date.now() / 1000)
  const date = (t: number) => new Date(t * 1000).toISOString()
  const moved = movedAt.get(domain)
  const spaceship = moved === undefined
  return {
    objectClassName: 'domain',
    ldhName: domain,
    status: pendingTransfer.has(domain) ? ['pending transfer'] : ['client transfer prohibited'],
    events: [
      { eventAction: 'registration', eventDate: date(now - 400 * DAY) },
      { eventAction: 'expiration', eventDate: date(now + 300 * DAY) },
      ...(moved === undefined ? [] : [
        { eventAction: 'transfer', eventDate: date(moved) },
        { eventAction: 'last changed', eventDate: date(moved) },
      ]),
    ],
    entities: [{
      objectClassName: 'entity',
      roles: ['registrar'],
      publicIds: [{ type: 'IANA Registrar ID', identifier: spaceship ? '3862' : '1068' }],
      vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', spaceship ? 'Spaceship, Inc.' : 'NameCheap, Inc.']]],
    }],
    nameservers: (spaceship ? ['launch1.spaceship.net', 'launch2.spaceship.net'] : ['dns1.registrar-servers.com', 'dns2.registrar-servers.com'])
      .map((ldhName) => ({ objectClassName: 'nameserver', ldhName })),
  }
}

/* ---------- The relay ---------- */

const events: NostrEvent[] = []
const subs = new Map<unknown, Map<string, Record<string, unknown>[]>>()
const replaceable = (kind: number) => kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000) || (kind >= 30000 && kind < 40000)
const addressOf = (e: NostrEvent) => `${e.kind}:${e.pubkey}:${e.tags.find((t) => t[0] === 'd')?.[1] ?? ''}`

/** False when an equal or newer version is already held, as a real relay keeps the newest. */
function store(event: NostrEvent): boolean {
  if (events.some((e) => e.id === event.id)) return false
  if (replaceable(event.kind)) {
    const at = events.findIndex((e) => addressOf(e) === addressOf(event))
    if (at !== -1) {
      const old = events[at]
      if (old.created_at > event.created_at || (old.created_at === event.created_at && old.id < event.id)) return false
      events.splice(at, 1)
    }
  }
  events.push(event)
  return true
}

async function listen(what: string, start: () => void): Promise<void> {
  try {
    start()
  } catch (err) {
    console.error(`sandbox: could not start the ${what}: ${(err as Error).message}`)
    await stop(1)
  }
}

await listen(`relay on port ${RELAY_PORT}`, () => Bun.serve({
  hostname: '127.0.0.1',
  port: RELAY_PORT,
  fetch(request, server) {
    if (server.upgrade(request)) return undefined as unknown as Response
    return new Response('flexmydomain sandbox relay', { headers: { 'access-control-allow-origin': '*' } })
  },
  websocket: {
    open(ws) { subs.set(ws, new Map()) },
    close(ws) { subs.delete(ws) },
    message(ws, raw) {
      let frame: unknown
      try { frame = JSON.parse(String(raw)) } catch { return }
      if (!Array.isArray(frame)) return
      const [type, a, ...rest] = frame as [string, unknown, ...Record<string, unknown>[]]
      if (type === 'EVENT') {
        const checked = checkEvent(a)
        const id = (a as { id?: unknown })?.id
        if (!checked.ok) { ws.send(JSON.stringify(['OK', id, false, `invalid: ${checked.reason}`])); return }
        const verdict = decide(checked.event, { acceptGiftWraps: true })
        if (verdict.action !== 'accept') {
          ws.send(JSON.stringify(['OK', id, false, (verdict as { msg?: string }).msg ?? 'blocked']))
          console.log(`relay: refused kind ${checked.event.kind}: ${(verdict as { msg?: string }).msg}`)
          return
        }
        const fresh = store(checked.event)
        ws.send(JSON.stringify(['OK', id, true, fresh ? '' : 'duplicate: have this or a newer version']))
        if (!fresh) return
        for (const [socket, open] of subs) {
          for (const [sub, filters] of open) {
            if (filters.some((f) => matches(checked.event, f))) (socket as typeof ws).send(JSON.stringify(['EVENT', sub, checked.event]))
          }
        }
        return
      }
      if (type === 'REQ' && typeof a === 'string') {
        const limit = Math.min(...rest.map((f) => (typeof f.limit === 'number' ? f.limit : Infinity)))
        const found = events.filter((e) => rest.some((f) => matches(e, f))).sort((x, y) => y.created_at - x.created_at)
        for (const e of found.slice(0, Number.isFinite(limit) ? limit : undefined)) ws.send(JSON.stringify(['EVENT', a, e]))
        ws.send(JSON.stringify(['EOSE', a]))
        subs.get(ws)?.set(a, rest)
        return
      }
      if (type === 'COUNT' && typeof a === 'string') {
        ws.send(JSON.stringify(['COUNT', a, { count: events.filter((e) => rest.some((f) => matches(e, f))).length }]))
        return
      }
      if (type === 'CLOSE' && typeof a === 'string') subs.get(ws)?.delete(a)
    },
  },
}))

/* ---------- The API, the explorer and the control page ---------- */

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'cache-control': 'no-store' }
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: cors })
const text = (value: string, status = 200) => new Response(value, { status, headers: { ...cors, 'content-type': 'text/plain' } })

async function api(path: string, request: Request): Promise<Response> {
  if (path === '/blocks/tip/height') return text(String(await rpc<number>('getblockcount')))
  if (path === '/v1/fees/recommended') return json({ fastestFee: 2, halfHourFee: 2, hourFee: 1, economyFee: 1, minimumFee: 1 })
  if (path === '/tx' && request.method === 'POST') {
    try { return text(await rpc<string>('sendrawtransaction', [(await request.text()).trim()])) }
    catch (err) { return text((err as Error).message, 400) }
  }
  const tx = path.match(/^\/tx\/([0-9a-f]{64})$/)
  if (tx) {
    await catchUp()
    const found = confirmed.get(tx[1]) ?? (await mempool()).find((t) => t.txid === tx[1])
    return found ? json(found) : text('Transaction not found', 404)
  }
  const m = path.match(/^\/address\/([a-z0-9]+)(\/.*)?$/)
  if (m) {
    const [, address, rest] = m
    if (rest === '/utxo') return json(await utxos(address))
    const { chain, pending } = await history(address)
    if (!rest) return json({ address, chain_stats: { tx_count: chain.length }, mempool_stats: { tx_count: pending.length } })
    if (rest === '/txs/mempool') return json(pending)
    const page = rest.match(/^\/txs\/chain(?:\/([0-9a-f]{64}))?$/)
    if (page) {
      const start = page[1] ? chain.findIndex((t) => t.txid === page[1]) + 1 : 0
      return json(start === 0 && page[1] ? [] : chain.slice(start, start + 25))
    }
  }
  return text('not found', 404)
}

async function control(path: string, request: Request): Promise<Response> {
  const body = request.method === 'POST' ? await request.json().catch(() => ({})) as Record<string, unknown> : {}
  if (path === '/state') {
    await catchUp()
    return json({
      tip: await rpc<number>('getblockcount'),
      people: { buyer: people.buyer, seller: people.seller, arbiter: people.arbiter },
      zone: Object.fromEntries(zone),
      moved: [...movedAt.keys()],
      pending: [...pendingTransfer],
      events: events.map((e) => ({ kind: e.kind, d: e.tags.find((t) => t[0] === 'd')?.[1] ?? '', author: e.pubkey, at: e.created_at }))
        .sort((x, y) => y.at - x.at).slice(0, 40),
      eventCount: events.length,
    })
  }
  const who = path.match(/^\/identity\/(buyer|seller)$/)
  if (who) return json(people[who[1] as 'buyer' | 'seller'])
  if (path === '/mine') {
    const blocks = Math.min(Math.max(Number(body.blocks) || 1, 1), 500)
    await rpc('generatetoaddress', [blocks, miner])
    return json({ tip: await rpc<number>('getblockcount') })
  }
  if (path === '/pay') {
    const amount = Number(body.sats)
    if (typeof body.address !== 'string' || !Number.isSafeInteger(amount) || amount <= 0) return json({ error: 'give an address and a whole number of sats' }, 400)
    try {
      const txid = await rpc<string>('sendtoaddress', [body.address, amount / 1e8])
      if (body.mine) await rpc('generatetoaddress', [1, miner])
      return json({ txid })
    } catch (err) { return json({ error: (err as Error).message }, 400) }
  }
  if (path === '/address') return json({ address: await rpc<string>('getnewaddress', ['payout', 'bech32m']) })
  if (path === '/received' && typeof body.address === 'string') {
    try {
      return json({ sats: sats(await rpc<number>('getreceivedbyaddress', [body.address, 0])) })
    } catch (err) { return json({ error: (err as Error).message }, 400) }
  }
  if (path === '/txt') {
    const name = String(body.name ?? '').trim().toLowerCase().replace(/\.$/, '')
    if (!name) return json({ error: 'give a name' }, 400)
    const value = String(body.value ?? '').trim()
    if (value) zone.set(name, [...(zone.get(name) ?? []).filter((v) => v !== value), value])
    else zone.delete(name)
    return json({ zone: Object.fromEntries(zone) })
  }
  if (path === '/registry') {
    const domain = String(body.domain ?? '').trim().toLowerCase()
    if (!domain) return json({ error: 'give a domain' }, 400)
    if (body.moved === true && !movedAt.has(domain)) movedAt.set(domain, Math.floor(Date.now() / 1000))
    else if (body.moved === false) movedAt.delete(domain)
    if (body.pending === true) pendingTransfer.add(domain)
    else if (body.pending === false) pendingTransfer.delete(domain)
    return json({ moved: [...movedAt.keys()], pending: [...pendingTransfer] })
  }
  return json({ error: 'not found' }, 404)
}

function explorer(kind: string, value: string): Response {
  const page = `<!doctype html><meta charset="utf-8"><title>${kind} ${value.slice(0, 12)}</title>
<body style="font:14px/1.5 ui-monospace,monospace;padding:20px;max-width:1100px">
<p><a href="/">sandbox</a> · ${kind} <b>${value}</b></p><pre id="out">loading…</pre>
<script>
fetch("/api/${kind === 'address' ? `address/${value}/txs/chain` : `tx/${value}`}")
  .then((r) => r.json()).then((j) => { document.getElementById("out").textContent = JSON.stringify(j, null, 2) })
  .catch((e) => { document.getElementById("out").textContent = String(e) })
</script>`
  return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
}

const CONTROL_PAGE = readFileSync(join(import.meta.dir, 'sandbox.html'), 'utf8')
  .replaceAll('__WEB_PORT__', String(WEB_PORT))
  .replaceAll('__PASSPHRASE__', PASSPHRASE)

for (const hostname of ['127.0.0.1', '::1']) {
  const start = () => Bun.serve({
      hostname,
      port: API_PORT,
      async fetch(request) {
        if (request.method === 'OPTIONS') return new Response(null, { headers: { ...cors, 'access-control-allow-methods': 'GET, POST' } })
        const url = new URL(request.url)
        const path = url.pathname
        try {
          if (path.startsWith('/api/')) return await api(path.slice(4), request)
          if (path.startsWith('/sandbox/')) return await control(path.slice(8), request)
          if (path === '/rdap/dns.json') {
            return json({ version: '1.0', services: [[TLDS, [`${API}/rdap/`]]] })
          }
          const rdap = path.match(/^\/rdap\/domain\/(.+)$/)
          if (rdap) return json(rdapRecord(decodeURIComponent(rdap[1]).toLowerCase()))
          if (path === '/doh/cloudflare' || path === '/doh/google') {
            const name = (url.searchParams.get('name') ?? '').toLowerCase().replace(/\.$/, '')
            const records = zone.get(name) ?? []
            return json({ Status: 0, AD: false, Answer: records.map((r) => ({ name: `${name}.`, type: 16, TTL: 60, data: JSON.stringify(r) })) })
          }
          const view = path.match(/^\/(address|tx)\/([0-9a-z]+)$/)
          if (view) return explorer(view[1], view[2])
          if (path === '/') return new Response(CONTROL_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
          return text('not found', 404)
        } catch (err) {
          console.error(err)
          return text(`sandbox: ${(err as Error).message}`, 500)
        }
      },
    })
  if (hostname === '127.0.0.1') await listen(`API on port ${API_PORT}`, start)
  else try { start() } catch { }
}

/* ---------- The pages ---------- */

// Every page may connect only to the stand-ins here: nothing reaches a public relay.
const local = [API, `http://localhost:${API_PORT}`, RELAY, `ws://localhost:${RELAY_PORT}`]
const pageHeaders = {
  'cache-control': 'no-store',
  'content-security-policy': `connect-src 'self' ${local.join(' ')}`,
}
for (const hostname of ['127.0.0.1', '::1']) {
  const start = () => Bun.serve({
      hostname,
      port: WEB_PORT,
      async fetch(request) {
        let path: string
        try { path = normalize(decodeURIComponent(new URL(request.url).pathname)) }
        catch { return new Response('bad request', { status: 400 }) }
        for (const candidate of [join(site, path), join(site, path, 'index.html')]) {
          if (!candidate.startsWith(site)) break
          const file = Bun.file(candidate)
          if (await file.exists()) return new Response(file, { headers: pageHeaders })
        }
        return new Response('not found', { status: 404 })
      },
    })
  if (hostname === '127.0.0.1') await listen(`pages on port ${WEB_PORT}`, start)
  else try { start() } catch { }
}

/* ---------- Ready ---------- */

console.log(`
flexmydomain sandbox: regtest, a local relay, a stand-in registry and DNS.

  Control page   http://127.0.0.1:${API_PORT}/     fund, mine, DNS records, keys
  Buyer          http://127.0.0.1:${WEB_PORT}/sandbox-seed.html?role=buyer
  Seller         http://localhost:${WEB_PORT}/sandbox-seed.html?role=seller
  Arbiter        http://[::1]:${WEB_PORT}/escrow.html?arbiter   (paste the arbiter key on an escrow's page)

  Passphrase for the stored keys: ${PASSPHRASE}
  Test keys only, fresh every start. Ctrl-C stops everything.
`)
