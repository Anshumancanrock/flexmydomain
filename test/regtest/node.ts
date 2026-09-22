/**
 * A throwaway Bitcoin Core regtest node, for the end-to-end tests.
 *
 * Starts bitcoind in a temporary datadir, talks to it over JSON-RPC, and tears
 * it down afterwards. No wallet state survives a run, and nothing here touches
 * a network or a real chain.
 *
 * The differential tests compare two implementations with each other; Bitcoin
 * Core checks the spends against the consensus rules themselves.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BITCOIND = join(process.cwd(), 'tools/bitcoin-31.1/bin/bitcoind')

/**
 * Bitcoin Core is downloaded per machine (tools/ is not in git), so a fresh
 * clone has none. The tests that need a node are then skipped, and say why,
 * rather than failing after half a minute of waiting for one.
 */
export const haveBitcoind = existsSync(BITCOIND)
if (!haveBitcoind) {
  console.warn(`test/regtest: no Bitcoin Core at ${BITCOIND}; the tests that need a node are skipped (see spec/VERIFY.md)`)
}

export interface RegtestNode {
  rpc<T = unknown>(method: string, params?: unknown[]): Promise<T>
  stop(): Promise<void>
  datadir: string
}

const USER = 'fmd'
const PASS = 'fmd-regtest-throwaway'

/** Start a node and wait until it answers. */
export async function startRegtest(port = 18999): Promise<RegtestNode> {
  const datadir = mkdtempSync(join(tmpdir(), 'fmd-regtest-'))
  mkdirSync(join(datadir, 'regtest'), { recursive: true })
  writeFileSync(
    join(datadir, 'bitcoin.conf'),
    [
      'regtest=1',
      'server=1',
      // The funding transaction is mined before the tests look it up, so it is
      // out of the mempool by then and getrawtransaction needs an index.
      'txindex=1',
      'listen=0',
      'discover=0',
      'dnsseed=0',
      'fallbackfee=0.0001',
      `rpcuser=${USER}`,
      `rpcpassword=${PASS}`,
      `[regtest]`,
      `rpcport=${port}`,
      '',
    ].join('\n'),
  )

  const child: ChildProcess = spawn(BITCOIND, [`-datadir=${datadir}`], { stdio: 'ignore' })

  const url = `http://127.0.0.1:${port}/`
  const auth = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`

  async function rpc<T>(method: string, params: unknown[] = [], wallet?: string): Promise<T> {
    const response = await fetch(wallet ? `${url}wallet/${wallet}` : url, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '1.0', id: 'fmd', method, params }),
    })
    const body = (await response.json()) as { result?: T; error?: { code: number; message: string } }
    if (body.error) throw new Error(`${method}: ${body.error.message} (code ${body.error.code})`)
    return body.result as T
  }

  // Wait for it to come up. A cold start is a second or two.
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      await rpc('getblockchaininfo')
      break
    } catch (err) {
      if (Date.now() > deadline) {
        child.kill('SIGKILL')
        rmSync(datadir, { recursive: true, force: true })
        throw new Error(`bitcoind did not start within 30s: ${(err as Error).message}`)
      }
      await new Promise((r) => setTimeout(r, 300))
    }
  }

  return {
    datadir,
    rpc: rpc as RegtestNode['rpc'],
    async stop() {
      try {
        await rpc('stop')
      } catch {
        child.kill('SIGTERM')
      }
      // Give it a moment to flush, then remove the datadir entirely.
      await new Promise((r) => setTimeout(r, 800))
      child.kill('SIGKILL')
      rmSync(datadir, { recursive: true, force: true })
    },
  }
}

/** Convenience: a funded wallet with spendable coins. */
export async function fundedWallet(node: RegtestNode, name = 'fmd', port = 18999): Promise<{
  address: string
  send(to: string, btc: number): Promise<string>
  mine(blocks: number): Promise<void>
}> {
  // Core 31 removed legacy wallets: descriptors must be true.
  await node.rpc('createwallet', [name, false, false, '', false, true, true])

  const walletRpc = async <T>(method: string, params: unknown[] = []): Promise<T> => {
    const response = await fetch(`http://127.0.0.1:${port}/wallet/${name}`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '1.0', id: 'fmd', method, params }),
    })
    const body = (await response.json()) as { result?: T; error?: { message: string } }
    if (body.error) throw new Error(`${method}: ${body.error.message}`)
    return body.result as T
  }

  const address = await walletRpc<string>('getnewaddress')
  // 101 blocks: coinbase needs 100 confirmations before it is spendable.
  await walletRpc('generatetoaddress', [101, address])

  return {
    address,
    send: (to, btc) => walletRpc<string>('sendtoaddress', [to, btc]),
    mine: async (blocks) => {
      await walletRpc('generatetoaddress', [blocks, address])
    },
  }
}
