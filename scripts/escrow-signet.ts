#!/usr/bin/env bun
/**
 * Run an escrow end to end on a public test network.
 *
 * Derives the address, waits for you to fund it from a faucet, then builds,
 * signs and broadcasts the settlement through the public Esplora API, with no
 * flexmydomain server in the path.
 *
 *   bun scripts/escrow-signet.ts new                      # make an escrow
 *   bun scripts/escrow-signet.ts watch  <recovery>        # wait for funding
 *   bun scripts/escrow-signet.ts settle <recovery> <addr> # cooperative spend
 *   bun scripts/escrow-signet.ts sweep  <recovery> <addr> # timeout spend
 *
 * `--network signet|testnet|mainnet` (default signet). Signet is the default
 * because its faucets work, its blocks are regular, and it is not deliberately
 * reorged the way testnet periodically is.
 *
 * The keys this prints are real private keys. On signet they guard play
 * money, but do not reuse them anywhere that matters, and do not paste the
 * recovery string into anything but web/recover.html.
 */

import { schnorr } from '@noble/curves/secp256k1.js'
import {
  buildTree,
  decodeRecovery,
  encodeRecovery,
  feeOf,
  rebuildFromRecovery,
  spendWith,
  buildSpend,
  type NetworkName,
} from '../core/escrow/index.js'
import { chainApi, findFunding } from '../net/chain.js'

const argv = process.argv.slice(2)
const command = argv[0]
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? undefined : argv[i + 1]
}

const network = (flag('network') ?? 'signet') as NetworkName
const timeoutBlocks = Number(flag('timeout') ?? 144)
const api = chainApi(network)

/** Decode a bech32m address to a scriptPubKey. Only v1 (taproot) is accepted. */
function addressToScript(address: string): Uint8Array {
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
  const lower = address.toLowerCase()
  const split = lower.lastIndexOf('1')
  if (split < 1) throw new Error(`${address} is not a bech32 address`)
  const data: number[] = []
  for (const ch of lower.slice(split + 1)) {
    const v = CHARSET.indexOf(ch)
    if (v === -1) throw new Error(`${address} contains a character bech32 does not use`)
    data.push(v)
  }
  const values = data.slice(0, -6)
  if (values[0] !== 1) throw new Error('only taproot (v1) destinations are supported')
  let acc = 0
  let bits = 0
  const out: number[] = []
  for (const v of values.slice(1)) {
    acc = (acc << 5) | v
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((acc >> bits) & 0xff)
    }
  }
  if (out.length !== 32) throw new Error('a taproot address carries a 32-byte program')
  return new Uint8Array([0x51, 0x20, ...out])
}

function loadRecovery(text: string | undefined) {
  if (!text) throw new Error('pass the recovery string')
  const parsed = decodeRecovery(text)
  if (!parsed.ok) throw new Error(parsed.reason)
  return parsed.recovery
}

async function cmdNew(): Promise<void> {
  /* Fresh keys, not derived from a Nostr key: a NIP-07 signer never exposes
     its private key, so there is nothing stable to derive from. They are
     generated here and handed to the user to write down. */
  const buyerSk = schnorr.utils.randomSecretKey()
  const sellerSk = schnorr.utils.randomSecretKey()

  const tree = buildTree({
    buyer: schnorr.getPublicKey(buyerSk),
    seller: schnorr.getPublicKey(sellerSk),
    timeoutTo: 'buyer',
    timeoutBlocks,
  })

  const address = tree.addresses[network]
  console.log(`\nescrow on ${network}`)
  console.log(`  shape          ${tree.shape}`)
  console.log(`  address        ${address}`)
  console.log(`  timeout        ${timeoutBlocks} blocks, pays the buyer`)
  console.log(`  explorer       ${api.explorer}/address/${address}\n`)

  for (const [role, sk] of [['buyer', buyerSk], ['seller', sellerSk]] as const) {
    console.log(`  ${role} recovery string (WRITE THIS DOWN: it holds a private key)`)
    console.log(
      `    ${encodeRecovery({
        version: 1,
        secretKey: sk,
        buyer: schnorr.getPublicKey(buyerSk),
        seller: schnorr.getPublicKey(sellerSk),
        timeoutTo: 'buyer',
        timeoutBlocks,
      })}\n`,
    )
  }

  console.log(`  Fund it, then: bun scripts/escrow-signet.ts watch <buyer recovery>`)
  if (network === 'signet') console.log(`  Faucet: https://signetfaucet.com or https://alt.signetfaucet.com\n`)
}

