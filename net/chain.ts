import type { NetworkName } from '../core/escrow/tree.js'

export const CHAIN_APIS: Readonly<Record<NetworkName, string>> = Object.freeze({
  mainnet: 'https://mempool.space/api',
  signet: 'https://mempool.space/signet/api',
  testnet: 'https://mempool.space/testnet4/api',
  regtest: 'http://localhost:3002/api',
})

export const EXPLORERS: Readonly<Record<NetworkName, string>> = Object.freeze({
  mainnet: 'https://mempool.space',
  signet: 'https://mempool.space/signet',
  testnet: 'https://mempool.space/testnet4',
  regtest: 'http://localhost:3002',
})

export interface ChainApi {
  network: NetworkName
  base: string
  explorer: string
  tipHeight(): Promise<number>
  utxos(address: string): Promise<Utxo[]>
  activity(address: string): Promise<AddressHistory>
  transaction(txid: string): Promise<ChainTx | undefined>
  broadcast(hex: string): Promise<{ ok: true; txid: string } | { ok: false; reason: string }>
  feeRate(): Promise<number>
}

export interface Utxo {
  txid: string
  vout: number
  valueSats: bigint
  confirmed: boolean
  blockHeight?: number
}

export interface Spender {
  txid: string
  confirmed: boolean
  blockHeight?: number
  witness: string[]
}

export interface AddressOutput extends Utxo {
  spentBy?: Spender
}

export interface AddressHistory {
  outputs: AddressOutput[]
  complete: boolean
}

export interface ChainTx {
  txid: string
  confirmed: boolean
  blockHeight?: number
  vout: { valueSats: bigint; scriptPubKey: string; address?: string }[]
}

const TXID = /^[0-9a-f]{64}$/
const HEX = /^(?:[0-9a-f]{2})*$/

const MAX_HISTORY_PAGES = 20

interface RawTx {
  txid?: unknown
  status?: unknown
  vin?: { txid?: unknown; vout?: unknown; witness?: unknown; prevout?: { scriptpubkey_address?: unknown } | null }[]
  vout?: { value?: unknown; scriptpubkey_address?: unknown }[]
}

function readOutput(txid: unknown, vout: unknown, value: unknown, status: unknown): Utxo {
  if (typeof txid !== 'string' || !TXID.test(txid)) throw new Error('chain: the API sent a malformed txid')
  if (!Number.isSafeInteger(vout) || (vout as number) < 0) throw new Error('chain: the API sent a malformed output index')
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('chain: the API sent a malformed amount')
  return {
    txid,
    vout: vout as number,
    valueSats: BigInt(value as number),
    ...readStatus(status),
  }
}

function readStatus(status: unknown): { confirmed: boolean; blockHeight?: number } {
  const s = (typeof status === 'object' && status !== null ? status : {}) as { confirmed?: unknown; block_height?: unknown }
  return {
    confirmed: s.confirmed === true,
    blockHeight: Number.isSafeInteger(s.block_height) ? (s.block_height as number) : undefined,
  }
}

function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('chain: the API sent a malformed transaction count')
  return value as number
}

