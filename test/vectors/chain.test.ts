// net/chain.ts against a stubbed Esplora.

import { test, expect, afterEach, describe } from 'bun:test'
import { chainApi, findFunding } from '../../net/chain.ts'

const ADDRESS = 'tb1pajhxwz5u36hlpee99z8qgk4g405k2uxswjzc4zw5n2xugh0gkqnq6gs9wu'
const OTHER = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'
const hex = (n: number) => n.toString(16).padStart(64, '0')
const FUNDING = hex(1)
const SETTLEMENT = hex(2)
const AMOUNT = 100_000

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

interface RawTx { txid: string; status: { confirmed: boolean; block_height?: number }; vin: unknown[]; vout: unknown[] }

const funding: RawTx = { txid: FUNDING, status: { confirmed: true, block_height: 1000 }, vin: [], vout: [{ value: AMOUNT, scriptpubkey_address: ADDRESS }] }
const settlement = (confirmed = true): RawTx => ({
  txid: SETTLEMENT,
  status: confirmed ? { confirmed: true, block_height: 1010 } : { confirmed: false },
  vin: [{ txid: FUNDING, vout: 0, prevout: { scriptpubkey_address: ADDRESS }, witness: ['aa'.repeat(64), 'bb'.repeat(64), '51', 'c0'] }],
  vout: [{ value: AMOUNT - 500, scriptpubkey_address: OTHER }],
})
const dust = (i: number, confirmed = true): RawTx => ({
  txid: hex(1000 + i),
  status: confirmed ? { confirmed: true, block_height: 1001 + i } : { confirmed: false },
  vin: [{ txid: hex(5000 + i), vout: 0, prevout: { scriptpubkey_address: OTHER } }],
  vout: [{ value: 330, scriptpubkey_address: ADDRESS }],
})

// Pages the way Blockstream's and mempool.space's Esplora do: 25 confirmed per page, newest first.
function esplora(history: RawTx[], options: { utxos?: unknown; ignoreCursor?: boolean; statsOverride?: unknown } = {}): string[] {
  const asked: string[] = []
  const mempool = history.filter((t) => !t.status.confirmed)
  const chain = history.filter((t) => t.status.confirmed).sort((a, b) => b.status.block_height! - a.status.block_height!)
  const spent = new Set(history.flatMap((t) => (t.vin as { txid: string; vout: number }[]).map((i) => `${i.txid}:${i.vout}`)))
  const unspent = history.flatMap((t) => (t.vout as { value: number; scriptpubkey_address: string }[])
    .map((o, vout) => ({ txid: t.txid, vout, value: o.value, status: t.status, to: o.scriptpubkey_address })))
    .filter((o) => o.to === ADDRESS && !spent.has(`${o.txid}:${o.vout}`))
    .map(({ to: _to, ...o }) => o)

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(input.toString()).pathname.replace(/^\/api/, '')
    asked.push(path)
    if (path === `/address/${ADDRESS}`) {
      return Response.json(options.statsOverride ?? { chain_stats: { tx_count: chain.length }, mempool_stats: { tx_count: mempool.length } })
    }
    if (path === `/address/${ADDRESS}/utxo`) return Response.json(options.utxos ?? unspent)
    if (path === `/address/${ADDRESS}/txs/mempool`) return Response.json(mempool.slice(0, 50))
    const page = path.match(new RegExp(`^/address/${ADDRESS}/txs/chain(?:/([0-9a-f]{64}))?$`))
    if (page) {
      const after = page[1] && !options.ignoreCursor ? chain.findIndex((t) => t.txid === page[1]) + 1 : 0
      return Response.json(chain.slice(after, after + 25))
    }
    if (path === '/blocks/tip/height') return new Response('1100')
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
  return asked
}

const api = () => chainApi('signet', 'https://esplora.example/api')

