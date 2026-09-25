#!/usr/bin/env bun
/**
 * Watch a domain transfer from outside the registrar. Polls RDAP and applies the
 * escrow's rules (two-poll confirmation). No account or API key needed.
 *
 *   bun scripts/watch-transfer.ts --domain example.com --registrar 292
 *   bun scripts/watch-transfer.ts --domain example.com --ns ns1.buyer.example --interval 1800
 */

import { buildCommitment, deriveTransferState, fundable, registrantActed, releasable } from '../core/escrow/transfer.js'
import { observe, record } from '../net/transfer.js'
import { fetchRdapBootstrap } from '../net/rdap.js'
import type { Observation } from '../core/escrow/transfer.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

const domain = arg('domain')
if (!domain) {
  console.error('Usage: bun scripts/watch-transfer.ts --domain <name> [--registrar <iana id>] [--ns <host>,...] [--interval 1800] [--once]')
  process.exit(1)
}

const now = () => Math.floor(Date.now() / 1000)

let commitment
try {
  commitment = buildCommitment({
    registrarIanaId: arg('registrar'),
    nameservers: arg('ns')?.split(',').map((n) => n.trim()).filter(Boolean),
    committedAt: now(),
  })
} catch (err) {
  console.error((err as Error).message)
  console.error('\nPass --registrar <iana id>, --ns <host,host>, or both. Without one of them there is')
  console.error('nothing a completed transfer could be compared against.')
  process.exit(1)
}

const interval = Number(arg('interval') ?? 1800)
const once = process.argv.includes('--once')

console.log(`watching ${domain}`)
console.log(`  commitment  registrar=${commitment.registrarIanaId ?? '-'} ns=${commitment.nameservers.join(',') || '-'}`)
console.log(`  polling     every ${interval}s (two agreeing polls 1800s apart confirm a state)\n`)

const bootstrap = await fetchRdapBootstrap().catch(() => undefined)
let history: Observation[] = []

for (;;) {
  const at = now()
  const result = await observe({ domain, now: at, bootstrap })

  if (!result.observation) {
    // A failed fetch is not evidence. Don't record it.
    console.log(`${new Date(at * 1000).toISOString()}  no reading: ${result.reason}`)
  } else {
    history = record(history, result.observation)
    const verdict = deriveTransferState({ observations: history, commitment, now: at })
    const acted = registrantActed({ observations: history, commitment })
    const flags = [
      fundable({ verdict, observations: history, commitment }) ? 'fundable' : '',
      releasable(verdict) ? 'RELEASABLE' : '',
    ]
      .filter(Boolean)
      .join(' ')
    console.log(
      `${new Date(at * 1000).toISOString()}  ${verdict.state.padEnd(12)}` +
        `${verdict.confirmed ? 'confirmed' : 'unconfirmed'}  ${flags}`,
    )
    console.log(`    ${verdict.reason}`)
    console.log(`    registrant: ${acted.reason}`)
    if (verdict.evidence.length) console.log(`    evidence: ${verdict.evidence.join(' ')}`)
  }

  if (once) break
  await new Promise((r) => setTimeout(r, interval * 1000))
}
