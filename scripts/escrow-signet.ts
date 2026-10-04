#!/usr/bin/env bun

import { schnorr } from '@noble/curves/secp256k1.js'
import {
  addressToScript,
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
if (!['mainnet', 'testnet', 'signet', 'regtest'].includes(network)) {
  console.error(`unknown network ${JSON.stringify(network)}: use signet, testnet, mainnet or regtest`)
  process.exit(1)
}
const timeoutBlocks = Number(flag('timeout') ?? 144)
const api = chainApi(network)

/** Past this the fee API is broken or lying. `--fee-rate` sets one by hand. */
const MAX_FEE_RATE = 500

function loadRecovery(text: string | undefined) {
  if (!text) throw new Error('pass the recovery string')
  const parsed = decodeRecovery(text)
  if (!parsed.ok) throw new Error(parsed.reason)
  return parsed.recovery
}

async function cmdNew(): Promise<void> {
  // Fresh keys. A NIP-07 signer never exposes its secret, so there's nothing to derive from.
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
  const scriptPubKey = addressToScript(destination, network)

  // Leaf A needs both signatures, so this only works when one process holds both keys (a signet test).
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

  const feeRate = flag('fee-rate') !== undefined ? Number(flag('fee-rate')) : await api.feeRate()
  if (!Number.isFinite(feeRate) || feeRate <= 0) throw new Error('--fee-rate is sats per vbyte, above zero')
  if (feeRate > MAX_FEE_RATE && flag('fee-rate') === undefined) {
    throw new Error(`the fee API says ${feeRate} sat/vB, which is not believable; pass --fee-rate to choose one`)
  }
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
  console.log(`pays ${recovery.funding.amountSats - fee} sats to ${destination} (${network})`)
  console.log(`txid ${signed.txid}\n`)

  if (argv.includes('--dry-run')) {
    console.log(signed.hex)
    return
  }
  if (!argv.includes('--yes') && prompt('Broadcast it? [y/N]')?.trim().toLowerCase() !== 'y') {
    console.log(`Not broadcast. The raw hex, if you want it later:\n${signed.hex}`)
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
    console.log('flags:    --network signet|testnet|mainnet|regtest  --timeout <blocks>  --amount <sats>')
    console.log('          --other <recovery>   (the counterparty key, for a cooperative settle)')
    console.log('          --fee-rate <sat/vB>  (instead of asking the fee API)')
    console.log('          --dry-run            (print the hex, do not broadcast)')
    console.log('          --yes                (broadcast without asking)')
    process.exit(1)
  }
} catch (err) {
  console.error((err as Error).message)
  process.exit(1)
}
