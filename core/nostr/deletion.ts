// NIP-09 deletion requests.

import { isHex32, type NostrEvent, type NostrTag, type UnsignedEvent } from './event.js'
import { addressOf } from './event.js'

export const DELETION_KIND = 5

export function buildDeletion(params: {
  pubkey: string
  events: readonly NostrEvent[]
  reason?: string
  createdAt: number
}): UnsignedEvent {
  if (!isHex32(params.pubkey)) throw new Error('buildDeletion: pubkey must be 64 lowercase hex characters')
  if (params.events.length === 0) throw new Error('buildDeletion: nothing to delete')

  const tags: NostrTag[] = []
  const kinds = new Set<number>()

  for (const event of params.events) {
    if (event.pubkey !== params.pubkey) {
      // Relays and applyDeletions would ignore it. Catch the upstream bug here.
      throw new Error('buildDeletion: you can only request deletion of your own events')
    }
    if (event.kind >= 30000 && event.kind < 40000) tags.push(['a', addressOf(event)])
    else tags.push(['e', event.id])
    kinds.add(event.kind)
  }
  for (const kind of kinds) tags.push(['k', String(kind)])

  return {
    pubkey: params.pubkey,
    created_at: params.createdAt,
    kind: DELETION_KIND,
    tags,
    content: params.reason ?? '',
  }
}

export function parseDeletion(event: NostrEvent): { ids: string[]; addresses: string[]; reason: string } | undefined {
  if (event.kind !== DELETION_KIND) return undefined
  return {
    ids: event.tags.filter((t) => t[0] === 'e' && t[1]).map((t) => t[1]),
    addresses: event.tags.filter((t) => t[0] === 'a' && t[1]).map((t) => t[1]),
    reason: event.content,
  }
}

export function applyDeletions(events: readonly NostrEvent[], deletions: readonly NostrEvent[]): NostrEvent[] {
  const byAuthorIds = new Map<string, Set<string>>()
  const byAuthorAddresses = new Map<string, Map<string, number>>()

  for (const request of deletions) {
    const parsed = parseDeletion(request)
    if (!parsed) continue
    const ids = byAuthorIds.get(request.pubkey) ?? new Set<string>()
    for (const id of parsed.ids) ids.add(id)
    byAuthorIds.set(request.pubkey, ids)

    const addresses = byAuthorAddresses.get(request.pubkey) ?? new Map<string, number>()
    for (const address of parsed.addresses) {
      // Per NIP-09 an `a` request removes versions at or before it, so a later relist survives.
      const previous = addresses.get(address)
      addresses.set(address, previous === undefined ? request.created_at : Math.max(previous, request.created_at))
    }
    byAuthorAddresses.set(request.pubkey, addresses)
  }

  return events.filter((event) => {
    if (byAuthorIds.get(event.pubkey)?.has(event.id)) return false
    const at = byAuthorAddresses.get(event.pubkey)?.get(addressOf(event))
    return at === undefined || event.created_at > at
  })
}

export function deletionFilter(authors: readonly string[]): Record<string, unknown> {
  return { kinds: [DELETION_KIND], authors: [...authors] }
}