export function chainApi(network: NetworkName, base = CHAIN_APIS[network]): ChainApi {
  const get = async (path: string): Promise<Response> =>
    fetch(`${base}${path}`, { credentials: 'omit', headers: { accept: 'application/json, text/plain' } })
  const json = async (path: string, what: string): Promise<unknown> => {
    const response = await get(path)
    if (!response.ok) throw new Error(`chain: ${what} request failed (HTTP ${response.status})`)
    return response.json()
  }
  const list = async (path: string, what: string): Promise<RawTx[]> => {
    const body = await json(path, what)
    if (!Array.isArray(body)) throw new Error(`chain: the ${what} answer is not a list`)
    return body as RawTx[]
  }

  return {
    network,
    base,
    explorer: EXPLORERS[network],

    async tipHeight() {
      const response = await get('/blocks/tip/height')
      if (!response.ok) throw new Error(`chain: tip height request failed (HTTP ${response.status})`)
      // Every deadline is a height, so a garbled one must not pass as a number.
      const text = (await response.text()).trim()
      const height = /^\d{1,9}$/.test(text) ? Number(text) : NaN
      if (!Number.isSafeInteger(height)) throw new Error('chain: the API sent a malformed tip height')
      return height
    },

    async utxos(address) {
      const response = await get(`/address/${encodeURIComponent(address)}/utxo`)
      if (!response.ok) throw new Error(`chain: utxo request failed (HTTP ${response.status})`)
      const body = (await response.json()) as { txid?: unknown; vout?: unknown; value?: unknown; status?: unknown }[]
      if (!Array.isArray(body)) throw new Error('chain: the utxo answer is not a list')
      return body.map((u) => readOutput(u.txid, u.vout, u.value, u.status))
    },

    async activity(address) {
      const a = encodeURIComponent(address)
      const stats = await json(`/address/${a}`, 'address') as { chain_stats?: { tx_count?: unknown }; mempool_stats?: { tx_count?: unknown } }
      const confirmedCount = count(stats?.chain_stats?.tx_count)
      const mempoolCount = count(stats?.mempool_stats?.tx_count)

      const txs = new Map<string, RawTx>()
      const confirmed = (tx: RawTx): boolean => readStatus(tx.status).confirmed
      const confirmedRead = (): number => [...txs.values()].filter(confirmed).length
      const add = (tx: RawTx): boolean => {
        if (typeof tx?.txid !== 'string' || !TXID.test(tx.txid)) throw new Error('chain: the API sent a malformed txid')
        const known = txs.get(tx.txid)
        if (known && (confirmed(known) || !confirmed(tx))) return false
        txs.set(tx.txid, tx)
        return true
      }
      // At most 50, with no paging. More than that and the read is incomplete.
      if (mempoolCount > 0) for (const tx of await list(`/address/${a}/txs/mempool`, 'mempool history')) add(tx)

      let after = ''
      for (let page = 0; page < MAX_HISTORY_PAGES && confirmedRead() < confirmedCount; page++) {
        const batch = await list(`/address/${a}/txs/chain${after}`, 'history')
        let fresh = 0
        for (const tx of batch) if (add(tx)) fresh++
        if (fresh === 0) break
        after = `/${batch[batch.length - 1].txid as string}`
      }
      const complete = confirmedRead() >= confirmedCount && txs.size - confirmedRead() >= mempoolCount

      const outputs = new Map<string, AddressOutput>()
      const spends = new Map<string, Spender>()
      for (const tx of txs.values()) {
        for (const [index, out] of (Array.isArray(tx.vout) ? tx.vout : []).entries()) {
          if (out?.scriptpubkey_address !== address) continue
          const output = readOutput(tx.txid, index, out.value, tx.status)
          outputs.set(`${output.txid}:${output.vout}`, output)
        }
        for (const input of Array.isArray(tx.vin) ? tx.vin : []) {
          if (input?.prevout?.scriptpubkey_address !== address) continue
          if (typeof input.txid !== 'string' || !TXID.test(input.txid) || !Number.isSafeInteger(input.vout)) {
            throw new Error('chain: the API sent a malformed input')
          }
          const witness = Array.isArray(input.witness) && input.witness.every((w) => typeof w === 'string' && HEX.test(w))
            ? (input.witness as string[])
            : []
          spends.set(`${input.txid}:${input.vout as number}`, { txid: tx.txid as string, ...readStatus(tx.status), witness })
        }
      }
      return {
        outputs: [...outputs.entries()].map(([outpoint, output]) => ({ ...output, spentBy: spends.get(outpoint) })),
        complete,
      }
    },

    async transaction(txid) {
      const response = await get(`/tx/${txid}`)
      if (response.status === 404) return undefined
      if (!response.ok) throw new Error(`chain: tx request failed (HTTP ${response.status})`)
      const body = (await response.json()) as {
        txid: string
        status: { confirmed: boolean; block_height?: number }
        vout: { value: number; scriptpubkey: string; scriptpubkey_address?: string }[]
      }
      return {
        txid: body.txid,
        confirmed: body.status.confirmed,
        blockHeight: body.status.block_height,
        vout: body.vout.map((o) => ({
          valueSats: BigInt(o.value),
          scriptPubKey: o.scriptpubkey,
          address: o.scriptpubkey_address,
        })),
      }
    },

    async broadcast(hex) {
      const response = await fetch(`${base}/tx`, {
        method: 'POST',
        body: hex,
        credentials: 'omit',
        headers: { 'content-type': 'text/plain' },
      })
      const text = (await response.text()).trim()
      if (!response.ok) {
        return { ok: false, reason: text || `HTTP ${response.status}` }
      }
      return { ok: true, txid: text }
    },

    async feeRate() {
      try {
        const response = await fetch(`${base.replace(/\/api$/, '/api/v1')}/fees/recommended`, { credentials: 'omit' })
        if (!response.ok) throw new Error(String(response.status))
        const body = (await response.json()) as { halfHourFee?: unknown }
        const rate = body.halfHourFee
        if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) throw new Error('no usable rate')
        return rate
      } catch {
        // Fee endpoint down. Guess 10 sat/vB on mainnet, 2 on quiet test networks.
        return network === 'mainnet' ? 10 : 2
      }
    },
  }
}

/** Funded means one confirmed output pays the address at least the agreed amount. */
export function findFunding(
  utxos: readonly Utxo[],
  requiredSats: bigint,
  minConfirmations = 1,
  tipHeight?: number,
): { funded: true; utxo: Utxo } | { funded: false; reason: string; candidates: Utxo[] } {
  const paid = utxos.filter((u) => u.valueSats >= requiredSats)

  if (paid.length === 0) {
    const best = utxos.reduce((max, u) => (u.valueSats > max ? u.valueSats : max), 0n)
    return {
      funded: false,
      candidates: [...utxos],
      reason:
        utxos.length === 0
          ? 'nothing has been paid to this address yet'
          : `the largest single payment is ${best} sats and ${requiredSats} is required. ` +
            'Partial payments are not added together, so send the full amount in one transaction',
    }
  }

  const confirmed = paid.filter((u) => {
    if (!u.confirmed) return false
    if (minConfirmations <= 1 || tipHeight === undefined || u.blockHeight === undefined) return u.confirmed
    return tipHeight - u.blockHeight + 1 >= minConfirmations
  })

  if (confirmed.length === 0) {
    return { funded: false, candidates: paid, reason: 'the payment is in the mempool but not confirmed yet' }
  }

  // Oldest first. If somebody paid twice, the first payment funded the escrow.
  const chosen = [...confirmed].sort((a, b) => (a.blockHeight ?? Infinity) - (b.blockHeight ?? Infinity))[0]
  return { funded: true, utxo: chosen }
}
