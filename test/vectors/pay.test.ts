// client/pay.ts: the payment link and QR code the escrow page shows the buyer.

import { test, expect, describe } from 'bun:test'
import { bech32 } from '@scure/base'
import { encode } from 'uqr'
import { INVOICE_OFFER_SECONDS, bip21, bolt11Expiry, btcAmount, invoiceOfferEnds, qrSvg } from '../../client/pay.ts'

describe('btcAmount writes sats as an exact BTC decimal', () => {
  const cases: [number | bigint, string][] = [
    [1, '0.00000001'],
    [10, '0.0000001'],
    [2000, '0.00002'],
    [10_000, '0.0001'],
    [123_456_789, '1.23456789'],
    [250_000_000, '2.5'],
    [100_000_000, '1'],
    [2_100_000_000_000_000n, '21000000'],
  ]
  for (const [sats, btc] of cases) {
    test(`${sats} sats is ${btc} BTC`, () => expect(btcAmount(sats)).toBe(btc))
  }

  test('never an exponent, a trailing zero or a float rounding', () => {
    for (let sats = 1; sats < 5000; sats += 7) {
      const text = btcAmount(sats)
      expect(text).toMatch(/^\d+(\.\d{0,7}[1-9])?$/)
      // Back to sats by string arithmetic, not by parsing a float.
      const [whole, frac = ''] = text.split('.')
      expect(BigInt(whole) * 100_000_000n + BigInt(frac.padEnd(8, '0'))).toBe(BigInt(sats))
    }
  })

  test('zero and negative amounts are refused', () => {
    expect(() => btcAmount(0)).toThrow()
    expect(() => btcAmount(-5)).toThrow()
  })
})

describe('bip21', () => {
  test('names the address and the exact amount', () => {
    expect(bip21('tb1pcycdy44maq9pxcw407jgz8neyqg624grzh22eme8qg5u7ff8n0sqf5taj9', 10_000))
      .toBe('bitcoin:tb1pcycdy44maq9pxcw407jgz8neyqg624grzh22eme8qg5u7ff8n0sqf5taj9?amount=0.0001')
  })

  test('refuses anything that could add its own parameters', () => {
    expect(() => bip21('tb1qxyz?amount=5', 10_000)).toThrow()
    expect(() => bip21('', 10_000)).toThrow()
  })
})

describe('qrSvg', () => {
  const text = 'bitcoin:tb1pcycdy44maq9pxcw407jgz8neyqg624grzh22eme8qg5u7ff8n0sqf5taj9?amount=0.0001'

  // The module grid, read back from the SVG path.
  function grid(svg: string): boolean[][] {
    const size = Number(svg.match(/viewBox="0 0 (\d+) \1"/)![1])
    const cells = Array.from({ length: size }, () => Array<boolean>(size).fill(false))
    for (const m of svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) cells[Number(m[2])][Number(m[1])] = true
    return cells
  }

  test('draws exactly the modules of the encoded symbol, with a four-module quiet zone', () => {
    const svg = qrSvg(text)
    const expected = encode(text, { ecc: 'M', border: 4 })
    expect(grid(svg)).toEqual(expected.data)
    const cells = grid(svg)
    const size = cells.length
    for (let i = 0; i < size; i++) {
      for (const j of [0, 1, 2, 3, size - 4, size - 3, size - 2, size - 1]) {
        expect(cells[i][j]).toBe(false)
        expect(cells[j][i]).toBe(false)
      }
    }
  })

  test('has the three finder patterns where scanners look for them', () => {
    const cells = grid(qrSvg(text))
    const size = cells.length
    const finder = (top: number, left: number) => {
      for (let y = 0; y < 7; y++) {
        for (let x = 0; x < 7; x++) {
          const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3))
          // Dark outer ring, light ring, dark 3x3 core.
          expect(cells[top + y][left + x]).toBe(ring !== 2)
        }
      }
    }
    finder(4, 4)
    finder(4, size - 11)
    finder(size - 11, 4)
  })

  test('is black on white whatever the page theme, and carries no script', () => {
    const svg = qrSvg(text, { label: 'Pay <script>' })
    expect(svg).toContain('fill="#fff"')
    expect(svg).toContain('fill="#000"')
    expect(svg).not.toMatch(/<script/i)
    expect(svg).toContain('aria-label="Pay script"')
  })
})

