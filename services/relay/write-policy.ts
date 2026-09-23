#!/usr/bin/env bun
/**
 * strfry write-policy plugin for a flexmydomain relay.
 *
 * strfry starts this process once and writes one JSON line per incoming event
 * to its stdin; this process answers each with one JSON line on stdout. The
 * protocol is strfry's docs/plugins.md. The decision itself is policy.ts,
 * which is pure; this file adds the two things a decision cannot know about:
 * where the event came from, and how often that source has been writing.
 *
 * Configuration is by environment, so one binary serves the relay and the
 * router alike:
 *
 *   FMD_FLEX_RECIPIENT      x-only hex; keep only flex zaps paid to this key
 *   FMD_VERIFIERS           comma-separated x-only hex; keep their NIP-90 feedback
 *   FMD_ACCEPT_GIFT_WRAPS   "1" to store kind 1059 (off by default; see policy.ts)
 *   FMD_RATE_PER_MINUTE     sustained writes per client IP, or IPv6 /64 (default 30)
 *   FMD_RATE_BURST          burst allowance per client IP, or IPv6 /64 (default 60)
 *
 * Build a standalone binary for the container with:
 *   bun build --compile services/relay/write-policy.ts --outfile fmd-write-policy
 */

import { createInterface } from 'node:readline'
import type { NostrEvent } from '../../core/nostr/event.js'
import { decide, type PolicyOptions } from './policy.js'

export interface PluginInput {
  type: string
  event: NostrEvent
  receivedAt?: number
  sourceType?: 'IP4' | 'IP6' | 'Import' | 'Stream' | 'Sync' | 'Stored' | string
  sourceInfo?: string
  authed?: string
}

export interface PluginOutput {
  id: string
  action: 'accept' | 'reject' | 'shadowReject'
  msg?: string
}

/**
 * A token bucket per client address. Only events from clients are limited:
 * imports, router streams and syncs are the operator's own traffic.
 *
 * Idle buckets are dropped after ten minutes, so a crawler rotating through
 * addresses cannot grow this map without bound.
 */
export function createRateLimiter(perMinute: number, burst: number) {
  const buckets = new Map<string, { tokens: number; at: number }>()
  let calls = 0
  const refillPerSecond = perMinute / 60

  return function allow(source: string, nowSeconds: number): boolean {
    if (++calls % 10_000 === 0) {
      for (const [key, b] of buckets) if (nowSeconds - b.at > 600) buckets.delete(key)
    }
    const bucket = buckets.get(source) ?? { tokens: burst, at: nowSeconds }
    bucket.tokens = Math.min(burst, bucket.tokens + (nowSeconds - bucket.at) * refillPerSecond)
    bucket.at = nowSeconds
    const allowed = bucket.tokens >= 1
    if (allowed) bucket.tokens -= 1
    buckets.set(source, bucket)
    return allowed
  }
}

/**
 * The address a client is rate-limited by. Every IPv6 host gets a whole /64
 * and can pick the rest of its address at will, so an IPv6 client is limited
 * by its /64. An IPv4-mapped address counts as the IPv4 address it maps.
 */
export function rateKey(sourceType: string | undefined, sourceInfo: string | undefined): string {
  const ip = (sourceInfo ?? 'unknown').toLowerCase()
  if (sourceType !== 'IP6') return ip
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip)
  if (mapped) return mapped[1]
  const halves = ip.split('::')
  if (halves.length > 2) return ip
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const groups = halves.length === 2 ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return ip
  return groups.slice(0, 4).map((g) => g.padStart(4, '0')).join(':') + '::/64'
}

const hexList = (value: string | undefined) =>
  (value ?? '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => /^[0-9a-f]{64}$/.test(s))

export function optionsFromEnv(env: Record<string, string | undefined>): PolicyOptions {
  const recipient = env.FMD_FLEX_RECIPIENT?.trim().toLowerCase()
  return {
    flexRecipient: recipient && /^[0-9a-f]{64}$/.test(recipient) ? recipient : undefined,
    verifiers: hexList(env.FMD_VERIFIERS),
    acceptGiftWraps: env.FMD_ACCEPT_GIFT_WRAPS === '1',
  }
}

/** One input line to one output line. Never throws: strfry must get an answer. */
export function handle(
  input: PluginInput,
  options: PolicyOptions,
  allow: (source: string, nowSeconds: number) => boolean,
  nowSeconds: number,
): PluginOutput {
  const id = input.event.id
  const fromClient = input.sourceType === 'IP4' || input.sourceType === 'IP6'

  if (fromClient && !allow(rateKey(input.sourceType, input.sourceInfo), nowSeconds)) {
    return { id, action: 'reject', msg: 'rate-limited: slow down' }
  }

  let decision
  try {
    decision = decide(input.event, options)
  } catch (err) {
    console.error(`fmd-write-policy: ${id}: ${(err as Error).message}`)
    return { id, action: 'reject', msg: 'error: the write policy could not read this event' }
  }

  if (decision.action === 'accept') return { id, action: 'accept' }
  /* A client is told why. A router stream is not: every off-topic event on a
     busy upstream would otherwise become a line in strfry's log, and an empty
     message is how the plugin protocol asks for silence. */
  return { id, action: 'reject', msg: fromClient ? decision.msg : '' }
}

if (import.meta.main) {
  const options = optionsFromEnv(process.env)
  const allow = createRateLimiter(
    Number(process.env.FMD_RATE_PER_MINUTE ?? 30),
    Number(process.env.FMD_RATE_BURST ?? 60),
  )
  const lines = createInterface({ input: process.stdin, terminal: false })

  lines.on('line', (line) => {
    let input: PluginInput
    try {
      input = JSON.parse(line)
    } catch {
      console.error('fmd-write-policy: a line that is not JSON was ignored')
      return
    }
    if (input.type !== 'new' || typeof input.event?.id !== 'string') {
      console.error(`fmd-write-policy: unexpected request type ${JSON.stringify(input.type)}`)
      return
    }
    const output = handle(input, options, allow, Math.floor(Date.now() / 1000))
    process.stdout.write(JSON.stringify(output) + '\n')
  })
}
