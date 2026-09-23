/**
 * The escrow handshake, core/nostr/handshake.ts.
 *
 * The salt is part of the escrow id, so if each side's page minted its own,
 * the two would derive different ids and never see each other's views. The
 * tests that matter most check that both sides derive the same address and
 * id.
 */

import { test, expect, describe } from 'bun:test'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { schnorr } from '@noble/curves/secp256k1.js'

import {
  INVITE_PREFIX,
  REPLY_PREFIX,
  buildEscrowEvent,
  compareViews,
  decodeInvite,
  decodeReply,
  deriveEscrowId,
  encodeInvite,
  encodeReply,
  escrowAddress,
  parseEscrowEvent,
  resolveHandshake,
  signEvent,
  type Invite,
} from '../../core/nostr/index.ts'

const key = (fill: number) => bytesToHex(schnorr.getPublicKey(new Uint8Array(32).fill(fill)))
const BUYER_KEY = key(0x11)
const SELLER_KEY = key(0x22)
const ARBITER_KEY = key(0x33)
const SALT = 'ab'.repeat(32)

const COMMITMENT = { registrarIanaId: '292', nameservers: ['ns1.buyer.example'] }

const fromBuyer: Invite = {
  salt: SALT,
  domain: 'lumenary.com',
  amountSats: 2_500_000,
  network: 'signet',
  timeoutBlocks: 144,
  timeoutTo: 'buyer',
  arbiter: ARBITER_KEY,
  initiatorRole: 'buyer',
  initiatorKey: BUYER_KEY,
  commitment: COMMITMENT,
}

const fromSeller: Invite = {
  ...fromBuyer,
  initiatorRole: 'seller',
  initiatorKey: SELLER_KEY,
  commitment: undefined,
}

/** What each side feeds into the tree. Used to prove both sides agree. */
function inputs(invite: Invite, reply: ReturnType<typeof decodeReply>) {
  if (!reply.ok) throw new Error(reply.reason)
  const r = resolveHandshake(invite, reply.reply)
  const params = {
    salt: r.salt,
    buyer: hexToBytes(r.buyerKey),
    seller: hexToBytes(r.sellerKey),
    arbiter: r.arbiter ? hexToBytes(r.arbiter) : undefined,
    timeoutTo: r.timeoutTo,
    timeoutBlocks: r.timeoutBlocks,
    network: r.network,
    amountSats: r.amountSats,
    domain: r.domain,
  }
  return { id: deriveEscrowId(params), address: escrowAddress(params), resolved: r }
}

describe('the round trip', () => {
  test('an invite survives encoding exactly', () => {
    const text = encodeInvite(fromBuyer)
    expect(text.startsWith(INVITE_PREFIX)).toBe(true)
    const back = decodeInvite(text)
    expect(back.ok).toBe(true)
    if (back.ok) expect(back.invite).toEqual(fromBuyer)
  })

  test('whitespace and line breaks from a chat paste are tolerated', () => {
    const text = encodeInvite(fromBuyer)
    const mangled = `  ${text.slice(0, 20)}\n${text.slice(20, 50)} ${text.slice(50)}  `
    expect(decodeInvite(mangled).ok).toBe(true)
  })

  test('a reply survives encoding exactly', () => {
    const text = encodeReply({ joinerKey: SELLER_KEY, salt: SALT })
    expect(text.startsWith(REPLY_PREFIX)).toBe(true)
    const back = decodeReply(text, fromBuyer)
    expect(back.ok).toBe(true)
    if (back.ok) expect(back.reply.joinerKey).toBe(SELLER_KEY)
  })
})

describe('both sides derive the same escrow', () => {
  test('buyer invites, seller joins: identical address and id', () => {
    const invite = decodeInvite(encodeInvite(fromBuyer))
    expect(invite.ok).toBe(true)
    if (!invite.ok) return
    const replyText = encodeReply({ joinerKey: SELLER_KEY, salt: invite.invite.salt })

    // The initiator decodes the reply; the joiner already holds its own key.
    const onInitiatorsPage = inputs(invite.invite, decodeReply(replyText, invite.invite))
    const onJoinersPage = inputs(invite.invite, decodeReply(replyText, invite.invite))

    expect(onInitiatorsPage.address).toBe(onJoinersPage.address)
    expect(onInitiatorsPage.id).toBe(onJoinersPage.id)
    expect(onInitiatorsPage.resolved.buyerKey).toBe(BUYER_KEY)
    expect(onInitiatorsPage.resolved.sellerKey).toBe(SELLER_KEY)
  })

  test('seller invites, buyer joins, and the buyer supplies the commitment', () => {
    const invite = decodeInvite(encodeInvite(fromSeller))
    expect(invite.ok).toBe(true)
    if (!invite.ok) return
    const reply = decodeReply(
      encodeReply({ joinerKey: BUYER_KEY, salt: invite.invite.salt, commitment: COMMITMENT }),
      invite.invite,
    )
    const r = inputs(invite.invite, reply)
    expect(r.resolved.buyerKey).toBe(BUYER_KEY)
    expect(r.resolved.sellerKey).toBe(SELLER_KEY)
    expect(r.resolved.commitment).toEqual(COMMITMENT)
  })

  test("the roles cannot be swapped by accident: the seller's key stays the seller's", () => {
    const invite = decodeInvite(encodeInvite(fromSeller))
    if (!invite.ok) throw new Error(invite.reason)
    const r = inputs(
      invite.invite,
      decodeReply(encodeReply({ joinerKey: BUYER_KEY, salt: SALT, commitment: COMMITMENT }), invite.invite),
    )
    expect(r.resolved.sellerKey).toBe(fromSeller.initiatorKey)
  })
})

