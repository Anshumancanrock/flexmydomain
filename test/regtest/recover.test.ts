/**
 * recover.html, end to end.
 *
 * Fund a real escrow on regtest, mine past its timelock, hand the recovery
 * string to the page in a browser, and broadcast whatever hex it prints.
 *
 * This checks the claim that a user can get their money back with the server
 * off. Every other test could pass with this page broken; here Bitcoin Core
 * decides whether the sweep is valid.
 */

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
    // Nothing that could reach a host: no fetch, no XHR, no dynamic import,
    // no remote script, stylesheet, image or font.
    expect(html).not.toMatch(/\bfetch\s*\(/)
    expect(html).not.toMatch(/XMLHttpRequest/)
    expect(html).not.toMatch(/<script[^>]+src=/i)
    expect(html).not.toMatch(/<link[^>]+href=/i)
    expect(html).not.toMatch(/https?:\/\/[a-z]/i)
  })

  async function sweepViaPage(withFunding: boolean) {
    // --- a real escrow, funded on chain -----------------------------------
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

    // The one string the user was told to write down.
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

    // The timelock has to have elapsed, or the sweep is valid but unminable.
    await wallet.mine(TIMEOUT_BLOCKS)

    const destination = await wallet.address
    const info = await node.rpc<{ scriptPubKey: string }>('getaddressinfo', [destination])
    // Sweep to a taproot address, which is what the page's decoder supports.
    const taproot = await node.rpc<string>('getnewaddress', ['', 'bech32m'])
    void info

    // --- drive the page in a real browser ---------------------------------
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
        // The page is loaded from file:// on purpose: that is what is tested.
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

    // --- Bitcoin Core accepts the sweep -----------------------------------
    const txid = await node.rpc<string>('sendrawtransaction', [result.raw])
    expect(txid).toMatch(/^[0-9a-f]{64}$/)
  }

  test.skipIf(!haveBitcoind)('sweeps a real escrow when the string records the funding', async () => {
    await sweepViaPage(true)
  }, 180_000)

  test.skipIf(!haveBitcoind)('sweeps a real escrow from the string users save, issued before funding', async () => {
    // The string is issued when the escrow is created, before anybody pays it,
    // so it has no funding outpoint. The page must still get the money out:
    // the user reads the outpoint off an explorer and types it in.
    await sweepViaPage(false)
  }, 180_000)
})
