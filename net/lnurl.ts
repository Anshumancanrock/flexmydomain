/**
 * LNURL-pay fetching for NIP-57 zaps. core/nostr/zap.ts decides if a receipt is real.
 * We run no payment infra. Every request goes to the recipient's own LNURL server.
 */

import { ZAP_REQUEST_KIND, type NostrEvent } from '../core/nostr/index.js'

export interface LnurlPayInfo {
  callback: string
  minSendable: number
  maxSendable: number
  metadata: string
  /** Provider writes zap receipts and publishes their signing key. */
  allowsNostr: boolean
  /** Signs the receipts. Without it a receipt proves nothing. */
  nostrPubkey?: string
  commentAllowed?: number
}

/**
 * `alice@example.com` maps to `https://example.com/.well-known/lnurlp/alice`.
 * The local part lands in a path, so path-changing characters are refused, not escaped.
 */
export function lightningAddressUrl(address: string): string | undefined {
  const match = /^([a-z0-9._-]+)@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(address.trim().toLowerCase())
  if (!match) return undefined
  return `https://${match[2]}/.well-known/lnurlp/${match[1]}`
}

/** Fetch and validate LNURL-pay metadata. */
export async function fetchLnurlPay(
  addressOrUrl: string,
  options: { signal?: AbortSignal } = {},
): Promise<{ ok: true; info: LnurlPayInfo; url: string } | { ok: false; reason: string }> {
  const url = addressOrUrl.startsWith('http') ? addressOrUrl : lightningAddressUrl(addressOrUrl)
  if (!url) return { ok: false, reason: `${JSON.stringify(addressOrUrl)} is not a lightning address` }

  let body: Record<string, unknown>
  try {
    const response = await fetch(url, { signal: options.signal, credentials: 'omit' })
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` }
    body = (await response.json()) as Record<string, unknown>
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }

  if (body.status === 'ERROR') return { ok: false, reason: String(body.reason ?? 'the provider returned an error') }
  if (typeof body.callback !== 'string') return { ok: false, reason: 'no callback URL' }
  if (typeof body.minSendable !== 'number' || typeof body.maxSendable !== 'number') {
    return { ok: false, reason: 'no sendable range' }
  }

  const nostrPubkey = typeof body.nostrPubkey === 'string' ? body.nostrPubkey.toLowerCase() : undefined
  return {
    ok: true,
    url,
    info: {
      callback: body.callback,
      minSendable: body.minSendable,
      maxSendable: body.maxSendable,
      metadata: typeof body.metadata === 'string' ? body.metadata : '',
      // Need both. allowsNostr with no key means receipts nobody can attribute.
      allowsNostr: body.allowsNostr === true && /^[0-9a-f]{64}$/.test(nostrPubkey ?? ''),
      nostrPubkey,
      commentAllowed: typeof body.commentAllowed === 'number' ? body.commentAllowed : undefined,
    },
  }
}

/**
 * Ask for an invoice with the zap request attached. The amount goes in `amount`
 * and inside the signed request. verifyZapReceipt rejects an invoice that
 * disagrees, so zaps via a provider that ignores this don't count.
 */
export async function requestZapInvoice(params: {
  info: LnurlPayInfo
  amountMsats: number
  zapRequest: NostrEvent
  lnurl?: string
  signal?: AbortSignal
}): Promise<{ ok: true; invoice: string } | { ok: false; reason: string }> {
  if (params.zapRequest.kind !== ZAP_REQUEST_KIND) {
    return { ok: false, reason: 'that is not a zap request' }
  }
  if (params.amountMsats < params.info.minSendable || params.amountMsats > params.info.maxSendable) {
    return {
      ok: false,
      reason: `this provider accepts ${params.info.minSendable} to ${params.info.maxSendable} msats`,
    }
  }
  if (!params.info.allowsNostr) {
    return { ok: false, reason: 'this lightning address does not support zaps, so no receipt would be written' }
  }

  const url = new URL(params.info.callback)
  url.searchParams.set('amount', String(params.amountMsats))
  url.searchParams.set('nostr', JSON.stringify(params.zapRequest))
  if (params.lnurl) url.searchParams.set('lnurl', params.lnurl)

  try {
    const response = await fetch(url, { signal: params.signal, credentials: 'omit' })
    const body = (await response.json()) as Record<string, unknown>
    if (body.status === 'ERROR') return { ok: false, reason: String(body.reason ?? 'the provider refused') }
    if (typeof body.pr !== 'string' || body.pr === '') return { ok: false, reason: 'the provider returned no invoice' }
    return { ok: true, invoice: body.pr }
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }
}

/**
 * Zapper key per lightning address, for verifyZapReceipt. Cached for the
 * session. Every receipt on the featured board needs one, and they rarely change.
 */
const zapperKeys = new Map<string, string | undefined>()

export async function zapperKeyFor(
  lightningAddress: string,
  options: { signal?: AbortSignal } = {},
): Promise<string | undefined> {
  if (zapperKeys.has(lightningAddress)) return zapperKeys.get(lightningAddress)
  const result = await fetchLnurlPay(lightningAddress, options)
  const key = result.ok && result.info.allowsNostr ? result.info.nostrPubkey : undefined
  zapperKeys.set(lightningAddress, key)
  return key
}

/** For tests, and after a recipient changes provider. */
export function clearZapperKeyCache(): void {
  zapperKeys.clear()
}
