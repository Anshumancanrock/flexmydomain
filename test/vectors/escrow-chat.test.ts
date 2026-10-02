// Escrow chats over NIP-17 (core/nostr/escrow-chat.ts), and the NIP-42 login some relays require (net/relay.ts).

import { test, expect, describe, afterEach } from 'bun:test'
import { bytesToHex } from '@noble/hashes/utils.js'
import { schnorr } from '@noble/curves/secp256k1.js'

import {
  AUTH_KIND,
  CHAT_CARD_TAG,
  CHAT_KIND,
  ESCROW_CHAT_TAG,
  MAX_CHAT_LENGTH,
  buildAuthEvent,
  buildEscrowMessage,
  buildRumor,
  cardProblem,
  chatPartners,
  chatRoleOf,
  dmRelaysOf,
  escrowChats,
  giftWrap,
  giftWrapFilter,
  giftWrapWith,
  keyOfRole,
  latestCard,
  signEvent,
  unwrap,
  unwrapWith,
  type ChatCard,
  type EscrowParties,
  type NostrEvent,
  type Signer,
} from '../../core/nostr/index.ts'
import { readMessages, readMessagesWith, wrapForEach, wrapForEachWith } from '../../client/messages.ts'
import { localSigner } from '../../client/signer.ts'
import { publishToRelays, queryRelays, type RelayAuth } from '../../net/relay.ts'
import { startRelay, type TestRelay } from '../harness/relay.ts'

const key = (fill: number) => {
  const sk = new Uint8Array(32).fill(fill)
  return { sk, pk: bytesToHex(schnorr.getPublicKey(sk)) }
}
type Key = ReturnType<typeof key>
const BUYER = key(0x11)
const SELLER = key(0x22)
const ARBITER = key(0x33)
const MALLORY = key(0x44)
const NOW = 1_789_430_400
const PARTIES: EscrowParties = { id: 'ab'.repeat(32), buyer: BUYER.pk, seller: SELLER.pk, arbiter: ARBITER.pk }

const TO: ChatCard = { kind: 'transfer-to', registrar: 'Namecheap', account: 'buyer_77', email: 'buyer@example.com' }
const CODE: ChatCard = { kind: 'transfer-sent', method: 'code', code: 'Xy9#auth-CODE', note: 'unlocked today' }

const entropy = (n: number) => ({
  ephemeralSecretKey: new Uint8Array(32).fill(0x60 + n),
  sealNonce: new Uint8Array(32).fill(n),
  wrapNonce: new Uint8Array(32).fill(n + 1),
  sealCreatedAt: NOW - 100 * n,
  wrapCreatedAt: NOW - 200 * n,
})

// As a party's page sends it: one rumor, wrapped for the recipient and for the author.
const send = (from: Key, to: Key, content: string, at = NOW, card?: ChatCard) => {
  const rumor = buildEscrowMessage({ parties: PARTIES, sender: from.pk, recipient: to.pk, content, createdAt: at, card })
  return wrapForEach(rumor, from.sk, [to.pk, from.pk], at)
}
const chatsOf = (who: Key, wraps: NostrEvent[]) => escrowChats(readMessages(wraps, who.sk).messages, PARTIES, who.pk)
const texts = (who: Key, wraps: NostrEvent[], partner: 'buyer' | 'seller' | 'arbiter') =>
  (chatsOf(who, wraps).get(partner) ?? []).map((m) => `${m.from}: ${m.text}`)

describe('who talks to whom', () => {
  test('each role has a chat with each of the other two', () => {
    expect(chatPartners('buyer')).toEqual(['seller', 'arbiter'])
    expect(chatPartners('seller')).toEqual(['buyer', 'arbiter'])
    expect(chatPartners('arbiter')).toEqual(['buyer', 'seller'])
  })

  test("a key's role, and a role's key, come from the escrow's own three", () => {
    expect(chatRoleOf(PARTIES, SELLER.pk)).toBe('seller')
    expect(chatRoleOf(PARTIES, MALLORY.pk)).toBeUndefined()
    expect(keyOfRole(PARTIES, 'arbiter')).toBe(ARBITER.pk)
  })
})

