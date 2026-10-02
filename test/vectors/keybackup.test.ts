// Escrow key backups on the owner's own Nostr account, NIP-44 encrypted to itself (core/nostr/keybackup.ts).

import { test, expect, describe } from 'bun:test'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { signEvent } from '../../core/nostr/event.ts'
import { conversationKey, decrypt, encrypt } from '../../core/nostr/nip44.ts'
import {
  KEY_BACKUP_D_PREFIX, buildKeyBackup, draftBackupPlaintext, isKeyBackup, keyBackupFilter, keyBackupPlaintext, keyBackupSlot,
  parseDraftBackup, parseKeyBackup, type DraftBackup, type KeyBackup,
} from '../../core/nostr/keybackup.ts'
import { buildInvite, encodeInvite, type Invite } from '../../core/nostr/handshake.ts'
import { SITE_RULES } from '../../core/escrow/index.ts'
import { encodeRecovery } from '../../core/escrow/recovery.ts'
import { decide, isOurAddress } from '../../services/relay/policy.ts'

const NOSTR = new Uint8Array(32).fill(0x31)
const ME = bytesToHex(schnorr.getPublicKey(NOSTR))
const STRANGER = new Uint8Array(32).fill(0x32)
const ESCROW_KEY = new Uint8Array(32).fill(0x41)
const SELLER = new Uint8Array(32).fill(0x42)
const ARBITER = new Uint8Array(32).fill(0x43)
const ID = 'c6'.repeat(32)
const NOW = 1_791_000_000

const recovery = (binding = hexToBytes(ID)) => encodeRecovery({
  version: 1, secretKey: ESCROW_KEY, buyer: schnorr.getPublicKey(ESCROW_KEY), seller: schnorr.getPublicKey(SELLER),
  arbiter: schnorr.getPublicKey(ARBITER), timeoutTo: 'buyer', timeoutBlocks: 144, binding,
})
const backup = (over: Partial<KeyBackup> = {}): KeyBackup => ({
  v: 1, recovery: recovery(), id: ID, role: 'buyer', domain: 'anshuman.lol', amountSats: 10_000, network: 'signet', at: NOW, ...over,
})
const toSelf = (plaintext: string) => encrypt(plaintext, conversationKey(NOSTR, ME), new Uint8Array(32).fill(5))
const event = (content = toSelf(keyBackupPlaintext(backup()))) =>
  signEvent(buildKeyBackup({ pubkey: ME, slot: keyBackupSlot(ESCROW_KEY), ciphertext: content, createdAt: NOW }), NOSTR)

describe('the slot', () => {
  test('is the same for one escrow key every time, and differs between keys', () => {
    expect(keyBackupSlot(ESCROW_KEY)).toBe(keyBackupSlot(ESCROW_KEY))
    expect(keyBackupSlot(ESCROW_KEY)).toMatch(/^[0-9a-f]{32}$/)
    expect(keyBackupSlot(SELLER)).not.toBe(keyBackupSlot(ESCROW_KEY))
  })

  test('names neither the escrow nor its public keys', () => {
    const d = event().tags.find((t) => t[0] === 'd')![1]
    for (const visible of [ID, bytesToHex(schnorr.getPublicKey(ESCROW_KEY)), ME]) expect(d).not.toContain(visible.slice(0, 16))
    expect(event().content).not.toContain('anshuman')
  })
})

describe('a backup goes round', () => {
  test('only its author opens it, and gets back exactly what was backed up', () => {
    const e = event()
    expect(isKeyBackup(e)).toBe(true)
    const opened = parseKeyBackup(decrypt(e.content, conversationKey(NOSTR, e.pubkey)))
    expect(opened).toEqual({ ok: true, backup: backup() })
    expect(() => decrypt(e.content, conversationKey(STRANGER, e.pubkey))).toThrow()
  })

  test('the author finds their own backups with one filter', () => {
    expect(keyBackupFilter(ME)).toEqual({ kinds: [30078], authors: [ME], limit: 200 })
  })
})

describe('a backup that is not the key to its escrow is refused', () => {
  test('a recovery string bound to another escrow', () => {
    const wrong = backup({ recovery: recovery(hexToBytes('ab'.repeat(32))) })
    expect(parseKeyBackup(JSON.stringify(wrong))).toEqual({ ok: false, reason: "the recovery string isn't bound to this escrow id" })
    expect(() => keyBackupPlaintext(wrong)).toThrow()
  })

  test('anything malformed', () => {
    const bad: [string, unknown][] = [
      ['not JSON', '{'],
      ['not an object', '[]'],
      ['unknown backup version 2', { ...backup(), v: 2 }],
      ['the role is neither buyer nor seller', { ...backup(), role: 'arbiter' }],
      ['no escrow id', { ...backup(), id: 'C6'.repeat(32) }],
      ['no amount', { ...backup(), amountSats: 0 }],
      ['no domain', { ...backup(), domain: '' }],
    ]
    for (const [reason, value] of bad) {
      const out = parseKeyBackup(typeof value === 'string' ? value : JSON.stringify(value))
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.reason).toContain(reason)
    }
    const damaged = parseKeyBackup(JSON.stringify({ ...backup(), recovery: backup().recovery.slice(0, -2) + 'xx' }))
    expect(damaged.ok).toBe(false)
  })

  test('fields beyond the known ones are dropped, not carried', () => {
    const out = parseKeyBackup(JSON.stringify({ ...backup(), extra: '<script>' }))
    expect(out.ok && 'extra' in out.backup).toBe(false)
  })
})

