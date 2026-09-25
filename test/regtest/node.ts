// Throwaway Bitcoin Core regtest node in a temp datadir, driven over JSON-RPC.
// Needs bitcoind unpacked under tools/ (see spec/VERIFY.md).

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BITCOIND = join(process.cwd(), 'tools/bitcoin-31.1/bin/bitcoind')

/** tools/ is not in git. Without bitcoind, skip node tests instead of waiting 30s to fail. */
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
      'txindex=1', // Funding tx is mined before lookup, so getrawtransaction needs the index.
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

  // Cold start takes a second or two.
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
      // Let it flush before deleting the datadir.
      await new Promise((r) => setTimeout(r, 800))
      child.kill('SIGKILL')
      rmSync(datadir, { recursive: true, force: true })
    },
  }
}

/** Wallet with spendable coins. */
export async function fundedWallet(node: RegtestNode, name = 'fmd', port = 18999): Promise<{
  address: string
  send(to: string, btc: number): Promise<string>
  mine(blocks: number): Promise<void>
}> {
  // Core 31 dropped legacy wallets, so descriptors=true.
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
  // Coinbase needs 100 confirmations to spend.
  await walletRpc('generatetoaddress', [101, address])

  return {
    address,
    send: (to, btc) => walletRpc<string>('sendtoaddress', [to, btc]),
    mine: async (blocks) => {
      await walletRpc('generatetoaddress', [blocks, address])
    },
  }
}
