// recover.html end to end. Fund a regtest escrow, pass its timelock, run the page in headless
// Chrome and broadcast what it prints. Proves users can sweep with our server off.

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { spawnSync } from 'node:child_process'
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildTree, encodeRecovery } from '../../core/escrow/index.ts'
import { haveBitcoind, startRegtest, fundedWallet, type RegtestNode } from './node.ts'

const secret = (fill: number) => new Uint8Array(32).fill(fill)
const xonly = (sk: Uint8Array) => schnorr.getPublicKey(sk)

const BUYER = secret(0xa1)
const SELLER = secret(0xa2)
const TIMEOUT_BLOCKS = 12
const PORT = 18997

let node: RegtestNode
let wallet: Awaited<ReturnType<typeof fundedWallet>>

beforeAll(async () => {
  if (!haveBitcoind) return
  node = await startRegtest(PORT)
  wallet = await fundedWallet(node, 'recover', PORT)
}, 60_000)

afterAll(async () => {
  await node?.stop()
})

describe('recover.html', () => {
  test('makes no network requests at all', async () => {
    const html = await Bun.file('web/recover.html').text()
    expect(html).not.toMatch(/\bfetch\s*\(/)
    expect(html).not.toMatch(/XMLHttpRequest/)
    expect(html).not.toMatch(/<script[^>]+src=/i)
    expect(html).not.toMatch(/<link[^>]+href=/i)
    expect(html).not.toMatch(/https?:\/\/[a-z]/i)
  })

  async function sweepViaPage(withFunding: boolean) {
    const tree = buildTree({
      buyer: xonly(BUYER),
      seller: xonly(SELLER),
      timeoutTo: 'buyer',
      timeoutBlocks: TIMEOUT_BLOCKS,
    })

    const fundingTxid = await wallet.send(tree.addresses.regtest, 0.01)
    await wallet.mine(1)

    const raw = await node.rpc<{ vout: { n: number; scriptPubKey: { hex: string } }[] }>('getrawtransaction', [
      fundingTxid,
      true,
    ])
    const vout = raw.vout.find((o) => o.scriptPubKey.hex === bytesToHex(tree.scriptPubKey))
    expect(vout).toBeTruthy()

    // The string the user writes down.
    const recovery = encodeRecovery({
      version: 1,
      secretKey: BUYER,
      buyer: xonly(BUYER),
      seller: xonly(SELLER),
      timeoutTo: 'buyer',
      timeoutBlocks: TIMEOUT_BLOCKS,
      ...(withFunding
        ? { funding: { txid: fundingTxid, vout: (vout as { n: number }).n, amountSats: 1_000_000n } }
        : {}),
    })

    // Before the timelock the sweep is valid but can't be mined.
    await wallet.mine(TIMEOUT_BLOCKS)

    const destination = await wallet.address
    const info = await node.rpc<{ scriptPubKey: string }>('getaddressinfo', [destination])
    // Taproot, since that's what the page's address decoder supports.
    const taproot = await node.rpc<string>('getnewaddress', ['', 'bech32m'])
    void info

    const dir = mkdtempSync(join(tmpdir(), 'fmd-recover-'))
    const driver = join(dir, 'drive.html')
    const page = join(process.cwd(), 'web/recover.html')

    writeFileSync(
      driver,
      `<!doctype html><meta charset="utf-8"><body><pre id="out">running</pre>
<iframe id="f" src="file://${page}" style="width:900px;height:600px"></iframe>
<script>
const f = document.getElementById("f");
f.onload = () => setTimeout(() => {
  const d = f.contentDocument;
  d.getElementById("rec").value = ${JSON.stringify(recovery)};
  d.getElementById("load").click();
  setTimeout(() => {
    if (!${withFunding}) {
      d.getElementById("fTxid").value = ${JSON.stringify(fundingTxid)};
      d.getElementById("fVout").value = "${(vout as { n: number }).n}";
      d.getElementById("fAmount").value = "1000000";
      d.getElementById("useFunding").click();
    }
    d.getElementById("dest").value = ${JSON.stringify(taproot)};
    d.getElementById("fee").value = "2000";
    d.getElementById("build").click();
    setTimeout(() => {
      document.getElementById("out").textContent = JSON.stringify({
        loadMsg: d.getElementById("loadMsg").textContent,
        sweepMsg: d.getElementById("sweepMsg").textContent,
        raw: d.getElementById("raw").textContent,
      });
    }, 400);
  }, 400);
}, 300);
</script>`,
    )

    const chrome = spawnSync(
      'google-chrome',
      [
        '--headless',
        '--disable-gpu',
        '--no-sandbox',
        // file:// is the case under test.
        '--allow-file-access-from-files',
        `--user-data-dir=${join(dir, 'profile')}`,
        '--virtual-time-budget=8000',
        '--dump-dom',
        `file://${driver}`,
      ],
      { encoding: 'utf8', timeout: 90_000 },
    )

    const match = /<pre id="out">(.*?)<\/pre>/s.exec(chrome.stdout ?? '')
    expect(match).toBeTruthy()

    const result = JSON.parse((match as RegExpExecArray)[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')) as {
      loadMsg: string
      sweepMsg: string
      raw: string
    }

    rmSync(dir, { recursive: true, force: true })

    expect(result.loadMsg).toContain('Rebuilt')
    expect(result.sweepMsg).toContain('Signed')
    expect(result.raw).toMatch(/^[0-9a-f]+$/)

    const txid = await node.rpc<string>('sendrawtransaction', [result.raw])
    expect(txid).toMatch(/^[0-9a-f]{64}$/)
  }

  test.skipIf(!haveBitcoind)('sweeps a real escrow when the string records the funding', async () => {
    await sweepViaPage(true)
  }, 180_000)

  test.skipIf(!haveBitcoind)('sweeps a real escrow from the string users save, issued before funding', async () => {
    // Issued at creation, before funding, so it has no outpoint. The user types
    // it in from an explorer.
    await sweepViaPage(false)
  }, 180_000)
})
