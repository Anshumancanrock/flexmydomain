/**
 * NIP-09 deletion requests.
 *
 * A kind 5 is a request. Relays may honour it or ignore it, and anyone who
 * already has the event still has it, so calling a listing "deleted" would
 * mislead a seller about whether their asking price is still public.
 *
 * For a listing, the authoritative signal is the `status` tag: a sold listing
 * is republished with `status: sold`, which replaces the old version wherever
 * the old one reached. The deletion request is sent as well, for relays that
 * honour it.
 */

import { isHex32, type NostrEvent, type NostrTag, type UnsignedEvent } from './event.js'
import { addressOf } from './event.js'

export const DELETION_KIND = 5

/**
 * Build a deletion request.
 *
 * Addressable events are referenced by `a` (the coordinate) rather than `e`
 * (one version's id), because a listing that has been edited five times has
 * five ids and a seller means all of them.
 *
 * The `k` tag names the kind being deleted. NIP-09 asks for it so a relay can
 * apply the request without first fetching the target.
 */
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
      // Relays and applyDeletions ignore a request for somebody else's event,
      // so building one means a bug upstream, better caught here than
      // silently ignored later.
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

/** What a deletion request asks to remove. */
export function parseDeletion(event: NostrEvent): { ids: string[]; addresses: string[]; reason: string } | undefined {
  if (event.kind !== DELETION_KIND) return undefined
  return {
    ids: event.tags.filter((t) => t[0] === 'e' && t[1]).map((t) => t[1]),
    addresses: event.tags.filter((t) => t[0] === 'a' && t[1]).map((t) => t[1]),
    reason: event.content,
  }
}

/**
 * Apply deletion requests to a set of events, client-side.
 *
 * Relays may ignore a kind 5, but a client can still honour it, so deletion
 * works for the reader whatever the relay decided.
 *
 * A request applies only to its own author's events. That check is what makes
 * this safe: without it, anyone could hide anyone's listing by publishing a
 * kind 5 naming it.
 */
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
      // NIP-09: an `a` request removes versions published at or before the
      // request. A seller who relists tomorrow is not deleted by yesterday's
      // request, or a delisting would be permanent.
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

/** The filter that fetches deletion requests from a set of authors. */
export function deletionFilter(authors: readonly string[]): Record<string, unknown> {
  return { kinds: [DELETION_KIND], authors: [...authors] }
}
