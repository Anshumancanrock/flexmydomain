// LNURL-pay (net/lnurl.ts) against a stubbed provider.

import { test, expect, afterEach } from 'bun:test'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { fetchLnurlPay, requestZapInvoice, type LnurlPayInfo } from '../../net/lnurl.ts'
import { buildZapRequest, signEvent } from '../../core/nostr/index.ts'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const SK = new Uint8Array(32).fill(3)
const INFO: LnurlPayInfo = {
  callback: 'https://pay.example/cb', minSendable: 1000, maxSendable: 1e10, metadata: '[]', allowsNostr: true,
  nostrPubkey: 'ab'.repeat(32),
}
const zapRequest = signEvent(buildZapRequest({
  pubkey: bytesToHex(schnorr.getPublicKey(SK)), recipient: 'cd'.repeat(32), amountMsats: 1_000_000,
  relays: ['wss://relay.example'], createdAt: 1_789_430_400,
}), SK)

function provider(pr: string): string[] {
  const asked: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(String(input))
    return Response.json({ pr, routes: [] })
  }) as unknown as typeof fetch
  return asked
}

test('an invoice for the amount asked is passed on', async () => {
  // 10u is 10 micro-BTC: 1000 sats, 1,000,000 msats.
  provider('lnbc10u1pexample')
  expect(await requestZapInvoice({ info: INFO, amountMsats: 1_000_000, zapRequest })).toEqual({ ok: true, invoice: 'lnbc10u1pexample' })
})

test('an invoice with whitespace around it is passed on without it, as checked', async () => {
  // The page puts it in a QR code and hands it to the wallet, so whitespace would land in both.
  provider('  lnbc10u1pexample\n')
  expect(await requestZapInvoice({ info: INFO, amountMsats: 1_000_000, zapRequest })).toEqual({ ok: true, invoice: 'lnbc10u1pexample' })
  provider(' \n ')
  const r = await requestZapInvoice({ info: INFO, amountMsats: 1_000_000, zapRequest })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.reason).toBe('the provider returned no invoice')
})

test('an invoice for any other amount, or none, is refused', async () => {
  provider('lnbc10m1pexample') // A thousand times more.
  const r = await requestZapInvoice({ info: INFO, amountMsats: 1_000_000, zapRequest })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.reason).toMatch(/not the 1000000 asked for/)
  provider('lnbc1pexample') // No amount: the payer could be charged anything.
  expect((await requestZapInvoice({ info: INFO, amountMsats: 1_000_000, zapRequest })).ok).toBe(false)
})

test('a lightning address that starts with "http" is still an address', async () => {
  const asked = provider('')
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(String(input))
    return Response.json({ callback: 'https://getalby.com/cb', minSendable: 1000, maxSendable: 1e9, metadata: '[]' })
  }) as unknown as typeof fetch
  const r = await fetchLnurlPay('httpcat@getalby.com')
  expect(r.ok).toBe(true)
  expect(asked).toEqual(['https://getalby.com/.well-known/lnurlp/httpcat'])
  await fetchLnurlPay('https://pay.example/lnurlp/me')
  expect(asked[1]).toBe('https://pay.example/lnurlp/me')
})
