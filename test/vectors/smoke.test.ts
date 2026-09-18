import { test, expect } from 'bun:test'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { TAPROOT_UNSPENDABLE_KEY } from '@scure/btc-signer'

test('toolchain: sha256 matches the known empty-string digest', () => {
  expect(bytesToHex(sha256(new Uint8Array(0))))
    .toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
})

test('the BIP-341 NUMS point matches its published x-coordinate', () => {
  expect(bytesToHex(TAPROOT_UNSPENDABLE_KEY))
    .toBe('50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0')
})