describe('the outside of a backup', () => {
  test('never carries a key in the clear', () => {
    expect(() => buildKeyBackup({ pubkey: ME, slot: keyBackupSlot(ESCROW_KEY), ciphertext: keyBackupPlaintext(backup()), createdAt: NOW })).toThrow()
  })

  test("only our namespace, our two tags and an encrypted body of a backup's size count", () => {
    const e = event()
    expect(isKeyBackup({ ...e, tags: [['d', 'fmd:portfolio'], e.tags[1]] })).toBe(false)
    expect(isKeyBackup({ ...e, tags: [['d', `${KEY_BACKUP_D_PREFIX}XYZ`], e.tags[1]] })).toBe(false)
    expect(isKeyBackup({ ...e, tags: [e.tags[0]] })).toBe(false)
    expect(isKeyBackup({ ...e, tags: [...e.tags, ['p', ME]] })).toBe(false)
    expect(isKeyBackup({ ...e, tags: [e.tags[0], ['alt', 'something else']] })).toBe(false)
    expect(isKeyBackup({ ...e, content: 'hello' })).toBe(false)
    expect(isKeyBackup({ ...e, content: 'A'.repeat(4097) })).toBe(false)
    expect(isKeyBackup({ ...e, kind: 1 })).toBe(false)
    // A real one is far below the cap.
    expect(e.content.length).toBeLessThan(1500)
  })

  test("our relay keeps backups, refuses look-alikes, and counts their address as ours", () => {
    expect(decide(event())).toEqual({ action: 'accept' })
    const plain = signEvent({ ...buildKeyBackup({ pubkey: ME, slot: keyBackupSlot(ESCROW_KEY), ciphertext: event().content, createdAt: NOW }), content: '{"recovery":"fmdrec1"}' }, NOSTR)
    const verdict = decide(plain)
    expect(verdict.action).toBe('reject')
    expect(isOurAddress(`30078:${ME}:${KEY_BACKUP_D_PREFIX}${keyBackupSlot(ESCROW_KEY)}`)).toBe(true)
  })
})

describe("a draft: the opening side's key while its invite waits for a reply", () => {
  const RULES = SITE_RULES.signet
  const invite: Invite = {
    salt: 'ab'.repeat(32), domain: 'anshuman.lol', amountSats: 10_000, network: 'signet',
    timeoutBlocks: RULES.timeoutBlocks, deliverBlocks: RULES.deliverBlocks,
    arbiter: bytesToHex(schnorr.getPublicKey(ARBITER)), initiatorRole: 'buyer',
    initiatorKey: bytesToHex(schnorr.getPublicKey(ESCROW_KEY)),
    to: bytesToHex(schnorr.getPublicKey(STRANGER)),
  }
  const code = encodeInvite(signEvent(buildInvite(invite, { pubkey: ME, createdAt: NOW }), NOSTR))
  const draft = (over: Partial<DraftBackup> = {}): DraftBackup => ({
    v: 1, draft: true, invite: code, key: bytesToHex(ESCROW_KEY), role: 'buyer',
    domain: 'anshuman.lol', amountSats: 10_000, network: 'signet', at: NOW, ...over,
  })

  test("goes round like a backup, fits our relay, and sits where the escrow's backup will", () => {
    const e = signEvent(buildKeyBackup({ pubkey: ME, slot: keyBackupSlot(ESCROW_KEY), ciphertext: toSelf(draftBackupPlaintext(draft())), createdAt: NOW }), NOSTR)
    expect(isKeyBackup(e)).toBe(true)
    expect(e.content.length).toBeLessThan(4096)
    expect(parseDraftBackup(decrypt(e.content, conversationKey(NOSTR, ME)))).toEqual({ ok: true, draft: draft() })
    // Same key, same d: the escrow's backup replaces the draft once there is an escrow.
    expect(e.tags[0]).toEqual(event().tags[0])
  })

  test("an account an earlier draft carried is dropped, not carried", () => {
    const out = parseDraftBackup(JSON.stringify({ ...draft(), account: 'reoisback999' }))
    expect(out).toEqual({ ok: true, draft: draft() })
  })

  test('is never read as an escrow backup, nor the other way round', () => {
    expect(parseKeyBackup(draftBackupPlaintext(draft())).ok).toBe(false)
    expect(parseDraftBackup(keyBackupPlaintext(backup())).ok).toBe(false)
  })

  test("is refused unless it is the key to its own invite, on the invite's terms", () => {
    const bad: [string, Partial<DraftBackup>][] = [
      ["the key isn't the one the invite names", { key: bytesToHex(SELLER) }],
      ["the role isn't the invite's", { role: 'seller' }],
      ["the terms aren't the invite's", { amountSats: 20_000 }],
      ["the terms aren't the invite's", { domain: 'other.lol' }],
      ["the invite doesn't read", { invite: code.slice(0, -4) + 'AAAA' }],
    ]
    for (const [reason, over] of bad) {
      const out = parseDraftBackup(JSON.stringify(draft(over)))
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.reason).toContain(reason)
      expect(() => draftBackupPlaintext(draft(over))).toThrow()
    }
  })
})