describe('a message', () => {
  test('is a kind 14 rumor naming exactly one recipient and, inside the encryption, the escrow', () => {
    const rumor = buildEscrowMessage({ parties: PARTIES, sender: SELLER.pk, recipient: BUYER.pk, content: '  sent it  ', createdAt: NOW })
    expect(rumor.kind).toBe(CHAT_KIND)
    expect(rumor.pubkey).toBe(SELLER.pk)
    expect(rumor.content).toBe('sent it')
    expect(rumor.tags.filter((t) => t[0] === 'p')).toEqual([['p', BUYER.pk]])
    expect(rumor.tags).toContainEqual([ESCROW_CHAT_TAG, PARTIES.id])
    expect(rumor.tags.find((t) => t[0] === 'subject')?.[1]).toContain(PARTIES.id.slice(0, 12))
  })

  test('only goes from one of the escrow keys to one of the other two, and is neither empty nor too long', () => {
    const build = (over: Partial<Parameters<typeof buildEscrowMessage>[0]>) =>
      () => buildEscrowMessage({ parties: PARTIES, sender: BUYER.pk, recipient: SELLER.pk, content: 'hi', createdAt: NOW, ...over })
    expect(build({ sender: MALLORY.pk })).toThrow(/own keys/)
    expect(build({ recipient: MALLORY.pk })).toThrow(/other two keys/)
    expect(build({ recipient: BUYER.pk })).toThrow(/other two keys/)
    expect(build({ content: '   ' })).toThrow(/empty/)
    expect(build({ content: 'x'.repeat(MAX_CHAT_LENGTH + 1) })).toThrow(/at most/)
    expect(build({ parties: { ...PARTIES, seller: BUYER.pk } })).toThrow(/differ/)
  })
})

describe('the chats', () => {
  const wraps = [
    ...send(BUYER, SELLER, 'funded', NOW),
    ...send(SELLER, BUYER, 'sent it', NOW + 60),
    ...send(BUYER, ARBITER, 'nothing arrived', NOW + 120),
    ...send(ARBITER, BUYER, 'show me your domain list', NOW + 180),
    ...send(SELLER, ARBITER, 'I pushed it on Monday', NOW + 240),
  ]

  test('each side of a pair reads the same chat, its own messages included, oldest first', () => {
    expect(texts(BUYER, wraps, 'seller')).toEqual(['buyer: funded', 'seller: sent it'])
    expect(texts(SELLER, wraps, 'buyer')).toEqual(['buyer: funded', 'seller: sent it'])
    expect(texts(BUYER, wraps, 'arbiter')).toEqual(['buyer: nothing arrived', 'arbiter: show me your domain list'])
    expect(texts(ARBITER, wraps, 'buyer')).toEqual(['buyer: nothing arrived', 'arbiter: show me your domain list'])
    expect(texts(SELLER, wraps, 'arbiter')).toEqual(['seller: I pushed it on Monday'])
    expect(texts(ARBITER, wraps, 'seller')).toEqual(['seller: I pushed it on Monday'])
  })

  test("the arbiter can't read a word the buyer and the seller say to each other", () => {
    const opened = readMessages(wraps, ARBITER.sk).messages.map((m) => m.rumor.content)
    expect(opened).not.toContain('funded')
    expect(opened).not.toContain('sent it')
    expect([...chatsOf(ARBITER, wraps).keys()]).toEqual(['buyer', 'seller'])
  })

  test("neither party reads the other's chat with the arbiter", () => {
    const seller = readMessages(wraps, SELLER.sk).messages.map((m) => m.rumor.content)
    expect(seller).not.toContain('nothing arrived')
    expect(seller).not.toContain('show me your domain list')
    const buyer = readMessages(wraps, BUYER.sk).messages.map((m) => m.rumor.content)
    expect(buyer).not.toContain('I pushed it on Monday')
  })

  test('nobody outside the escrow can read any of it', () => {
    expect(readMessages(wraps, MALLORY.sk).messages).toEqual([])
  })

  test('each copy names only its own recipient on the outside, and the outside names no escrow', () => {
    for (const wrap of wraps) {
      expect(wrap.tags).toHaveLength(1)
      expect(wrap.tags[0][0]).toBe('p')
      expect(JSON.stringify(wrap)).not.toContain(PARTIES.id)
      expect([BUYER.pk, SELLER.pk, ARBITER.pk]).not.toContain(wrap.pubkey)
    }
  })

  test('a message shows once, however many copies of it arrive', () => {
    expect(chatsOf(BUYER, [...wraps, ...wraps]).get('seller')).toHaveLength(2)
  })

  test("an outsider can't write into a chat, even naming the right keys and escrow", () => {
    const rumor = buildRumor({ pubkey: MALLORY.pk, recipient: BUYER.pk, content: 'pay me instead', createdAt: NOW,
      tags: [[ESCROW_CHAT_TAG, PARTIES.id]] })
    const forged = giftWrap({ rumor, senderSecretKey: MALLORY.sk, recipient: BUYER.pk, entropy: entropy(5) })
    expect(readMessages([forged], BUYER.sk).messages).toHaveLength(1)
    expect(chatsOf(BUYER, [forged]).get('seller')).toEqual([])
    expect(chatsOf(BUYER, [forged]).get('arbiter')).toEqual([])
  })

  test('a message for another escrow, to no one, to two at once, or naming two escrows is not part of this one', () => {
    const other = buildEscrowMessage({ parties: { ...PARTIES, id: 'cd'.repeat(32) }, sender: SELLER.pk, recipient: BUYER.pk, content: 'elsewhere', createdAt: NOW })
    const nobody = { ...buildRumor({ pubkey: SELLER.pk, recipient: BUYER.pk, content: 'to nobody', createdAt: NOW, tags: [[ESCROW_CHAT_TAG, PARTIES.id]] }) }
    nobody.tags = nobody.tags.filter((t) => t[0] !== 'p')
    // Like the old three-way thread, it names both other keys, so it is in neither pair's chat.
    const both = buildRumor({ pubkey: SELLER.pk, recipient: BUYER.pk, content: 'to you both', createdAt: NOW,
      tags: [['p', ARBITER.pk], [ESCROW_CHAT_TAG, PARTIES.id]] })
    const twice = buildRumor({ pubkey: SELLER.pk, recipient: BUYER.pk, content: 'two ids', createdAt: NOW,
      tags: [[ESCROW_CHAT_TAG, PARTIES.id], [ESCROW_CHAT_TAG, 'cd'.repeat(32)]] })
    const copies = [other, nobody, both, twice].map((rumor, n) => giftWrap({ rumor, senderSecretKey: SELLER.sk, recipient: BUYER.pk, entropy: entropy(n + 1) }))
    expect(chatsOf(BUYER, copies).get('seller')).toEqual([])
  })

  test("a reader who isn't one of the escrow's keys has no chats", () => {
    expect(escrowChats(readMessages(wraps, BUYER.sk).messages, PARTIES, MALLORY.pk).size).toBe(0)
  })
})