// BOLT 11's own examples, both made at 1496314658. The first asks to be paid within a minute.
const COFFEE = 'lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh'
const DONATION = 'lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql'

// A number as `count` five-bit words, most significant first.
const words5 = (value: number, count: number): number[] =>
  Array.from({ length: count }, (_, i) => Math.floor(value / 32 ** (count - 1 - i)) % 32)

// Invoice-shaped: timestamp, the given fields and a zero signature, with a valid checksum.
function invoiceWith(timestamp: number, fields: number[][]): string {
  return bech32.encode('lnbc100n', [...words5(timestamp, 7), ...fields.flat(), ...new Array(104).fill(0)], false)
}
const expiryField = (seconds: number, count: number) => [6, ...words5(count, 2), ...words5(seconds, count)]

describe('bolt11Expiry reads when an invoice stops being payable', () => {
  test("BOLT 11's coffee example expires a minute after it was made", () => {
    expect(bolt11Expiry(COFFEE)).toEqual({ createdAt: 1496314658, expiresAt: 1496314658 + 60 })
  })

  test('with no expiry field, the spec default of an hour', () => {
    expect(bolt11Expiry(DONATION)).toEqual({ createdAt: 1496314658, expiresAt: 1496314658 + 3600 })
  })

  test('the upper-case form a QR code carries reads the same', () => {
    expect(bolt11Expiry(COFFEE.toUpperCase())).toEqual(bolt11Expiry(COFFEE))
  })

  test('a 30-day expiry, as some providers set, is read in full', () => {
    const t = 1_790_000_000
    expect(bolt11Expiry(invoiceWith(t, [expiryField(2_592_000, 5)]))).toEqual({ createdAt: t, expiresAt: t + 2_592_000 })
  })

  test('anything else is unreadable, never a guessed time', () => {
    expect(bolt11Expiry('')).toBeUndefined()
    expect(bolt11Expiry('not an invoice')).toBeUndefined()
    // One character changed: the checksum no longer holds.
    expect(bolt11Expiry(COFFEE.slice(0, -1) + (COFFEE.endsWith('h') ? 'g' : 'h'))).toBeUndefined()
    // Too short to hold a timestamp and a signature.
    expect(bolt11Expiry(bech32.encode('lnbc', [1, 2, 3], false))).toBeUndefined()
    // A field that claims to run into the signature.
    expect(bolt11Expiry(invoiceWith(1_790_000_000, [[6, 31, 31, 1, 2]]))).toBeUndefined()
  })
})

describe('invoiceOfferEnds: how long a page offers an invoice', () => {
  const now = 1_800_000_000

  test('ten minutes, however long the provider would accept it', () => {
    expect(INVOICE_OFFER_SECONDS).toBe(600)
    expect(invoiceOfferEnds(invoiceWith(now, [expiryField(2_592_000, 5)]), now)).toBe(now + 600)
    expect(invoiceOfferEnds(DONATION, now)).toBe(now + 600)
  })

  test("never past the invoice's own lifetime", () => {
    expect(invoiceOfferEnds(COFFEE, now)).toBe(now + 60)
  })

  test("counted from when it arrived, so a clock that is off can't expire it early", () => {
    // The coffee invoice is from 2017 and still gets its minute from arrival.
    expect(invoiceOfferEnds(COFFEE, now) - now).toBe(60)
  })

  test('an invoice that can not be read gets the ten minutes', () => {
    expect(invoiceOfferEnds('lnbc-unreadable', now)).toBe(now + 600)
  })
})