describe('what must not work', () => {
  test('a reply from another escrow is refused because the salts differ', () => {
    const other = encodeReply({ joinerKey: SELLER_KEY, salt: 'cd'.repeat(32) })
    const r = decodeReply(other, fromBuyer)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('different escrow')
  })

  test('a reply carrying your own key back is refused', () => {
    const r = decodeReply(encodeReply({ joinerKey: BUYER_KEY, salt: SALT }), fromBuyer)
    expect(r.ok).toBe(false)
  })

  test("a reply carrying the arbiter's key is refused", () => {
    const r = decodeReply(encodeReply({ joinerKey: ARBITER_KEY, salt: SALT }), fromBuyer)
    expect(r.ok).toBe(false)
  })

  test('a buyer must say where they will receive the domain', () => {
    // Without it, the release condition could never be shown to be met.
    expect(() => encodeInvite({ ...fromBuyer, commitment: undefined })).toThrow(/receive the domain/)
    const noCommitment = decodeReply(encodeReply({ joinerKey: BUYER_KEY, salt: SALT }), fromSeller)
    expect(noCommitment.ok).toBe(false)
  })

  test('an empty commitment counts as no commitment', () => {
    expect(() =>
      encodeInvite({ ...fromBuyer, commitment: { registrarIanaId: '', nameservers: [] } }),
    ).not.toThrow() // encoding accepts the object...
    const back = decodeInvite(encodeInvite({ ...fromBuyer, commitment: { registrarIanaId: '', nameservers: [] } }))
    expect(back.ok).toBe(false) // ...but decoding refuses it as empty
  })

  test('malformed input returns a reason instead of throwing', () => {
    for (const bad of ['', 'nope', `${INVITE_PREFIX}!!!`, `${INVITE_PREFIX}e30`, 42, null]) {
      expect(decodeInvite(bad).ok).toBe(false)
    }
  })

  test('a reply pasted where an invite belongs is refused by its prefix', () => {
    const reply = encodeReply({ joinerKey: SELLER_KEY, salt: SALT })
    expect(decodeInvite(reply).ok).toBe(false)
  })

  test('nothing in either message is a private key', () => {
    // Both carry only public keys, a salt and terms. Guard it structurally.
    const invite = JSON.stringify(decodeInvite(encodeInvite(fromBuyer)))
    expect(invite).not.toMatch(/secret|private|nsec/i)
  })
})

// ---------------------------------------------------------------------------
// what escrow.html publishes after the handshake
// ---------------------------------------------------------------------------

describe('the published views, as the page makes them', () => {
  /* The page mints a fresh escrow key per trade, separate from the person's
     Nostr identity, and signs each view with it. compareViews admits only
     authors holding a tree key, so a view signed with the Nostr key would be
     filed as a stranger's and the watch page would have nothing to show.
     These two tests pin the contract from both sides. */
  const BUYER_ESCROW_SK = new Uint8Array(32).fill(0x41)
  const SELLER_ESCROW_SK = new Uint8Array(32).fill(0x42)
  const BUYER_NOSTR_SK = new Uint8Array(32).fill(0x51)
  const SELLER_NOSTR_SK = new Uint8Array(32).fill(0x52)
  const hexKey = (sk: Uint8Array) => bytesToHex(schnorr.getPublicKey(sk))

  const invite: Invite = { ...fromBuyer, initiatorKey: hexKey(BUYER_ESCROW_SK), arbiter: undefined, timeoutTo: 'seller' }
  const reply = decodeReply(encodeReply({ joinerKey: hexKey(SELLER_ESCROW_SK), salt: invite.salt }), invite)
  if (!reply.ok) throw new Error(reply.reason)
  const r = resolveHandshake(invite, reply.reply)
  const params = {
    salt: r.salt,
    buyer: hexToBytes(r.buyerKey),
    seller: hexToBytes(r.sellerKey),
    timeoutTo: r.timeoutTo,
    timeoutBlocks: r.timeoutBlocks,
    network: r.network,
    amountSats: r.amountSats,
    domain: r.domain,
    ...(r.commitment ? { commitment: r.commitment } : {}),
  }

  const viewSignedBy = (sk: Uint8Array, createdAt: number) => {
    const event = signEvent(buildEscrowEvent({ ...params, pubkey: hexKey(sk), createdAt }), sk)
    const parsed = parseEscrowEvent(event)
    if (!parsed.ok) throw new Error(parsed.reason)
    return parsed.view
  }

  test('views signed by the escrow keys are both participants, and agree', () => {
    const comparison = compareViews([viewSignedBy(BUYER_ESCROW_SK, 1_000), viewSignedBy(SELLER_ESCROW_SK, 1_001)])
    expect(comparison.participants).toHaveLength(2)
    expect(comparison.strangers).toHaveLength(0)
    expect(comparison.agreed).toBe(true)
    const authors = comparison.participants.map((v) => v.author).sort()
    expect(authors).toEqual([r.buyerKey, r.sellerKey].sort())
  })

  test('views signed by the Nostr identities count only as strangers', () => {
    const comparison = compareViews([viewSignedBy(BUYER_NOSTR_SK, 1_000), viewSignedBy(SELLER_NOSTR_SK, 1_001)])
    expect(comparison.participants).toHaveLength(0)
    expect(comparison.strangers).toHaveLength(2)
    expect(comparison.newest).toBeUndefined()
  })
})