describe('cards', () => {
  test('the buyer tells the seller where to transfer the domain, and the seller tells the buyer how it was sent', () => {
    const wraps = [...send(BUYER, SELLER, 'please transfer it here', NOW, TO), ...send(SELLER, BUYER, 'the code', NOW + 60, CODE)]
    const chat = chatsOf(SELLER, wraps).get('buyer')!
    expect(chat.map((m) => m.card)).toEqual([TO, CODE])
    expect(chat[1].text).toBe('the code')
    expect(latestCard(chat, 'transfer-to')).toEqual(TO)
    expect(latestCard(chat, 'transfer-sent')).toEqual(CODE)
    // The card is inside the encryption, in its own tag.
    const rumor = buildEscrowMessage({ parties: PARTIES, sender: BUYER.pk, recipient: SELLER.pk, content: 'x', createdAt: NOW, card: TO })
    expect(JSON.parse(rumor.tags.find((t) => t[0] === CHAT_CARD_TAG)![1])).toEqual(TO)
    for (const wrap of wraps) expect(JSON.stringify(wrap)).not.toContain('buyer_77')
  })

  test('the newest card of a kind is the one that counts', () => {
    const fresh: ChatCard = { ...TO, account: 'buyer_78' }
    const chat = chatsOf(SELLER, [...send(BUYER, SELLER, 'here', NOW, TO), ...send(BUYER, SELLER, 'no, here', NOW + 60, fresh)]).get('buyer')!
    expect(latestCard(chat, 'transfer-to')).toEqual(fresh)
    expect(latestCard(chat, 'transfer-sent')).toBeUndefined()
  })

  test('a card goes only between the buyer and the seller, each its own kind', () => {
    const card = (sender: Key, recipient: Key, c: ChatCard) =>
      () => buildEscrowMessage({ parties: PARTIES, sender: sender.pk, recipient: recipient.pk, content: 'x', createdAt: NOW, card: c })
    expect(card(SELLER, BUYER, TO)).toThrow(/only the buyer/)
    expect(card(BUYER, ARBITER, TO)).toThrow(/only the buyer/)
    expect(card(BUYER, SELLER, CODE)).toThrow(/only the seller/)
    expect(card(SELLER, ARBITER, CODE)).toThrow(/only the seller/)
  })

  test('a card is checked field by field', () => {
    expect(cardProblem(TO, 'buyer', 'seller')).toBeUndefined()
    expect(cardProblem({ ...TO, account: '  ' }, 'buyer', 'seller')).toMatch(/account is empty/)
    expect(cardProblem({ ...TO, registrar: '', email: '' }, 'buyer', 'seller')).toBeUndefined()
    expect(cardProblem({ ...TO, email: 'x'.repeat(255) }, 'buyer', 'seller')).toMatch(/at most 254/)
    expect(cardProblem({ ...CODE, code: '' }, 'seller', 'buyer')).toMatch(/code is empty/)
    expect(cardProblem({ kind: 'transfer-sent', method: 'push', code: '', note: '' }, 'seller', 'buyer')).toBeUndefined()
    expect(cardProblem({ ...CODE, method: 'fax' }, 'seller', 'buyer')).toMatch(/push or code/)
    expect(cardProblem({ ...CODE, code: 'x'.repeat(501) }, 'seller', 'buyer')).toMatch(/at most 500/)
    expect(cardProblem({ kind: 'payout', to: 'bc1q' }, 'seller', 'buyer')).toBe('unknown card')
    for (const bad of [null, 'card', [TO]]) expect(cardProblem(bad, 'buyer', 'seller')).toBe('a card is an object')
  })

  test('a field that hides characters, or changes how it reads, is refused; a note may break lines', () => {
    for (const account of ['buyer\u202e77', 'buyer\u200b77', 'buyer\n77', 'buyer\u000077', '\ufeffbuyer']) {
      expect(cardProblem({ ...TO, account }, 'buyer', 'seller')).toMatch(/account has hidden characters/)
    }
    expect(cardProblem({ ...CODE, code: 'Xy9\u2066AUTH' }, 'seller', 'buyer')).toMatch(/code has hidden characters/)
    expect(cardProblem({ ...CODE, note: 'line one\nline two' }, 'seller', 'buyer')).toBeUndefined()
    expect(cardProblem({ ...CODE, note: 'flip \u202e here' }, 'seller', 'buyer')).toMatch(/note has hidden characters/)
    expect(cardProblem({ ...TO, account: 'bùyer.77+fmd@例え.jp' }, 'buyer', 'seller')).toBeUndefined()
  })

  test('a card that does not check out is dropped, and its message still shows', () => {
    const rumor = buildRumor({ pubkey: SELLER.pk, recipient: BUYER.pk, content: 'here is where to send it', createdAt: NOW,
      tags: [[ESCROW_CHAT_TAG, PARTIES.id], [CHAT_CARD_TAG, JSON.stringify(TO)]] })
    const broken = buildRumor({ pubkey: SELLER.pk, recipient: BUYER.pk, content: 'not JSON', createdAt: NOW + 1,
      tags: [[ESCROW_CHAT_TAG, PARTIES.id], [CHAT_CARD_TAG, '{']] })
    const copies = [rumor, broken].map((r, n) => giftWrap({ rumor: r, senderSecretKey: SELLER.sk, recipient: BUYER.pk, entropy: entropy(n + 1) }))
    const chat = chatsOf(BUYER, copies).get('seller')!
    expect(chat.map((m) => m.text)).toEqual(['here is where to send it', 'not JSON'])
    expect(chat.every((m) => m.card === undefined)).toBe(true)
  })
})

