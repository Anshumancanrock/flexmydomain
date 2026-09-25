/**
 * Esplora client over fetch. Endpoints are public, keyless and CORS-open, so a
 * static page can watch its escrow and broadcast with no server of ours.
 * Defaults to mempool.space. Any Esplora base URL works.
 */

import type { NetworkName } from '../core/escrow/tree.js'

/** Regtest expects a local Esplora. */
export const CHAIN_APIS: Readonly<Record<NetworkName, string>> = Object.freeze({
  mainnet: 'https://mempool.space/api',
  signet: 'https://mempool.space/signet/api',
  // testnet4. testnet3 is mostly abandoned and its faucets are unreliable.
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

export interface ChainTx {
  txid: string
  confirmed: boolean
  blockHeight?: number
  /** In output index order. */
  vout: { valueSats: bigint; scriptPubKey: string; address?: string }[]
}

/** `base` overrides the network's default endpoint. */
export function chainApi(network: NetworkName, base = CHAIN_APIS[network]): ChainApi {
  const get = async (path: string): Promise<Response> =>
    fetch(`${base}${path}`, { credentials: 'omit', headers: { accept: 'application/json, text/plain' } })

  return {
    network,
    base,
    explorer: EXPLORERS[network],

    async tipHeight() {
      const response = await get('/blocks/tip/height')
      if (!response.ok) throw new Error(`chain: tip height request failed (HTTP ${response.status})`)
      return Number(await response.text())
    },

    async utxos(address) {
      const response = await get(`/address/${encodeURIComponent(address)}/utxo`)
      if (!response.ok) throw new Error(`chain: utxo request failed (HTTP ${response.status})`)
      const body = (await response.json()) as {
        txid: string
        vout: number
        value: number
        status: { confirmed: boolean; block_height?: number }
      }[]
      return body.map((u) => ({
        txid: u.txid,
        vout: u.vout,
        // Esplora sends a JSON number. Exact, since no output nears 2^53.
        // BigInt from here keeps every amount in one type.
        valueSats: BigInt(u.value),
        confirmed: u.status.confirmed,
        blockHeight: u.status.block_height,
      }))
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
        // Pass the node's rejection text through as is. It beats any summary.
        return { ok: false, reason: text || `HTTP ${response.status}` }
      }
      return { ok: true, txid: text }
    },

    async feeRate() {
      try {
        const response = await fetch(`${base.replace(/\/api$/, '/api/v1')}/fees/recommended`, { credentials: 'omit' })
        if (!response.ok) throw new Error(String(response.status))
        const body = (await response.json()) as { halfHourFee?: number }
        return body.halfHourFee ?? 2
      } catch {
        // Fee endpoint down. Guess 10 sat/vB on mainnet, 2 on quiet test networks.
        return network === 'mainnet' ? 10 : 2
      }
    },
  }
}

/**
 * Funded means one confirmed output pays the address at least the agreed
 * amount. Partial payments are not summed, since a multi-input settlement
 * multiplies the signing work. Overpaying is fine.
 */
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
