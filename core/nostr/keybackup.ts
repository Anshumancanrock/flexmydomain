import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { decodeRecovery } from '../escrow/recovery.js'
import { isHex32, type NostrEvent, type UnsignedEvent } from './event.js'
import { decodeInvite } from './handshake.js'

export const KEY_BACKUP_KIND = 30078
export const KEY_BACKUP_D_PREFIX = 'fmd:key:'
export const KEY_BACKUP_VERSION = 1

/** The plaintext, before NIP-44. */
export interface KeyBackup {
  v: 1
  recovery: string
  id: string
  role: 'buyer' | 'seller'
  domain: string
  amountSats: number
  network: string
  at: number
}

const SLOT_TAG = utf8ToBytes('fmd/key-backup-slot')
const SLOT = /^[0-9a-f]{32}$/
const ALT = 'An encrypted flexmydomain escrow key backup'
// A NIP-44 v2 payload is base64 of at least 132 characters (NIP-44, "Decryption").
const PAYLOAD = /^[A-Za-z0-9+/]+={0,2}$/
const MAX_PAYLOAD = 4096

export function keyBackupSlot(escrowSecret: Uint8Array): string {
  if (escrowSecret.length !== 32) throw new Error('keyBackupSlot: an escrow key is 32 bytes')
  return bytesToHex(sha256(concatBytes(SLOT_TAG, escrowSecret))).slice(0, 32)
}

export function keyBackupPlaintext(backup: KeyBackup): string {
  const problem = backupProblem(backup)
  if (problem) throw new Error(`keyBackupPlaintext: ${problem}`)
  const { v, recovery, id, role, domain, amountSats, network, at } = backup
  return JSON.stringify({ v, recovery, id, role, domain, amountSats, network, at })
}

export function buildKeyBackup(params: { pubkey: string; slot: string; ciphertext: string; createdAt: number }): UnsignedEvent {
  if (!isHex32(params.pubkey)) throw new Error('buildKeyBackup: pubkey must be 64 lowercase hex characters')
  if (!SLOT.test(params.slot)) throw new Error('buildKeyBackup: the slot must be 32 lowercase hex characters')
  if (!looksEncrypted(params.ciphertext)) throw new Error('buildKeyBackup: the content must be a NIP-44 payload')
  return {
    pubkey: params.pubkey,
    created_at: params.createdAt,
    kind: KEY_BACKUP_KIND,
    tags: [
      ['d', KEY_BACKUP_D_PREFIX + params.slot],
      // NIP-31, for clients that show events they don't know.
      ['alt', ALT],
    ],
    content: params.ciphertext,
  }
}

const looksEncrypted = (content: unknown): content is string =>
  typeof content === 'string' && content.length >= 132 && content.length <= MAX_PAYLOAD && PAYLOAD.test(content)

export function isKeyBackup(event: NostrEvent): boolean {
  if (event.kind !== KEY_BACKUP_KIND || !Array.isArray(event.tags) || event.tags.length !== 2) return false
  const [d, alt] = event.tags
  return d?.length === 2 && d[0] === 'd' && typeof d[1] === 'string' && d[1].startsWith(KEY_BACKUP_D_PREFIX) &&
    SLOT.test(d[1].slice(KEY_BACKUP_D_PREFIX.length)) &&
    alt?.length === 2 && alt[0] === 'alt' && alt[1] === ALT &&
    looksEncrypted(event.content)
}

export function keyBackupFilter(pubkey: string): Record<string, unknown> {
  return { kinds: [KEY_BACKUP_KIND], authors: [pubkey], limit: 200 }
}

