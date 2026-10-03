// Paying an escrow address from a wallet: the BIP21 link, its amount in BTC and a QR code of it.

import { bech32 } from '@scure/base'
import { encode } from 'uqr'

const SATS_PER_BTC = 100_000_000n

export function btcAmount(sats: number | bigint): string {
  const n = typeof sats === 'bigint' ? sats : BigInt(sats)
  if (n <= 0n) throw new Error('btcAmount: the amount must be a positive number of sats')
  const whole = n / SATS_PER_BTC
  const frac = (n % SATS_PER_BTC).toString().padStart(8, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole.toString()
}

/** A BIP21 payment link for exactly `sats` to `address`. The address is taken as given. */
export function bip21(address: string, sats: number | bigint): string {
  if (!/^[a-z0-9]+$/i.test(address)) throw new Error('bip21: that is not a bitcoin address')
  return `bitcoin:${address}?amount=${btcAmount(sats)}`
}

export function qrSvg(text: string, options: { label?: string } = {}): string {
  const qr = encode(text, { ecc: 'M', border: 4 })
  let path = ''
  qr.data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) path += `M${x} ${y}h1v1h-1z`
    })
  })
  const label = (options.label ?? 'QR code').replace(/[&<>"']/g, '')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${qr.size} ${qr.size}" shape-rendering="crispEdges" role="img" aria-label="${label}">` +
    `<rect width="${qr.size}" height="${qr.size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`
}

const SIGNATURE_WORDS = 104
const EXPIRY_FIELD = 6
const DEFAULT_EXPIRY = 3600

export function bolt11Expiry(invoice: string): { createdAt: number; expiresAt: number } | undefined {
  let words: number[]
  try {
    words = bech32.decode(invoice.trim().toLowerCase() as `${string}1${string}`, false).words
  } catch {
    return undefined
  }
  if (words.length < 7 + SIGNATURE_WORDS) return undefined
  const read = (from: number, count: number): number => {
    let n = 0
    for (let i = from; i < from + count; i++) n = n * 32 + words[i]
    return n
  }
  const createdAt = read(0, 7)
  let expiry = DEFAULT_EXPIRY
  const end = words.length - SIGNATURE_WORDS
  for (let i = 7; i < end; ) {
    if (i + 3 > end) return undefined
    const type = words[i]
    const length = words[i + 1] * 32 + words[i + 2]
    if (i + 3 + length > end) return undefined
    if (type === EXPIRY_FIELD) {
      if (length > 10) return undefined
      expiry = read(i + 3, length)
    }
    i += 3 + length
  }
  return { createdAt, expiresAt: createdAt + expiry }
}

export const INVOICE_OFFER_SECONDS = 10 * 60

export function invoiceOfferEnds(invoice: string, receivedAt: number, windowSeconds = INVOICE_OFFER_SECONDS): number {
  const times = bolt11Expiry(invoice)
  const lifetime = times ? times.expiresAt - times.createdAt : windowSeconds
  return receivedAt + Math.max(0, Math.min(windowSeconds, lifetime))
}