describe('sealing through a signer that keeps its key', () => {
  const signer = localSigner(SELLER.sk)

  test('a local signer encrypts both ways, like the core NIP-44', async () => {
    const ciphertext = await signer.nip44!.encrypt(BUYER.pk, 'hello')
    expect(await localSigner(BUYER.sk).nip44!.decrypt(SELLER.pk, ciphertext)).toBe('hello')
  })

  test('a wrap sealed through the signer opens with the plain key, and the other way round', async () => {
    const rumor = buildEscrowMessage({ parties: PARTIES, sender: SELLER.pk, recipient: BUYER.pk, content: 'through the signer', createdAt: NOW })
    const [wrap] = await wrapForEachWith(rumor, signer, [BUYER.pk], NOW)
    const plain = unwrap(wrap, BUYER.sk)
    expect(plain.ok && plain.rumor.content).toBe('through the signer')
    const viaSigner = await unwrapWith(wrap, (peer, payload) => localSigner(BUYER.sk).nip44!.decrypt(peer, payload))
    expect(viaSigner.ok && viaSigner.sender).toBe(SELLER.pk)
    const read = await readMessagesWith([wrap], localSigner(BUYER.sk))
    expect(read.messages.map((m) => m.rumor.content)).toEqual(['through the signer'])
  })

  test("a signer can't seal a rumor that names another author, or return a seal that doesn't verify", async () => {
    const rumor = buildEscrowMessage({ parties: PARTIES, sender: BUYER.pk, recipient: ARBITER.pk, content: 'not mine', createdAt: NOW })
    await expect(giftWrapWith({ rumor, signer, recipient: ARBITER.pk, entropy: entropy(1) })).rejects.toThrow(/other than the signing key/)
    const lying: Signer = { ...signer, signEvent: async (u) => ({ ...(await signer.signEvent(u)), sig: '00'.repeat(64) }) }
    const own = buildEscrowMessage({ parties: PARTIES, sender: SELLER.pk, recipient: ARBITER.pk, content: 'mine', createdAt: NOW })
    await expect(giftWrapWith({ rumor: own, signer: lying, recipient: ARBITER.pk, entropy: entropy(2) })).rejects.toThrow(/does not verify/)
    const mute: Signer = { getPublicKey: signer.getPublicKey, signEvent: signer.signEvent }
    await expect(giftWrapWith({ rumor: own, signer: mute, recipient: ARBITER.pk, entropy: entropy(3) })).rejects.toThrow(/cannot encrypt/)
  })
})

