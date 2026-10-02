// NIP-42 relay authentication.

import { isHex32, type UnsignedEvent } from './event.js'

export const AUTH_KIND = 22242

const MAX_CHALLENGE = 1024

export function buildAuthEvent(params: { relay: string; challenge: string; pubkey: string; createdAt: number }): UnsignedEvent {
  if (!isHex32(params.pubkey)) throw new Error('buildAuthEvent: pubkey must be 64 lowercase hex characters')
  if (typeof params.challenge !== 'string' || params.challenge === '' || params.challenge.length > MAX_CHALLENGE) {
    throw new Error('buildAuthEvent: the relay sent no usable challenge')
  }
  if (!/^wss?:\/\//i.test(params.relay)) throw new Error('buildAuthEvent: the relay is not a websocket URL')
  return {
    pubkey: params.pubkey,
    created_at: params.createdAt,
    kind: AUTH_KIND,
    tags: [['relay', params.relay], ['challenge', params.challenge]],
    content: '',
  }
}