async function cmdWatch(): Promise<void> {
  const recovery = loadRecovery(argv[1])
  const { tree, role } = rebuildFromRecovery(recovery)
  const address = tree.addresses[network]
  const required = BigInt(flag('amount') ?? '10000')

  console.log(`watching ${address} (${network}) for at least ${required} sats`)
  console.log(`you are the ${role}\n`)

  for (;;) {
    const [utxos, tip] = await Promise.all([api.utxos(address).catch(() => []), api.tipHeight().catch(() => undefined)])
    const found = findFunding(utxos, required, 1, tip)

    if (found.funded) {
      console.log(`FUNDED  ${found.utxo.txid}:${found.utxo.vout}  ${found.utxo.valueSats} sats`)
      console.log(`\nrecovery string with the funding recorded:\n`)
      console.log(
        `  ${encodeRecovery({
          ...recovery,
          funding: { txid: found.utxo.txid, vout: found.utxo.vout, amountSats: found.utxo.valueSats },
        })}\n`,
      )
      console.log(`  settle: bun scripts/escrow-signet.ts settle <that string> <destination address>`)
      return
    }

    console.log(`${new Date().toISOString()}  not yet: ${found.reason}`)
    await new Promise((r) => setTimeout(r, 20_000))
  }
}

async function cmdSpend(leafName: 'A' | 'D'): Promise<void> {
  const recovery = loadRecovery(argv[1])
  const destination = argv[2]
  if (!destination) throw new Error('pass a destination address')
  if (!recovery.funding) throw new Error('this recovery string has no funding outpoint; run `watch` first')

  const { tree, role } = rebuildFromRecovery(recovery)
  const leaf = leafName === 'A' ? tree.leaves.A : tree.leaves.D
  const scriptPubKey = addressToScript(destination)

  /* Leaf A needs both parties' signatures, so this path works only when one
     process holds both keys, as it does in a signet test. In production each
     party signs separately and they exchange 64-byte signatures, using
     sighashFor and finaliseSpend. */
  const secretKeys: Record<string, Uint8Array> = { [role]: recovery.secretKey }
  const other = flag('other')
  if (other) {
    const otherRecovery = loadRecovery(other)
    const rebuilt = rebuildFromRecovery(otherRecovery)
    secretKeys[rebuilt.role] = otherRecovery.secretKey
  }

  const missing = leaf.signatureOrder.filter((r) => !secretKeys[r])
  if (missing.length) {
    throw new Error(
      `leaf ${leaf.name} needs the ${missing.join(' and ')} key; pass it with --other <their recovery string>`,
    )
  }

  const feeRate = await api.feeRate()
  const probe = buildSpend({
    tree,
    leaf,
    outpoint: recovery.funding,
    destinations: [{ scriptPubKey, amountSats: recovery.funding.amountSats - 1000n }],
  })
  const estimate = feeOf(probe, false, leaf)
  const fee = BigInt(Math.max(300, Math.ceil(estimate.vbytes * feeRate)))

  const signed = spendWith({
    tree,
    leaf,
    outpoint: recovery.funding,
    destinations: [{ scriptPubKey, amountSats: recovery.funding.amountSats - fee }],
    secretKeys,
  })

  console.log(`\nleaf ${leaf.name}  ${signed.vbytes} vbytes  fee ${fee} sats at ${feeRate} sat/vB`)
  console.log(`txid ${signed.txid}\n`)

  if (argv.includes('--dry-run')) {
    console.log(signed.hex)
    return
  }

  const result = await api.broadcast(signed.hex)
  if (result.ok) {
    console.log(`BROADCAST  ${api.explorer}/tx/${result.txid}`)
  } else {
    console.error(`REJECTED   ${result.reason}`)
    console.error(`\nraw hex, if you want to try elsewhere:\n${signed.hex}`)
    process.exit(1)
  }
}

try {
  if (command === 'new') await cmdNew()
  else if (command === 'watch') await cmdWatch()
  else if (command === 'settle') await cmdSpend('A')
  else if (command === 'sweep') await cmdSpend('D')
  else {
    console.log('commands: new | watch <recovery> | settle <recovery> <addr> | sweep <recovery> <addr>')
    console.log('flags:    --network signet|testnet|mainnet  --timeout <blocks>  --amount <sats>')
    console.log('          --other <recovery>   (the counterparty key, for a cooperative settle)')
    console.log('          --dry-run            (print the hex, do not broadcast)')
    process.exit(1)
  }
} catch (err) {
  console.error((err as Error).message)
  process.exit(1)
}