describe('the history', () => {
  test('a spent payment shows up as spent, with what spent it', async () => {
    esplora([funding, settlement()])
    const { outputs, complete } = await api().activity(ADDRESS)
    expect(complete).toBe(true)
    expect(outputs).toHaveLength(1)
    expect(outputs[0]).toMatchObject({ txid: FUNDING, vout: 0, valueSats: 100_000n, confirmed: true })
    expect(outputs[0].spentBy).toEqual({ txid: SETTLEMENT, confirmed: true, blockHeight: 1010, witness: ['aa'.repeat(64), 'bb'.repeat(64), '51', 'c0'] })
  })

  test('a spend still in the mempool says so', async () => {
    esplora([funding, settlement(false)])
    const [output] = (await api().activity(ADDRESS)).outputs
    expect(output.spentBy).toMatchObject({ txid: SETTLEMENT, confirmed: false })
  })

  test('an unspent payment has no spender', async () => {
    esplora([{ ...funding, status: { confirmed: false } }])
    const [output] = (await api().activity(ADDRESS)).outputs
    expect(output.spentBy).toBeUndefined()
    expect(output.confirmed).toBe(false)
  })

  test('a fresh address costs one request, and reads as complete', async () => {
    const asked = esplora([])
    expect(await api().activity(ADDRESS)).toEqual({ outputs: [], complete: true })
    expect(asked).toEqual([`/address/${ADDRESS}`])
  })

  test('twenty-five dust payments after the funding do not hide it', async () => {
    esplora([funding, ...Array.from({ length: 60 }, (_, i) => dust(i))])
    const { outputs, complete } = await api().activity(ADDRESS)
    expect(complete).toBe(true)
    expect(outputs).toHaveLength(61)
    expect(outputs.some((o) => o.txid === FUNDING)).toBe(true)
  })

  test('a spend buried under dust is still found', async () => {
    esplora([funding, settlement(), ...Array.from({ length: 30 }, (_, i) => ({ ...dust(i), status: { confirmed: true, block_height: 1020 + i } }))])
    const { outputs, complete } = await api().activity(ADDRESS)
    expect(complete).toBe(true)
    expect(outputs.find((o) => o.txid === FUNDING)?.spentBy?.txid).toBe(SETTLEMENT)
  })

  test('more history than the page reads is reported incomplete, not cut short', async () => {
    esplora([funding, ...Array.from({ length: 520 }, (_, i) => dust(i))])
    expect((await api().activity(ADDRESS)).complete).toBe(false)
  })

  test('a full mempool page is reported incomplete', async () => {
    esplora([funding, ...Array.from({ length: 60 }, (_, i) => dust(i, false))])
    expect((await api().activity(ADDRESS)).complete).toBe(false)
  })

  test('a server that ignores the cursor ends the read, as incomplete', async () => {
    const asked = esplora([funding, ...Array.from({ length: 40 }, (_, i) => dust(i))], { ignoreCursor: true })
    expect((await api().activity(ADDRESS)).complete).toBe(false)
    expect(asked.filter((p) => p.includes('/txs/chain')).length).toBe(2)
  })
})

describe('funding comes from the unspent set, which has no pages', () => {
  test('funded, however many payments follow', async () => {
    esplora([funding, ...Array.from({ length: 60 }, (_, i) => dust(i))])
    const found = findFunding(await api().utxos(ADDRESS), BigInt(AMOUNT), 1, 1100)
    expect(found.funded).toBe(true)
  })
})

test('malformed fields from the API are refused, not rendered', async () => {
  esplora([], { utxos: [{ txid: FUNDING, vout: '<img src=x onerror=alert(1)>', value: 50_000, status: { confirmed: true } }] })
  await expect(api().utxos(ADDRESS)).rejects.toThrow(/output index/)
  esplora([], { utxos: [{ txid: 'not-a-txid', vout: 0, value: 50_000, status: { confirmed: true } }] })
  await expect(api().utxos(ADDRESS)).rejects.toThrow(/txid/)
  esplora([], { utxos: [{ txid: FUNDING, vout: 0, value: 0.5, status: { confirmed: true } }] })
  await expect(api().utxos(ADDRESS)).rejects.toThrow(/amount/)
  esplora([], { utxos: { not: 'a list' } })
  await expect(api().utxos(ADDRESS)).rejects.toThrow(/not a list/)

  esplora([], { statsOverride: { chain_stats: { tx_count: -1 }, mempool_stats: { tx_count: 0 } } })
  await expect(api().activity(ADDRESS)).rejects.toThrow(/transaction count/)
  esplora([{ ...settlement(), vin: [{ txid: 'zz', vout: 0, prevout: { scriptpubkey_address: ADDRESS } }] }])
  await expect(api().activity(ADDRESS)).rejects.toThrow(/malformed input/)
  esplora([{ ...funding, txid: '<b>' }])
  await expect(api().activity(ADDRESS)).rejects.toThrow(/txid/)
})

test('a witness that is not hex is dropped, not passed on', async () => {
  esplora([funding, { ...settlement(), vin: [{ txid: FUNDING, vout: 0, prevout: { scriptpubkey_address: ADDRESS }, witness: ['<script>'] }] }])
  const [output] = (await api().activity(ADDRESS)).outputs
  expect(output.spentBy?.witness).toEqual([])
})

describe('heights and fee rates', () => {
  const answer = (path: string, body: string | object, status = 200) => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const p = new URL(input.toString()).pathname
      if (p.endsWith(path)) return typeof body === 'string' ? new Response(body, { status }) : Response.json(body, { status })
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch
  }

  test('a tip height is a whole number or an error, never NaN', async () => {
    answer('/blocks/tip/height', '1100\n')
    expect(await api().tipHeight()).toBe(1100)
    for (const bad of ['', 'abc', '-5', '1.5', '<html>']) {
      answer('/blocks/tip/height', bad)
      await expect(api().tipHeight()).rejects.toThrow(/tip height/)
    }
  })

  test('a fee rate the API garbles falls back to a guess', async () => {
    answer('/fees/recommended', { halfHourFee: 7 })
    expect(await api().feeRate()).toBe(7)
    for (const bad of [{ halfHourFee: 'fast' }, { halfHourFee: -1 }, { halfHourFee: 0 }, {}]) {
      answer('/fees/recommended', bad)
      expect(await api().feeRate()).toBe(2)
    }
  })
})