describe('NIP-42', () => {
  test('the AUTH event names the relay and its challenge, and nothing else', () => {
    const event = buildAuthEvent({ relay: 'wss://relay.example.com', challenge: 'abc', pubkey: BUYER.pk, createdAt: NOW })
    expect(event).toEqual({ pubkey: BUYER.pk, created_at: NOW, kind: AUTH_KIND, tags: [['relay', 'wss://relay.example.com'], ['challenge', 'abc']], content: '' })
    expect(() => buildAuthEvent({ relay: 'wss://r', challenge: '', pubkey: BUYER.pk, createdAt: NOW })).toThrow(/challenge/)
    expect(() => buildAuthEvent({ relay: 'https://r', challenge: 'x', pubkey: BUYER.pk, createdAt: NOW })).toThrow(/websocket/)
  })

  const open: TestRelay[] = []
  const relay = (opts: Parameters<typeof startRelay>[0]) => { const r = startRelay(opts); open.push(r); return r }
  afterEach(() => { for (const r of open.splice(0)) r.close() })
  const authAs = (who: Key): RelayAuth => async (url, challenge) =>
    signEvent(buildAuthEvent({ relay: url, challenge, pubkey: who.pk, createdAt: NOW }), who.sk)

  test('a relay that serves gift wraps only after login gives nothing to a reader who declines', async () => {
    const r = relay({ requireAuth: true, events: send(SELLER, BUYER, 'sent it') })
    const done: boolean[] = []
    const wraps = await queryRelays([r.url], [giftWrapFilter(BUYER.pk)], { timeoutMs: 3000, onRelayDone: (_u, _c, _e, complete) => done.push(!!complete) })
    expect(wraps).toEqual([])
    expect(done).toEqual([false])
  })

  test("after signing in, a key gets its own gift wraps and nobody else's", async () => {
    const r = relay({ requireAuth: true, events: [...send(SELLER, BUYER, 'sent it', NOW), ...send(ARBITER, BUYER, 'got it', NOW + 60)] })
    const wraps = await queryRelays([r.url], [giftWrapFilter(BUYER.pk)], { timeoutMs: 3000, auth: authAs(BUYER) })
    expect(texts(BUYER, wraps, 'seller')).toEqual(['seller: sent it'])
    expect(texts(BUYER, wraps, 'arbiter')).toEqual(['arbiter: got it'])
    const theirs = await queryRelays([r.url], [giftWrapFilter(ARBITER.pk)], { timeoutMs: 3000, auth: authAs(BUYER) })
    expect(theirs).toEqual([])
  })

  test('a publish refused until login goes through once the key signs in, and only then', async () => {
    const r = relay({ requireAuthToWrite: true })
    const [wrap] = send(BUYER, SELLER, 'funded')
    expect((await publishToRelays([r.url], wrap, { timeoutMs: 3000 }))[0]).toMatchObject({ ok: false, message: expect.stringMatching(/^auth-required:/) })
    expect((await publishToRelays([r.url], wrap, { timeoutMs: 3000, auth: authAs(BUYER) }))[0].ok).toBe(true)
    expect(r.published.map((e) => e.id)).toEqual([wrap.id])
  })
})

test('a NIP-17 relay list gives its relays, normalised and once each', () => {
  const list = signEvent({ pubkey: ARBITER.pk, created_at: NOW, kind: 10050, content: '',
    tags: [['relay', 'wss://inbox.example.com/'], ['relay', 'wss://inbox.example.com'], ['relay', 'https://not-a-relay'], ['relay', 'wss://two.example.com']] }, ARBITER.sk)
  expect(dmRelaysOf(list)).toEqual(['wss://inbox.example.com', 'wss://two.example.com'])
})