function backupProblem(b: Partial<KeyBackup>): string | undefined {
  if (b.v !== KEY_BACKUP_VERSION) return `unknown backup version ${String(b.v)}`
  if (typeof b.recovery !== 'string') return 'no recovery string'
  if (typeof b.id !== 'string' || !/^[0-9a-f]{64}$/.test(b.id)) return 'no escrow id'
  if (b.role !== 'buyer' && b.role !== 'seller') return 'the role is neither buyer nor seller'
  if (typeof b.domain !== 'string' || b.domain.length === 0 || b.domain.length > 253) return 'no domain'
  if (!Number.isSafeInteger(b.amountSats) || (b.amountSats as number) <= 0) return 'no amount'
  if (typeof b.network !== 'string' || !/^[a-z]{1,16}$/.test(b.network)) return 'no network'
  if (!Number.isSafeInteger(b.at) || (b.at as number) < 0) return 'no time'
  const decoded = decodeRecovery(b.recovery)
  if (!decoded.ok) return `the recovery string doesn't read: ${decoded.reason}`
  // The string must be the key to this very escrow, or the list would open the wrong one.
  const binding = decoded.recovery.binding
  if (!binding || bytesToHex(binding) !== b.id) return "the recovery string isn't bound to this escrow id"
  return undefined
}

/** A decrypted backup, checked field by field. Anything malformed is refused, never half-read. */
export function parseKeyBackup(plaintext: string): { ok: true; backup: KeyBackup } | { ok: false; reason: string } {
  let raw: unknown
  try {
    raw = JSON.parse(plaintext)
  } catch {
    return { ok: false, reason: 'not JSON' }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'not an object' }
  const b = raw as Partial<KeyBackup>
  const problem = backupProblem(b)
  if (problem) return { ok: false, reason: problem }
  return {
    ok: true,
    backup: { v: 1, recovery: b.recovery!, id: b.id!, role: b.role!, domain: b.domain!, amountSats: b.amountSats!, network: b.network!, at: b.at! },
  }
}

/** The opening side's key while its invite waits for a reply. Plaintext, before NIP-44. */
export interface DraftBackup {
  v: 1
  draft: true
  invite: string
  key: string
  role: 'buyer' | 'seller'
  domain: string
  amountSats: number
  network: string
  at: number
}

function draftProblem(d: Partial<DraftBackup>): string | undefined {
  if (d.v !== KEY_BACKUP_VERSION) return `unknown backup version ${String(d.v)}`
  if (d.draft !== true) return 'not a draft'
  if (typeof d.key !== 'string' || !/^[0-9a-f]{64}$/.test(d.key)) return 'no key'
  let pubkey: string
  try {
    pubkey = bytesToHex(schnorr.getPublicKey(hexToBytes(d.key)))
  } catch {
    return 'the key is not a valid key'
  }
  const invite = decodeInvite(d.invite)
  if (!invite.ok) return `the invite doesn't read: ${invite.reason}`
  const i = invite.invite
  // The draft must be the key to this very invite, on its terms, or it would continue the wrong one.
  if (i.initiatorKey !== pubkey) return "the key isn't the one the invite names"
  if (d.role !== i.initiatorRole) return "the role isn't the invite's"
  if (d.domain !== i.domain || d.amountSats !== i.amountSats || d.network !== i.network) return "the terms aren't the invite's"
  if (!Number.isSafeInteger(d.at) || (d.at as number) < 0) return 'no time'
  return undefined
}

export function draftBackupPlaintext(draft: DraftBackup): string {
  const problem = draftProblem(draft)
  if (problem) throw new Error(`draftBackupPlaintext: ${problem}`)
  const { v, invite, key, role, domain, amountSats, network, at } = draft
  return JSON.stringify({ v, draft: true, invite, key, role, domain, amountSats, network, at })
}

export function parseDraftBackup(plaintext: string): { ok: true; draft: DraftBackup } | { ok: false; reason: string } {
  let raw: unknown
  try {
    raw = JSON.parse(plaintext)
  } catch {
    return { ok: false, reason: 'not JSON' }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'not an object' }
  const d = raw as Partial<DraftBackup>
  const problem = draftProblem(d)
  if (problem) return { ok: false, reason: problem }
  return {
    ok: true,
    draft: { v: 1, draft: true, invite: d.invite!, key: d.key!, role: d.role!, domain: d.domain!, amountSats: d.amountSats!, network: d.network!, at: d.at! },
  }
}
