/**
 * Payout address decoding. Every settlement and sweep pays an address someone
 * pasted, and decoding it is the last chance to catch a mistake, so the
 * checksum is always verified and anything that cannot be vouched for is
 * refused:
 *
 *   bech32   (BIP-173)  witness v0: P2WPKH `bc1q…` (20 bytes), P2WSH (32 bytes)
 *   bech32m  (BIP-350)  witness v1: P2TR `bc1p…` (32 bytes)
 *   base58check         P2PKH `1…` / `m…` `n…`, P2SH `3…` / `2…`
 *
 * Without the checksum, a one-character typo decodes to a valid-looking script
 * that pays a program nobody holds a key for.
 *
 * The witness version decides the checksum: v0 must be bech32 and v1 bech32m.
 * A v1 program under a bech32 checksum reopens the length-extension weakness
 * BIP-350 was written to close, so it is refused.
 *
 * Witness versions 2 to 16 decode but are refused: they are valid on the
 * network today, and anyone can spend an output paid to one until a soft fork
 * defines them.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bech32, bech32m, createBase58check } from '@scure/base'
import { NETWORK_HRP, type NetworkName } from './tree.js'

export type AddressType = 'p2pkh' | 'p2sh' | 'p2wpkh' | 'p2wsh' | 'p2tr'

/**
 * Which chain an address string belongs to.
 *
 * `test` covers testnet and signet (and regtest's base58 forms): they share
 * the `tb` prefix and the base58 version bytes, so an address string alone
 * cannot say which of them it is for.
 */
export type AddressChain = 'mainnet' | 'test' | 'regtest'

export interface DecodedAddress {
  type: AddressType
  chain: AddressChain
  scriptPubKey: Uint8Array
}

const base58check = createBase58check(sha256)

/** Base58 version bytes. Regtest reuses the test ones. */
const BASE58_VERSIONS: Readonly<Record<number, { type: 'p2pkh' | 'p2sh'; chain: 'mainnet' | 'test' }>> = {
  0x00: { type: 'p2pkh', chain: 'mainnet' },
  0x05: { type: 'p2sh', chain: 'mainnet' },
  0x6f: { type: 'p2pkh', chain: 'test' },
  0xc4: { type: 'p2sh', chain: 'test' },
}

const HRP_CHAIN: Readonly<Record<string, AddressChain>> = { bc: 'mainnet', tb: 'test', bcrt: 'regtest' }

/**
 * Wallets hand out `bitcoin:` URIs as often as bare addresses, and a person
 * pastes whichever the button copied. Take the address out of either.
 */
function stripUri(input: string): string {
  let s = input.trim()
  if (/^bitcoin:/i.test(s)) s = s.slice('bitcoin:'.length)
  const query = s.indexOf('?')
  return query === -1 ? s : s.slice(0, query)
}

function decodeSegwit(address: string): DecodedAddress | undefined {
  // Both checksums are tried; at most one can pass for a given string.
  const asBech32 = bech32.decodeUnsafe(address, 90)
  const asBech32m = bech32m.decodeUnsafe(address, 90)
  const decoded = asBech32 ?? asBech32m
  if (!decoded) return undefined

  const chain = HRP_CHAIN[decoded.prefix]
  if (!chain) throw new Error(`"${decoded.prefix}1…" is not a bitcoin address prefix; expected bc1, tb1 or bcrt1.`)

  const [version, ...rest] = decoded.words
  if (version === undefined || version > 16) throw new Error('That address has no valid witness version.')

  const program = bech32.fromWordsUnsafe(rest)
  if (!program) throw new Error('That address has invalid padding, so it is corrupt or mistyped.')

  if (version === 0) {
    if (!asBech32) throw new Error('A version 0 address must use the bech32 checksum; this one uses bech32m.')
    if (program.length === 20) return { type: 'p2wpkh', chain, scriptPubKey: new Uint8Array([0x00, 0x14, ...program]) }
    if (program.length === 32) return { type: 'p2wsh', chain, scriptPubKey: new Uint8Array([0x00, 0x20, ...program]) }
    throw new Error(`A version 0 program is 20 or 32 bytes; this one is ${program.length}.`)
  }

  if (!asBech32m) throw new Error('A version 1+ address must use the bech32m checksum (BIP-350); this one uses bech32.')
  if (version === 1) {
    if (program.length !== 32) throw new Error(`A taproot program is 32 bytes; this one is ${program.length}.`)
    return { type: 'p2tr', chain, scriptPubKey: new Uint8Array([0x51, 0x20, ...program]) }
  }
  throw new Error(
    `Witness version ${version} is not defined yet, so anyone could spend a payment to it. Use a bc1q or bc1p address.`,
  )
}

function decodeBase58(address: string): DecodedAddress | undefined {
  let payload: Uint8Array
  try {
    payload = base58check.decode(address)
  } catch {
    return undefined
  }
  if (payload.length !== 21) throw new Error('That base58 address does not carry a 20-byte hash.')
  const kind = BASE58_VERSIONS[payload[0]]
  if (!kind) throw new Error(`Base58 version byte 0x${payload[0].toString(16).padStart(2, '0')} is not a bitcoin address.`)
  const hash = payload.slice(1)
  const scriptPubKey =
    kind.type === 'p2pkh'
      ? new Uint8Array([0x76, 0xa9, 0x14, ...hash, 0x88, 0xac])
      : new Uint8Array([0xa9, 0x14, ...hash, 0x87])
  return { type: kind.type, chain: kind.chain, scriptPubKey }
}

/**
 * Decode any standard bitcoin address, checksum verified. Throws with a reason
 * a person can act on, and never returns a script it could not vouch for.
 */
export function decodeAddress(input: string): DecodedAddress {
  const address = stripUri(String(input))
  if (!address) throw new Error('Enter an address.')

  const segwit = decodeSegwit(address)
  if (segwit) return segwit

  const legacy = decodeBase58(address)
  if (legacy) return legacy

  // Neither checksum passed. Say which family it looked like, so the fix is obvious.
  if (/^(bc|tb|bcrt)1/i.test(address)) {
    throw new Error('That address fails its checksum: a character is wrong or missing. Copy it again from your wallet.')
  }
  throw new Error('That is not a bitcoin address this page can verify. Copy it again from your wallet.')
}

/** Which address chain a network's addresses belong to. */
export function chainOf(network: NetworkName): AddressChain {
  return network === 'mainnet' ? 'mainnet' : network === 'regtest' ? 'regtest' : 'test'
}

/**
 * The scriptPubKey to pay, for an address that must belong to `network`.
 *
 * A mainnet address on a test network, or the reverse, is refused: the program
 * would decode fine and the payment would land somewhere the person's wallet
 * is not looking.
 */
export function addressToScript(input: string, network: NetworkName): Uint8Array {
  const decoded = decodeAddress(input)
  // Regtest's base58 forms share the test version bytes, so for base58 on
  // regtest "test" is the only answer the string can give.
  const want = chainOf(network)
  const ok =
    decoded.chain === want ||
    (want === 'regtest' && (decoded.type === 'p2pkh' || decoded.type === 'p2sh') && decoded.chain === 'test')
  if (!ok) {
    const prefix = NETWORK_HRP[network]
    throw new Error(
      `That is a ${decoded.chain === 'test' ? 'test-network' : decoded.chain} address, and this escrow is on ${network}. ` +
        `Use an address from a ${network} wallet (${prefix}1…).`,
    )
  }
  return decoded.scriptPubKey
}
