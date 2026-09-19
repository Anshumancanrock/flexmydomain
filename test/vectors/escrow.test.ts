/**
 * core/escrow test vectors: two independent key sets, five variants each, and
 * a differential check of every derived byte against @scure/btc-signer.
 *
 * core/escrow implements BIP-341 over @noble primitives and does not import
 * @scure/btc-signer, so the differential tests compare two independent
 * derivations.
 */

import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bech32, bech32m } from '@scure/base'
import * as btc from '@scure/btc-signer'
import { tapLeafHash as scureTapLeafHash } from '@scure/btc-signer/payment.js'

import {
  buildTree,
  describeTree,
  deriveOutputKey,
  verifyControlBlock,
  encodeTaprootAddress,
  numsInternalKey,
  NUMS_INTERNAL_KEY_HEX,
  taggedHash,
  compactSize,
  tapLeafHash,
  tapBranchHash,
  cooperativeLeaf,
  timeoutLeaf,
  scriptNum,
  minimalPushNum,
  taprootScriptPubKey,
  RBF_SEQUENCE,
  TAP_LEAF_VERSION,
  OP,
  NETWORK_HRP,
  type BuildTreeParams,
  type EscrowTree,
  type LeafName,
} from '../../core/escrow/index.ts'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const hex = (b: Uint8Array) => bytesToHex(b)

function secret(fill: number): Uint8Array {
  const b = new Uint8Array(32)
  b.fill(fill)
  return b
}
function secretInt(n: number): Uint8Array {
  const b = new Uint8Array(32)
  b[31] = n
  return b
}

/** Key set 1: private keys 1, 2, 3. buyer is the generator's x-coordinate. */
const K1 = {
  buyer: schnorr.getPublicKey(secretInt(1)),
  seller: schnorr.getPublicKey(secretInt(2)),
  arbiter: schnorr.getPublicKey(secretInt(3)),
}

/** Key set 2: private keys 0x11.., 0x22.., 0x33.., an independent derivation. */
const K2 = {
  buyer: schnorr.getPublicKey(secret(0x11)),
  seller: schnorr.getPublicKey(secret(0x22)),
  arbiter: schnorr.getPublicKey(secret(0x33)),
}

/** @scure/btc-signer ships no regtest constant. BIP-350 gives the HRP. */
const REGTEST = { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef }

// ---------------------------------------------------------------------------
// tagged hashes and primitives
// ---------------------------------------------------------------------------

describe('BIP-341 tagged hashes', () => {
  // Hard-coded so a typo in a tag string cannot slip through. A wrong tag still
  // hashes, still encodes an address, and fails only when a spend is rejected
  // by consensus after real coins are locked.
  test('the three tag digests are pinned', () => {
    expect(hex(sha256(utf8ToBytes('TapLeaf')))).toBe(
      'aeea8fdc4208983105734b58081d1e2638d35f1cb54008d4d357ca03be78e9ee',
    )
    expect(hex(sha256(utf8ToBytes('TapBranch')))).toBe(
      '1941a1f2e56eb95fa2a9f194be5c01f7216f33ed82b091463490d05bf516a015',
    )
    expect(hex(sha256(utf8ToBytes('TapTweak')))).toBe(
      'e80fe1639c9ca050e3af1b39c143c63e429cbceb15d940fbb5c5a1f4af57c5e9',
    )
  })

  test('taggedHash double-prefixes the tag, matching @noble', () => {
    const msg = hexToBytes('c0deadbeef')
    expect(hex(taggedHash('TapLeaf', msg))).toBe(hex(schnorr.utils.taggedHash('TapLeaf', msg)))
    expect(hex(taggedHash('TapBranch', msg))).toBe(hex(schnorr.utils.taggedHash('TapBranch', msg)))
    expect(hex(taggedHash('TapTweak', msg))).toBe(hex(schnorr.utils.taggedHash('TapTweak', msg)))
    // varargs concatenate in order
    const a = hexToBytes('0102')
    const b = hexToBytes('0304')
    expect(hex(taggedHash('TapBranch', a, b))).toBe(hex(taggedHash('TapBranch', concatBytes(a, b))))
    // single-prefixing gives a different digest: the bug this pins
    const p = sha256(utf8ToBytes('TapLeaf'))
    expect(hex(taggedHash('TapLeaf', msg))).not.toBe(hex(sha256(concatBytes(p, msg))))
  })

  test('compactSize is minimal at every boundary', () => {
    expect(hex(compactSize(0))).toBe('00')
    expect(hex(compactSize(39))).toBe('27') // the timeout leaf
    expect(hex(compactSize(68))).toBe('44') // the 2-of-2 leaves
    expect(hex(compactSize(252))).toBe('fc')
    expect(hex(compactSize(253))).toBe('fdfd00')
    expect(hex(compactSize(0xffff))).toBe('fdffff')
    expect(hex(compactSize(0x10000))).toBe('fe00000100')
    expect(() => compactSize(-1)).toThrow()
    expect(() => compactSize(1.5)).toThrow()
  })

  test('tapBranchHash sorts its children, so within-pair order is irrelevant', () => {
    const a = hexToBytes('00'.repeat(32))
    const b = hexToBytes('ff'.repeat(32))
    expect(hex(tapBranchHash(a, b))).toBe(hex(tapBranchHash(b, a)))
    expect(hex(tapBranchHash(a, b))).toBe(hex(taggedHash('TapBranch', a, b)))
  })

  test('tapLeafHash rejects a leafVersion BIP-341 can never commit to', () => {
    const s = Uint8Array.of(0x51)
    expect(hex(tapLeafHash(s))).toBe(hex(tapLeafHash(s, TAP_LEAF_VERSION)))

    // The version is one byte of the preimage and Uint8Array.of() truncates
    // mod 256 silently, so without the check 0x1c0 and -64 would hash the same
    // as 0xc0: a plausible digest for a version that was never committed to.
    expect(() => tapLeafHash(s, 0x1c0)).toThrow(/0\.\.254/)
    expect(() => tapLeafHash(s, -64)).toThrow(/0\.\.254/)
    expect(() => tapLeafHash(s, 1.5)).toThrow(/0\.\.254/)
    expect(() => tapLeafHash(s, '192' as never)).toThrow(/got "192"/)
    // A verifier recovers the version as c[0] & 0xfe, so an odd one is
    // unreachable; 0x50 collides with the annex marker. Either hashes fine and
    // commits to a branch that can never be spent.
    expect(() => tapLeafHash(s, 0xc1)).toThrow(/even/)
    expect(() => tapLeafHash(s, 0x50)).toThrow(/annex/)

    // Differential: the same rule as @scure/btc-signer, accepted and rejected.
    for (const v of [0x00, 0xc0, 0xfe]) {
      expect(`${v}:${hex(tapLeafHash(s, v))}`).toBe(`${v}:${hex(scureTapLeafHash(s, v))}`)
    }
    for (const v of [0x1c0, -64, 0xc1, 0x50]) {
      expect(() => tapLeafHash(s, v)).toThrow()
      expect(() => scureTapLeafHash(s, v)).toThrow()
    }
  })
})

describe('the NUMS internal key', () => {
  test('is sha256 of the uncompressed generator and matches the BIP-341 value', () => {
    expect(hex(numsInternalKey())).toBe(NUMS_INTERNAL_KEY_HEX)
    expect(NUMS_INTERNAL_KEY_HEX).toBe(
      '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0',
    )
    expect(hex(numsInternalKey())).toBe(hex(btc.taprootNumsKey()))
    expect(hex(numsInternalKey())).toBe(hex(btc.TAPROOT_UNSPENDABLE_KEY))
  })

  test('lift_x succeeds and, per BIP-340, yields the even-Y point', () => {
    const P = schnorr.utils.lift_x(BigInt('0x' + NUMS_INTERNAL_KEY_HEX))
    expect(P.y % 2n).toBe(0n)
  })

  test('is returned as a fresh copy, never a shared mutable array', () => {
    const a = numsInternalKey()
    const b = numsInternalKey()
    expect(a).not.toBe(b)
    a[0] ^= 0xff
    expect(hex(numsInternalKey())).toBe(NUMS_INTERNAL_KEY_HEX)
  })
})

// ---------------------------------------------------------------------------
// script numbers
// ---------------------------------------------------------------------------

describe('CScriptNum and minimal pushes', () => {
  test('production timelock pushes, byte for byte', () => {
    expect(hex(minimalPushNum(1008))).toBe('02f003')
    expect(hex(minimalPushNum(2016))).toBe('02e007')
    expect(hex(minimalPushNum(4320))).toBe('02e010')
  })

  test('a magnitude with the top bit set gets a 0x00 sign byte', () => {
    // Core reads an unpadded 0x80-topped payload as negative, and CSV rejects a
    // negative operand outright, locking the timeout path forever.
    expect(hex(scriptNum(127))).toBe('7f')
    expect(hex(scriptNum(128))).toBe('8000')
    expect(hex(scriptNum(255))).toBe('ff00')
    expect(hex(scriptNum(32767))).toBe('ff7f')
    expect(hex(scriptNum(32768))).toBe('008000')
    expect(hex(scriptNum(40000))).toBe('409c00')
    expect(hex(scriptNum(65535))).toBe('ffff00')
  })

  test('1..16 are the OP_1..OP_16 opcodes, not one-byte pushes (BIP-62)', () => {
    // `01 0a` is rejected by Core with "Data push larger than necessary".
    expect(hex(minimalPushNum(1))).toBe('51')
    expect(hex(minimalPushNum(10))).toBe('5a')
    expect(hex(minimalPushNum(16))).toBe('60')
    expect(hex(minimalPushNum(17))).toBe('0111')
  })

  test('matches @scure/btc-signer across the whole valid range', () => {
    const values = [
      1, 2, 15, 16, 17, 75, 126, 127, 128, 129, 254, 255, 256, 1000, 1008, 2016, 4320, 32766,
      32767, 32768, 40000, 65534, 65535,
    ]
    for (const n of values) {
      expect(`${n}:${hex(scriptNum(n))}`).toBe(`${n}:${hex(btc.ScriptNum().encode(BigInt(n)))}`)
      expect(`${n}:${hex(minimalPushNum(n))}`).toBe(`${n}:${hex(btc.Script.encode([n]))}`)
    }
  })
})

// ---------------------------------------------------------------------------
// leaf scripts: the bytes are normative
// ---------------------------------------------------------------------------

describe('leaf scripts', () => {
  const { buyer, seller, arbiter } = K1

  test('leaves A, B and C are 68 bytes with the expected shape', () => {
    const A = cooperativeLeaf(buyer, seller)
    const B = cooperativeLeaf(seller, arbiter)
    const C = cooperativeLeaf(buyer, arbiter)
    expect(A.length).toBe(68)
    expect(B.length).toBe(68)
    expect(C.length).toBe(68)
    expect(hex(A)).toBe(
      '2079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ad' +
        '20c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5ac',
    )
    expect(hex(B)).toBe(
      '20c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5ad' +
        '20f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9ac',
    )
    expect(hex(C)).toBe(
      '2079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ad' +
        '20f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9ac',
    )
  })

  test('leaf D is 39 bytes for all three production timeouts', () => {
    expect(hex(timeoutLeaf(4320, buyer))).toBe(
      '02e010b2752079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac',
    )
    expect(hex(timeoutLeaf(1008, buyer))).toBe(
      '02f003b2752079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac',
    )
    expect(hex(timeoutLeaf(2016, seller))).toBe(
      '02e007b27520c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5ac',
    )
    for (const n of [1008, 2016, 4320]) expect(timeoutLeaf(n, buyer).length).toBe(39)
  })

  test('leaf D length is a function of the timelock, not a constant 39', () => {
    // A regtest harness will want a short timelock, and OP_1..OP_16 shortens the
    // leaf. Any fixture asserting "39 bytes" breaks the first time someone
    // passes 10.
    expect(timeoutLeaf(10, buyer).length).toBe(37)
    expect(timeoutLeaf(17, buyer).length).toBe(38)
    expect(timeoutLeaf(4320, buyer).length).toBe(39)
    expect(timeoutLeaf(40000, buyer).length).toBe(40)
  })

  test('leaf bytes match @scure/btc-signer Script.encode', () => {
    expect(hex(cooperativeLeaf(buyer, seller))).toBe(
      hex(btc.Script.encode([buyer, 'CHECKSIGVERIFY', seller, 'CHECKSIG'])),
    )
    expect(hex(cooperativeLeaf(seller, arbiter))).toBe(
      hex(btc.Script.encode([seller, 'CHECKSIGVERIFY', arbiter, 'CHECKSIG'])),
    )
    for (const n of [1, 16, 17, 1008, 2016, 4320, 40000, 65535]) {
      expect(`${n}:${hex(timeoutLeaf(n, buyer))}`).toBe(
        `${n}:${hex(btc.Script.encode([n, 'CHECKSEQUENCEVERIFY', 'DROP', buyer, 'CHECKSIG']))}`,
      )
    }
  })

  test('leaf hashes match the pinned values', () => {
    const A = cooperativeLeaf(buyer, seller)
    expect(hex(tapLeafHash(A))).toBe(
      'df6587a7f3cf367a076047bc0e85893cabb6b1430f9e95ffc0003dad6593ba33',
    )
    expect(hex(tapLeafHash(cooperativeLeaf(seller, arbiter)))).toBe(
      'c9bcb65c1015db6b44e5c2977606cf7a5d8f13d226531c6d01133d0810bed17b',
    )
    expect(hex(tapLeafHash(cooperativeLeaf(buyer, arbiter)))).toBe(
      'adc6b97cf6faab3e93e0bb6ca965fd1976982d39a86806d0e9603bfda05f46b4',
    )
    expect(hex(tapLeafHash(timeoutLeaf(4320, buyer)))).toBe(
      '0dbbeb3514e00bc150281f556687eab1edf83044c06cda8f5a66722e9296c75a',
    )
    expect(hex(tapLeafHash(timeoutLeaf(1008, buyer)))).toBe(
      '93d143d7e16c21e6efb4a2031c2043bb353d7135288111e5801bdd75de661f3a',
    )
    expect(hex(tapLeafHash(timeoutLeaf(2016, seller)))).toBe(
      'e6f57bcb31e5340a0115b16327d3a401e406b6fa997d888e498bfcbfa7a9306d',
    )
    // The CompactSize prefix is part of the preimage; without it the hash differs.
    expect(hex(tapLeafHash(A))).not.toBe(
      hex(taggedHash('TapLeaf', Uint8Array.of(TAP_LEAF_VERSION), A)),
    )
  })

  test('scriptPubKey is OP_1 OP_PUSHBYTES_32 <Q>, 34 bytes', () => {
    const spk = taprootScriptPubKey(hexToBytes('11'.repeat(32)))
    expect(spk.length).toBe(34)
    expect(hex(spk)).toBe('5120' + '11'.repeat(32))
  })
})

// ---------------------------------------------------------------------------
// the five reference vectors
// ---------------------------------------------------------------------------

interface Vector {
  name: string
  params: BuildTreeParams
  merkleRoot: string
  tweak?: string
  outputKey: string
  parity: 0 | 1
  mainnet: string
  testnet: string
  regtest: string
  branches?: Record<string, string>
  controlBlocks?: Partial<Record<LeafName, string>>
  controlBlockLength: number
}

const NUMS_HEX = '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0'

const VECTORS: Vector[] = [
  {
    name: 'V1 keyset1 arbiter timeoutTo=buyer 4320 (four-leaf tree, 30-day timeout)',
    params: { ...K1, timeoutTo: 'buyer', timeoutBlocks: 4320 },
    merkleRoot: '5c8a3100eae52ecdb7655739b23efcfbcf087b8e36f31e23dbd71c356dc88397',
    tweak: 'ac625c76313b52d69c48335883bbcc2a51d8a3936762d616d24e0729b32f2a90',
    outputKey: '6f49cbafea2522800a955088f92ac3dcb6fd95a429fbc0b5530230c05116b01a',
    parity: 1,
    mainnet: 'bc1pdayuhtl2y53gqz542zy0j2krmjm0m9dy98aupd2nqgcvq5gkkqdq6n2cup',
    testnet: 'tb1pdayuhtl2y53gqz542zy0j2krmjm0m9dy98aupd2nqgcvq5gkkqdqdmuhxw',
    regtest: 'bcrt1pdayuhtl2y53gqz542zy0j2krmjm0m9dy98aupd2nqgcvq5gkkqdqqzk3n5',
    branches: {
      'branch(A,B)': '508c4c7eb9cae751fa8b8daf40586e3c11f4a8c925538ead255a4df5f28e7fd3',
      'branch(C,D)': '501e63dae4336bfbd57007b8defa80d95c3abd619f994eb9c8023397c4b0ca0b',
    },
    controlBlocks: {
      A:
        'c1' + NUMS_HEX +
        'c9bcb65c1015db6b44e5c2977606cf7a5d8f13d226531c6d01133d0810bed17b' +
        '501e63dae4336bfbd57007b8defa80d95c3abd619f994eb9c8023397c4b0ca0b',
      D:
        'c1' + NUMS_HEX +
        'adc6b97cf6faab3e93e0bb6ca965fd1976982d39a86806d0e9603bfda05f46b4' +
        '508c4c7eb9cae751fa8b8daf40586e3c11f4a8c925538ead255a4df5f28e7fd3',
    },
    controlBlockLength: 97,
  },
  {
    name: 'V2 keyset1 arbiter timeoutTo=buyer 1008 (stage 1), parity 0',
    params: { ...K1, timeoutTo: 'buyer', timeoutBlocks: 1008 },
    merkleRoot: '3cac793610d80aa29ed37b0b6769eca87ce2b8fe4ff0ff43a24aa780f805f37f',
    outputKey: 'bb23c25c85d3633fc5697ab8fa71883ad90b3ae9411ef509f41c10b92b2529a6',
    parity: 0,
    mainnet: 'bc1phv3uyhy96d3nl3tf02u05uvg8tvskwhfgy002z05rsgtj2e99xnqzrzzql',
    testnet: 'tb1phv3uyhy96d3nl3tf02u05uvg8tvskwhfgy002z05rsgtj2e99xnq4t5d6s',
    regtest: 'bcrt1phv3uyhy96d3nl3tf02u05uvg8tvskwhfgy002z05rsgtj2e99xnqcj7t02',
    branches: {
      'branch(C,D)': '9d7859edf7b9821bd0dbcb191febe8e890c9bcf2e0e1c1d0491c0f9d9038a0dd',
    },
    controlBlocks: {
      A:
        'c0' + NUMS_HEX +
        'c9bcb65c1015db6b44e5c2977606cf7a5d8f13d226531c6d01133d0810bed17b' +
        '9d7859edf7b9821bd0dbcb191febe8e890c9bcf2e0e1c1d0491c0f9d9038a0dd',
    },
    controlBlockLength: 97,
  },
  {
    name: 'V3 keyset1 arbiter timeoutTo=seller 2016 (stage 2, timeout flipped to the seller)',
    params: { ...K1, timeoutTo: 'seller', timeoutBlocks: 2016 },
    merkleRoot: '7be4cf5899d4e39b8828ec24ca83786ce48e2ca74483e06d08f62578ba94a7cc',
    outputKey: '82aae94b3fec4e3277bd05d17ace456c0cdc15811550a685b0716fcfa3daca4b',
    parity: 0,
    mainnet: 'bc1ps24wjjela38ryaaaqhgh4nj9dsxdc9vpz4g2dpdsw9hulg76ef9scza8vh',
    testnet: 'tb1ps24wjjela38ryaaaqhgh4nj9dsxdc9vpz4g2dpdsw9hulg76ef9s02tgkc',
    regtest: 'bcrt1ps24wjjela38ryaaaqhgh4nj9dsxdc9vpz4g2dpdsw9hulg76ef9sznpwrz',
    branches: {
      'branch(C,D)': 'f881a6feff1a1d53f07c818d6edb8f129fb603732beee79c4aace58ab9cee53b',
    },
    controlBlockLength: 97,
  },
  {
    name: 'V4 keyset1 no arbiter timeoutTo=buyer 1008 (two-leaf tree, stage 1)',
    params: { buyer: K1.buyer, seller: K1.seller, timeoutTo: 'buyer', timeoutBlocks: 1008 },
    merkleRoot: '316aeae48aa861a4a0665421e0257215ba0b5d980abaf0bdc80bb4f8b3785560',
    outputKey: '660ec05c94092f2b83f059f9ef03c36211ba3083afa718207974544f5479d18c',
    parity: 1,
    mainnet: 'bc1pvc8vqhy5pyhjhqlst8u77q7rvggm5vyr47n3sgrew32y74re6xxq6wv99q',
    testnet: 'tb1pvc8vqhy5pyhjhqlst8u77q7rvggm5vyr47n3sgrew32y74re6xxqdx62l0',
    regtest: 'bcrt1pvc8vqhy5pyhjhqlst8u77q7rvggm5vyr47n3sgrew32y74re6xxqqlsv24',
    controlBlocks: {
      A: 'c1' + NUMS_HEX + '93d143d7e16c21e6efb4a2031c2043bb353d7135288111e5801bdd75de661f3a',
      D: 'c1' + NUMS_HEX + 'df6587a7f3cf367a076047bc0e85893cabb6b1430f9e95ffc0003dad6593ba33',
    },
    controlBlockLength: 65,
  },
  {
    name: 'V5 keyset1 no arbiter timeoutTo=seller 2016 (two-leaf tree, stage 2)',
    params: { buyer: K1.buyer, seller: K1.seller, timeoutTo: 'seller', timeoutBlocks: 2016 },
    merkleRoot: '45568dec4fbfea2b2a1b75b824ab820eb0347ec70692ce47f3b6056aec4d1df9',
    outputKey: '8433a27b9582629ed2ae6808800b0212bd1c0a05d3d5de107c1ba2c36fc4f0f4',
    parity: 0,
    mainnet: 'bc1psse6y7u4sf3fa54wdqygqzczz273czs9602auyrurw3vxm7y7r6q9z0y5j',
    testnet: 'tb1psse6y7u4sf3fa54wdqygqzczz273czs9602auyrurw3vxm7y7r6qj2etwa',
    regtest: 'bcrt1psse6y7u4sf3fa54wdqygqzczz273czs9602auyrurw3vxm7y7r6qlnndm8',
    controlBlockLength: 65,
  },
  // Key set 2: an independent derivation of the same four variants.
  {
    name: 'V6 keyset2 arbiter timeoutTo=buyer 1008',
    params: { ...K2, timeoutTo: 'buyer', timeoutBlocks: 1008 },
    merkleRoot: '35a8ee454129ad393a0b9c7ec98f499e4a2314c97df860640039097155289328',
    tweak: '81df3dcef203e4be237d40b4af99c86037172cd48bc12c36cda8d14f267557b7',
    outputKey: '895b85de9e981b02a2d363dd01c480fb205c5b5a31e86faff8612126e37fff1b',
    parity: 1,
    mainnet: 'bc1p39dcth57nqds9gknv0wsr3yqlvs9ck66x85xltlcvysjdcmlludstzwhqk',
    testnet: 'tb1p39dcth57nqds9gknv0wsr3yqlvs9ck66x85xltlcvysjdcmlludsu2cc6e',
    regtest: 'bcrt1p39dcth57nqds9gknv0wsr3yqlvs9ck66x85xltlcvysjdcmlluds3nj70r',
    controlBlockLength: 97,
  },
  {
    name: 'V7 keyset2 arbiter timeoutTo=seller 2016',
    params: { ...K2, timeoutTo: 'seller', timeoutBlocks: 2016 },
    merkleRoot: '0e809d8f6cc3450e35bca32b303b0624c0657709fcf4a67a5a9be6affe376000',
    tweak: 'e4a78bfc8ee4df04f0ff4d8034651ca234d414b958c5ef9838313c74d9d8f12b',
    outputKey: '4327440b6f03f4785bc0f826da5f45ab1f5d3572eb97194490666095a12cce09',
    parity: 1,
    // Only the signet and regtest addresses were recorded for this vector.
    mainnet: '',
    testnet: 'tb1pgvn5gzm0q068sk7qlqnd5h694v046dtjawt3j3ysvesftgfvecysffm78f',
    regtest: 'bcrt1pgvn5gzm0q068sk7qlqnd5h694v046dtjawt3j3ysvesftgfvecysys3cjn',
    controlBlockLength: 97,
  },
  {
    name: 'V8 keyset2 no arbiter timeoutTo=buyer 1008',
    params: { buyer: K2.buyer, seller: K2.seller, timeoutTo: 'buyer', timeoutBlocks: 1008 },
    merkleRoot: 'ecbd74f6f31b337c608f7667bee66196faa944ddca5b783f77634a4cbedbb507',
    tweak: '3680ca1e9b137d088a82fbd4816b844e41efaf7f7508eb0fc72b2452400131df',
    outputKey: '6e98560f85d5b109d8d15b2f12e9154f3c4ed06d3b476e19b521a3ab1a5eb719',
    parity: 1,
    mainnet: '',
    testnet: '',
    regtest: 'bcrt1pd6v9vru96kcsnkx3tvh396g4fu7ya5rd8drkuxd4yx36kxj7kuvskwpwvu',
    controlBlockLength: 65,
  },
  {
    name: 'V9 keyset2 no arbiter timeoutTo=seller 2016',
    params: { buyer: K2.buyer, seller: K2.seller, timeoutTo: 'seller', timeoutBlocks: 2016 },
    merkleRoot: 'd728e6f6cb02e8d561c84c7ea5ea7d4974fdde3c66fbe8a045d5b802614c19e6',
    tweak: 'b501da3c3a6f02c5023c6e7ee9fd2c8765fe3d84d89dad4e27c6695b05225bc8',
    outputKey: 'e6e73b144d330604c9203da35157e7c4499c914ba0691155acf22aad64745988',
    parity: 1,
    mainnet: '',
    testnet: 'tb1pumnnk9zdxvrqfjfq8k34z4l8c3yeey2t5p53z4dv7g426er5txyqayv0wd',
    regtest: 'bcrt1pumnnk9zdxvrqfjfq8k34z4l8c3yeey2t5p53z4dv7g426er5txyqsaxfmh',
    controlBlockLength: 65,
  },
  {
    name: 'V10 keyset2 arbiter timeoutTo=seller 4320, the parity-0 counterpart',
    params: { ...K2, timeoutTo: 'seller', timeoutBlocks: 4320 },
    merkleRoot: '81324ca6d387075ceb91f636dc959d9002bb5d2ed193fb1945fd0baa0312798e',
    outputKey: 'cfb3483de7a3bf3648496dac53305cf6c5014590db80678aa80a44b8785a98a5',
    parity: 0,
    mainnet: '',
    testnet: 'tb1pe7e5s0085wlnvjzfdkk9xvzu7mzsz3vsmwqx0z4gpfzts7z6nzjsd6287y',
    regtest: 'bcrt1pe7e5s0085wlnvjzfdkk9xvzu7mzsz3vsmwqx0z4gpfzts7z6nzjsqrqpt7',
    controlBlockLength: 97,
  },
]

describe('reference vectors', () => {
  for (const v of VECTORS) {
    test(v.name, () => {
      const t = buildTree(v.params)
      expect(hex(t.merkleRoot)).toBe(v.merkleRoot)
      if (v.tweak) expect(hex(t.tweak)).toBe(v.tweak)
      expect(hex(t.outputKey)).toBe(v.outputKey)
      expect(t.parity).toBe(v.parity)
      expect(hex(t.scriptPubKey)).toBe('5120' + v.outputKey)
      if (v.mainnet) expect(t.addresses.mainnet).toBe(v.mainnet)
      if (v.testnet) {
        expect(t.addresses.testnet).toBe(v.testnet)
        // signet shares testnet's `tb` HRP: identical string, different chain.
        expect(t.addresses.signet).toBe(v.testnet)
      }
      expect(t.addresses.regtest).toBe(v.regtest)
      expect(t.controlBlockLength).toBe(v.controlBlockLength)
      for (const [label, h] of Object.entries(v.branches ?? {})) {
        expect(`${label}=${hex(t.branches.find((b) => b.label === label)!.hash)}`).toBe(
          `${label}=${h}`,
        )
      }
      for (const [name, cb] of Object.entries(v.controlBlocks ?? {})) {
        expect(`${name}=${hex(t.leaves[name as LeafName]!.controlBlock)}`).toBe(`${name}=${cb}`)
      }
      // The parity byte lives in control-block byte 0 and nowhere else.
      for (const leaf of t.leafList) {
        expect(leaf.controlBlock[0]).toBe(TAP_LEAF_VERSION | v.parity)
        expect(leaf.controlBlock.length).toBe(v.controlBlockLength)
        expect(hex(leaf.controlBlock.subarray(1, 33))).toBe(NUMS_HEX)
      }
    })
  }

  test('both parity values occur, so 0xc0 must never be hard-coded', () => {
    const parities = new Set(VECTORS.map((v) => buildTree(v.params).parity))
    expect([...parities].sort()).toEqual([0, 1])
  })
})

// ---------------------------------------------------------------------------
// differential: core/escrow's BIP-341 against @scure/btc-signer
// ---------------------------------------------------------------------------

/**
 * Build the same tree with the library.
 *
 * The nesting is written out rather than passed as a flat list.
 * @scure/btc-signer's taprootListToTree is a weighted (Huffman) builder: it
 * sorts by weight and merges the two lightest nodes. With four equal-weight
 * leaves it happens to reach a balanced shape with the same merkle root, but it
 * returns the leaves in DFS order C,D,A,B, and with any other leaf count or
 * weight it returns a skewed tree with a different root. p2tr also silently
 * routes any array whose length is not 2 through that helper, so a flat
 * [A,B,C,D] is not an explicit ((A,B),(C,D)). Nesting by hand compares the
 * same balanced shape buildTree builds.
 *
 * allowUnknownOutputs=true is required: the CSV timeout leaf decodes as
 * 'unknown' and p2tr otherwise throws "P2TR: invalid leaf script=unknown".
 */
function libraryTree(p: BuildTreeParams, network: typeof REGTEST) {
  const A = { script: cooperativeLeaf(p.buyer, p.seller) }
  const D = { script: timeoutLeaf(p.timeoutBlocks, p.timeoutTo === 'buyer' ? p.buyer : p.seller) }
  const tree = p.arbiter
    ? [
        [A, { script: cooperativeLeaf(p.seller, p.arbiter) }],
        [{ script: cooperativeLeaf(p.buyer, p.arbiter) }, D],
      ]
    : [A, D]
  return btc.p2tr(undefined, tree as never, network as never, true)
}

describe('differential against @scure/btc-signer', () => {
  for (const v of VECTORS) {
    test(`${v.name}: every derived byte agrees`, () => {
      const mine = buildTree(v.params)
      const theirs = libraryTree(v.params, REGTEST)

      expect(hex(theirs.tapMerkleRoot!)).toBe(hex(mine.merkleRoot))
      expect(hex(theirs.tweakedPubkey)).toBe(hex(mine.outputKey))
      expect(hex(theirs.script)).toBe(hex(mine.scriptPubKey))
      expect(hex(theirs.tapInternalKey)).toBe(hex(mine.internalKey))
      expect(theirs.address).toBe(mine.addresses.regtest)
      expect(btc.p2tr(undefined, treeOf(v.params), btc.NETWORK as never, true).address).toBe(
        mine.addresses.mainnet,
      )
      expect(btc.p2tr(undefined, treeOf(v.params), btc.TEST_NETWORK as never, true).address).toBe(
        mine.addresses.testnet,
      )

      // Find the library's leaves by script bytes, never by index: its leaf
      // array order comes from its tree walk, not from the order passed in.
      expect(theirs.leaves!.length).toBe(mine.leafList.length)
      for (const leaf of mine.leafList) {
        const match = theirs.leaves!.filter((l) => hex(l.script) === hex(leaf.script))
        expect(`${leaf.name} matches:${match.length}`).toBe(`${leaf.name} matches:1`)
        expect(`${leaf.name}/hash=${hex(leaf.hash)}`).toBe(`${leaf.name}/hash=${hex(match[0].hash)}`)
        expect(`${leaf.name}/cb=${hex(leaf.controlBlock)}`).toBe(
          `${leaf.name}/cb=${hex(match[0].controlBlock)}`,
        )
        expect(leaf.merklePath.map(hex)).toEqual(match[0].path.map(hex))
      }
    })
  }

  function treeOf(p: BuildTreeParams) {
    const A = { script: cooperativeLeaf(p.buyer, p.seller) }
    const D = { script: timeoutLeaf(p.timeoutBlocks, p.timeoutTo === 'buyer' ? p.buyer : p.seller) }
    return (
      p.arbiter
        ? [
            [A, { script: cooperativeLeaf(p.seller, p.arbiter) }],
            [{ script: cooperativeLeaf(p.buyer, p.arbiter) }, D],
          ]
        : [A, D]
    ) as never
  }

  test('taprootListToTree agrees on the root here, but reorders the leaves', () => {
    const p = VECTORS[0].params
    const leaves = [
      { script: cooperativeLeaf(p.buyer, p.seller) },
      { script: cooperativeLeaf(p.seller, p.arbiter!) },
      { script: cooperativeLeaf(p.buyer, p.arbiter!) },
      { script: timeoutLeaf(p.timeoutBlocks, p.buyer) },
    ]
    const listBuilt = btc.p2tr(undefined, btc.taprootListToTree(leaves) as never, REGTEST as never, true)
    const mine = buildTree(p)
    // Same address: with four equal weights the Huffman build lands on a
    // balanced shape, and TapBranch's sort hides any within-pair difference.
    expect(listBuilt.address).toBe(mine.addresses.regtest)
    expect(hex(listBuilt.tweakedPubkey)).toBe(hex(mine.outputKey))
    // ...but the leaf array comes back in a different order: leaves[0] is not
    // leaf A, so never index leaves by position.
    const listOrder = listBuilt.leaves!.map((l) => hex(l.script))
    const myOrder = mine.leafList.map((l) => hex(l.script))
    expect(listOrder).not.toEqual(myOrder)
    expect(new Set(listOrder)).toEqual(new Set(myOrder))
  })

  test('p2tr refuses the timeout leaf without allowUnknownOutputs', () => {
    const p = VECTORS[0].params
    expect(() =>
      btc.p2tr(
        undefined,
        [
          [
            { script: cooperativeLeaf(p.buyer, p.seller) },
            { script: cooperativeLeaf(p.seller, p.arbiter!) },
          ],
          [
            { script: cooperativeLeaf(p.buyer, p.arbiter!) },
            { script: timeoutLeaf(p.timeoutBlocks, p.buyer) },
          ],
        ] as never,
        REGTEST as never,
      ),
    ).toThrow(/unknown/i)
  })
})

// ---------------------------------------------------------------------------
// control blocks and independent verification
// ---------------------------------------------------------------------------

describe('control blocks', () => {
  test('4-leaf trees are uniformly 97 bytes, 2-leaf trees uniformly 65', () => {
    const four = buildTree({ ...K1, timeoutTo: 'buyer', timeoutBlocks: 4320 })
    expect(four.leafList.map((l) => l.controlBlock.length)).toEqual([97, 97, 97, 97])
    expect(four.leafList.map((l) => l.merklePath.length)).toEqual([2, 2, 2, 2])

    const two = buildTree({
      buyer: K1.buyer,
      seller: K1.seller,
      timeoutTo: 'buyer',
      timeoutBlocks: 1008,
    })
    expect(two.leafList.map((l) => l.controlBlock.length)).toEqual([65, 65])
    expect(two.leafList.map((l) => l.merklePath.length)).toEqual([1, 1])
    // 33 + 32*depth, both shapes.
    for (const t of [four, two]) {
      for (const l of t.leafList) {
        expect(l.controlBlock.length).toBe(33 + 32 * l.merklePath.length)
      }
    }
  })

  test('merkle paths are leaf-to-root, matching the balanced shape', () => {
    const t = buildTree({ ...K1, timeoutTo: 'buyer', timeoutBlocks: 4320 })
    const h = (n: LeafName) => hex(t.leaves[n]!.hash)
    const br = (label: string) => hex(t.branches.find((b) => b.label === label)!.hash)
    expect(t.leaves.A!.merklePath.map(hex)).toEqual([h('B'), br('branch(C,D)')])
    expect(t.leaves.B!.merklePath.map(hex)).toEqual([h('A'), br('branch(C,D)')])
    expect(t.leaves.C!.merklePath.map(hex)).toEqual([h('D'), br('branch(A,B)')])
    expect(t.leaves.D!.merklePath.map(hex)).toEqual([h('C'), br('branch(A,B)')])
  })

  test('verifyControlBlock re-derives the output key for every leaf', () => {
    for (const v of VECTORS) {
      const t = buildTree(v.params)
      for (const l of t.leafList) {
        expect(`${v.name}/${l.name}`).toBe(
          verifyControlBlock(l.script, l.controlBlock, t.outputKey) ? `${v.name}/${l.name}` : 'FAIL',
        )
      }
    }
  })

  test('verifyControlBlock rejects a flipped parity bit', () => {
    const t = buildTree({ ...K1, timeoutTo: 'buyer', timeoutBlocks: 4320 })
    const l = t.leaves.A!
    const bad = Uint8Array.from(l.controlBlock)
    bad[0] ^= 1
    // Core rejects this with "Witness program hash mismatch".
    expect(verifyControlBlock(l.script, bad, t.outputKey)).toBe(false)
  })

  test('verifyControlBlock rejects a path serialized root-down', () => {
    const t = buildTree({ ...K1, timeoutTo: 'buyer', timeoutBlocks: 4320 })
    const l = t.leaves.A!
    const reversed = concatBytes(
      l.controlBlock.subarray(0, 33),
      ...[...l.merklePath].reverse(),
    )
    // TapBranch sorts the pair it hashes; the path is never sorted. Conflating
    // the two builds a fundable address whose every spend is rejected.
    expect(verifyControlBlock(l.script, reversed, t.outputKey)).toBe(false)
  })

  test('verifyControlBlock rejects a path longer than the BIP-341 limit of 128 nodes', () => {
    // Bitcoin Core: TAPROOT_CONTROL_MAX_SIZE = 33 + 32*128 = 4129. A longer
    // control block is an invalid witness, and a checker that folds it anyway
    // returns true for a commitment that Core's VerifyTaprootCommitment
    // rejects on size before hashing a single branch.
    const internal = numsInternalKey()
    const script = Uint8Array.of(0x51)
    const deep = (nodes: number) => {
      let h = tapLeafHash(script)
      const path: Uint8Array[] = []
      for (let i = 0; i < nodes; i++) {
        const sibling = sha256(Uint8Array.of(i & 0xff, i >>> 8))
        path.push(sibling)
        h = tapBranchHash(h, sibling)
      }
      const { outputKey, parity } = deriveOutputKey(internal, h)
      return {
        cb: concatBytes(Uint8Array.of(TAP_LEAF_VERSION | parity), internal, ...path),
        outputKey,
      }
    }
    for (const nodes of [0, 1, 2, 127, 128]) {
      const { cb, outputKey } = deep(nodes)
      expect(`${nodes}:${cb.length}:${verifyControlBlock(script, cb, outputKey)}`).toBe(
        `${nodes}:${33 + 32 * nodes}:true`,
      )
    }
    for (const nodes of [129, 200]) {
      const { cb, outputKey } = deep(nodes)
      expect(`${nodes}:${cb.length}:${verifyControlBlock(script, cb, outputKey)}`).toBe(
        `${nodes}:${33 + 32 * nodes}:false`,
      )
    }
  })

  test('verifyControlBlock rejects 0x50 as a leaf version, without throwing', () => {
    const t = buildTree({ ...K1, timeoutTo: 'buyer', timeoutBlocks: 4320 })
    const l = t.leaves.A!
    const bad = Uint8Array.from(l.controlBlock)
    // c[0] & 0xfe == 0x50 is the annex marker, not a leaf version. tapLeafHash
    // throws on it; this is a verifier, so it answers false.
    bad[0] = 0x50 | (l.controlBlock[0] & 1)
    expect(verifyControlBlock(l.script, bad, t.outputKey)).toBe(false)
  })

  test('verifyControlBlock rejects the wrong leaf script and a malformed block', () => {
    const t = buildTree({ ...K1, timeoutTo: 'buyer', timeoutBlocks: 4320 })
    expect(verifyControlBlock(t.leaves.B!.script, t.leaves.A!.controlBlock, t.outputKey)).toBe(false)
    expect(verifyControlBlock(t.leaves.A!.script, t.leaves.A!.controlBlock.subarray(0, 96), t.outputKey))
      .toBe(false)
    expect(verifyControlBlock(t.leaves.A!.script, t.leaves.A!.controlBlock, new Uint8Array(32)))
      .toBe(false)
  })
})

// ---------------------------------------------------------------------------
// witness stacks
// ---------------------------------------------------------------------------

describe('witness stack order', () => {
  test('the party named second in the script signs first in the witness', () => {
    const t = buildTree({ ...K1, timeoutTo: 'buyer', timeoutBlocks: 4320 })
    expect(t.leaves.A!.witnessStack).toEqual([
      'sig_seller',
      'sig_buyer',
      'script_A',
      'control_block',
    ])
    expect(t.leaves.B!.witnessStack).toEqual([
      'sig_arbiter',
      'sig_seller',
      'script_B',
      'control_block',
    ])
    expect(t.leaves.C!.witnessStack).toEqual([
      'sig_arbiter',
      'sig_buyer',
      'script_C',
      'control_block',
    ])
    expect(t.leaves.D!.witnessStack).toEqual(['sig_buyer', 'script_D', 'control_block'])
    // scriptKeyOrder is the script's order; signatureOrder is its reverse.
    expect(t.leaves.A!.scriptKeyOrder).toEqual(['buyer', 'seller'])
    expect(t.leaves.A!.signatureOrder).toEqual(['seller', 'buyer'])
  })

  test('the timeout leaf pays whoever timeoutTo names', () => {
    const toBuyer = buildTree({ ...K1, timeoutTo: 'buyer', timeoutBlocks: 1008 })
    const toSeller = buildTree({ ...K1, timeoutTo: 'seller', timeoutBlocks: 1008 })
    expect(toBuyer.leaves.D!.witnessStack[0]).toBe('sig_buyer')
    expect(toSeller.leaves.D!.witnessStack[0]).toBe('sig_seller')
    expect(hex(toBuyer.leaves.D!.script).includes(hex(K1.buyer))).toBe(true)
    expect(hex(toSeller.leaves.D!.script).includes(hex(K1.seller))).toBe(true)
    // Leaves A/B/C are byte-identical across the two stages; only D moves.
    for (const n of ['A', 'B', 'C'] as LeafName[]) {
      expect(hex(toBuyer.leaves[n]!.script)).toBe(hex(toSeller.leaves[n]!.script))
    }
  })

  test('nSequence: RBF on A/B/C, the timelock itself on D', () => {
    const t = buildTree({ ...K1, timeoutTo: 'buyer', timeoutBlocks: 4320 })
    expect(t.txVersion).toBe(2)
    expect(t.leaves.A!.sequence).toBe(RBF_SEQUENCE)
    expect(t.leaves.B!.sequence).toBe(RBF_SEQUENCE)
    expect(t.leaves.C!.sequence).toBe(RBF_SEQUENCE)
    // The field carries the lock; bit 31 (disable) and bit 22 (512s units) must
    // be clear, which rules out 0xfffffffd on this input.
    expect(t.leaves.D!.sequence).toBe(4320)
    expect(t.leaves.D!.sequence & 0x80000000).toBe(0)
    expect(t.leaves.D!.sequence & 0x00400000).toBe(0)
    expect(t.leaves.D!.sequence & 0x0000ffff).toBe(4320)
  })
})

// ---------------------------------------------------------------------------
// addresses
// ---------------------------------------------------------------------------

describe('address encoding', () => {
  test('is bech32m, not bech32', () => {
    const t = buildTree({ ...K2, timeoutTo: 'buyer', timeoutBlocks: 1008 })
    const words = [1, ...bech32m.toWords(t.outputKey)]
    expect(t.addresses.regtest).toBe(bech32m.encode('bcrt', words))
    // The bech32 form differs only in the 6-character checksum: it looks right
    // and is never accepted.
    const wrong = bech32.encode('bcrt', words)
    expect(wrong).toBe('bcrt1p39dcth57nqds9gknv0wsr3yqlvs9ck66x85xltlcvysjdcmlludsy0zj2p')
    expect(t.addresses.regtest).not.toBe(wrong)
    expect(t.addresses.regtest.slice(0, -6)).toBe(wrong.slice(0, -6))
    expect(() => bech32.decode(t.addresses.regtest as never)).toThrow()
  })

  test('round-trips through the library decoder to the same scriptPubKey', () => {
    const t = buildTree({ ...K1, timeoutTo: 'buyer', timeoutBlocks: 4320 })
    const decoded = btc.Address(REGTEST as never).decode(t.addresses.regtest)
    expect(decoded.type).toBe('tr')
    expect(hex((decoded as { pubkey: Uint8Array }).pubkey)).toBe(hex(t.outputKey))
    expect(hex(btc.OutScript.encode(decoded))).toBe(hex(t.scriptPubKey))
  })

  test('the scriptPubKey is network-independent; only the HRP changes', () => {
    const t = buildTree({ ...K1, timeoutTo: 'buyer', timeoutBlocks: 4320 })
    expect(t.addresses.mainnet.startsWith('bc1p')).toBe(true)
    expect(t.addresses.regtest.startsWith('bcrt1p')).toBe(true)
    expect(encodeTaprootAddress(t.outputKey, 'bc')).toBe(t.addresses.mainnet)
    expect(() => encodeTaprootAddress(new Uint8Array(31), 'bc')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// determinism and purity
// ---------------------------------------------------------------------------

describe('determinism and purity', () => {
  function fingerprint(t: EscrowTree): string {
    return JSON.stringify(describeTree(t))
  }

  test('same inputs, same bytes, twice', () => {
    for (const v of VECTORS) {
      expect(fingerprint(buildTree(v.params))).toBe(fingerprint(buildTree(v.params)))
    }
  })

  test('the returned tree does not alias input arrays from the caller', () => {
    const buyer = Uint8Array.from(K1.buyer)
    const t = buildTree({ buyer, seller: K1.seller, timeoutTo: 'buyer', timeoutBlocks: 1008 })
    const before = fingerprint(t)
    buyer.fill(0)
    expect(fingerprint(t)).toBe(before)
    expect(hex(t.params.buyer)).toBe(hex(K1.buyer))
  })

  test('mutating a returned array does not affect the next build', () => {
    const p: BuildTreeParams = { ...K1, timeoutTo: 'buyer', timeoutBlocks: 4320 }
    const a = buildTree(p)
    a.internalKey.fill(0)
    a.outputKey.fill(0)
    expect(hex(buildTree(p).outputKey)).toBe(
      '6f49cbafea2522800a955088f92ac3dcb6fd95a429fbc0b5530230c05116b01a',
    )
  })

  test('the exported constant tables are frozen, not merely `as const`', () => {
    // `as const` is a type-level annotation; the runtime object stays writable.
    // OP and NETWORK_HRP are read at derivation time, so an unfrozen table lets
    // any consumer in the process rewrite every later leaf script and address.
    // Turning CHECKSIGVERIFY into CHECKSIG would silently make leaf A a 1-of-2
    // that one party can drain alone.
    expect(Object.isFrozen(OP)).toBe(true)
    expect(Object.isFrozen(NETWORK_HRP)).toBe(true)
    expect(() => {
      ;(OP as unknown as Record<string, number>).CHECKSIGVERIFY = 0xac
    }).toThrow()
    expect(() => {
      ;(NETWORK_HRP as unknown as Record<string, string>).mainnet = 'tb'
    }).toThrow()
    expect(OP.CHECKSIGVERIFY).toBe(0xad)
    const t = buildTree({ ...K1, timeoutTo: 'buyer', timeoutBlocks: 4320 })
    expect(hex(t.leaves.A!.script).slice(66, 68)).toBe('ad')
    expect(t.addresses.mainnet.startsWith('bc1p')).toBe(true)
  })

  test('the returned tree is frozen, container by container', () => {
    const t = buildTree({ ...K1, timeoutTo: 'buyer', timeoutBlocks: 4320 })
    const containers: [string, object][] = [
      ['tree', t],
      ['params', t.params],
      ['leaves', t.leaves],
      ['leafList', t.leafList],
      ['branches', t.branches],
      ['addresses', t.addresses],
      ...t.branches.map((b, i): [string, object] => [`branches[${i}]`, b]),
      ...t.leafList.flatMap((l): [string, object][] => [
        [`leaf ${l.name}`, l],
        [`leaf ${l.name}.merklePath`, l.merklePath],
        [`leaf ${l.name}.scriptKeyOrder`, l.scriptKeyOrder],
        [`leaf ${l.name}.signatureOrder`, l.signatureOrder],
        [`leaf ${l.name}.witnessStack`, l.witnessStack],
      ]),
    ]
    for (const [label, container] of containers) {
      expect(`${label}:${Object.isFrozen(container)}`).toBe(`${label}:true`)
    }

    // params echoes the validated inputs so an auditor need not trust the
    // caller, and the object graph is shared (leaves.A is leafList[0];
    // leaves.B.hash is leaves.A.merklePath[0]), so a single stray write would
    // propagate and make the echo disagree with the bytes it describes.
    expect(t.leaves.A).toBe(t.leafList[0])
    expect(() => {
      ;(t.params as unknown as Record<string, unknown>).buyer = new Uint8Array(32)
    }).toThrow()
    expect(() => {
      ;(t as unknown as Record<string, unknown>).merkleRoot = new Uint8Array(32)
    }).toThrow()
    expect(() => t.leafList.push(t.leafList[0])).toThrow()
    expect(() => t.branches.pop()).toThrow()
    expect(() => {
      ;(t.addresses as unknown as Record<string, string>).mainnet = 'bc1pnope'
    }).toThrow()
    expect(() => t.leaves.A!.merklePath.reverse()).toThrow()

    // The limit: a Uint8Array cannot be frozen (the engine throws "Attempting
    // to store non-configurable property on a typed array"), so the bytes are
    // read-only by contract only, as EscrowTree documents.
    expect(Object.isFrozen(t.params.buyer)).toBe(false)
  })

  test('core/escrow has no I/O, no environment assumptions, no hidden entropy', () => {
    // Guards the core/README.md rules for these files: recover.html runs this
    // code from file:// with no server.
    const forbidden: [RegExp, string][] = [
      [/\bfrom\s+['"]node:/, 'node: import'],
      [/\brequire\s*\(/, 'require()'],
      [/\bfetch\s*\(/, 'fetch'],
      [/\bBuffer\b/, 'Buffer'],
      [/\bMath\.random\b/, 'Math.random'],
      [/\bDate\b/, 'Date'],
      [/\bprocess\./, 'process'],
      [/\bglobalThis\b/, 'globalThis'],
      [/\bwindow\./, 'window'],
      [/\blocalStorage\b/, 'localStorage'],
      [/\bcrypto\.getRandomValues\b/, 'getRandomValues'],
      [/randomBytes/, 'randomBytes'],
    ]
    for (const file of ['tagged.ts', 'script.ts', 'tree.ts', 'index.ts']) {
      const src = readFileSync(new URL(`../../core/escrow/${file}`, import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
        .replace(/^\s*\/\/.*$/gm, '') // line comments
      for (const [re, label] of forbidden) {
        expect(`${file}:${label}:${re.test(src)}`).toBe(`${file}:${label}:false`)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// validation: the library enforces none of this
// ---------------------------------------------------------------------------

describe('input validation', () => {
  const base = { ...K1, timeoutTo: 'buyer' as const, timeoutBlocks: 1008 }

  test('rejects a key that is not 32 bytes', () => {
    expect(() => buildTree({ ...base, buyer: new Uint8Array(31) })).toThrow(/32-byte/)
    expect(() => buildTree({ ...base, seller: new Uint8Array(33) })).toThrow(/32-byte/)
    expect(() => buildTree({ ...base, arbiter: new Uint8Array(0) })).toThrow(/32-byte/)
  })

  test('rejects a key that is not a Uint8Array', () => {
    expect(() => buildTree({ ...base, buyer: NUMS_INTERNAL_KEY_HEX as never })).toThrow(/Uint8Array/)
    expect(() => buildTree({ ...base, seller: undefined as never })).toThrow(/Uint8Array/)
    expect(() => buildTree({ ...base, arbiter: null as never })).toThrow(/omit the property/)
  })

  test('rejects a 32-byte value that is not a point on the curve', () => {
    // A leaf built around this would derive a fundable address that nobody can
    // ever satisfy. The library does not check leaf keys at all.
    expect(() => buildTree({ ...base, buyer: new Uint8Array(32) })).toThrow(/valid x-only point/)
    expect(() => buildTree({ ...base, seller: hexToBytes('ff'.repeat(32)) })).toThrow(
      /valid x-only point/,
    )
  })

  test('rejects any party key equal to the NUMS internal key', () => {
    expect(() => buildTree({ ...base, buyer: numsInternalKey() })).toThrow(/NUMS/)
    expect(() => buildTree({ ...base, arbiter: numsInternalKey() })).toThrow(/NUMS/)
  })

  test('rejects duplicate parties', () => {
    // buyer === seller collapses leaf A into a single-signer path: one party
    // drains the escrow alone.
    expect(() => buildTree({ ...base, seller: K1.buyer })).toThrow(/buyer and seller/)
    expect(() => buildTree({ ...base, arbiter: K1.buyer })).toThrow(/differ from buyer/)
    expect(() => buildTree({ ...base, arbiter: K1.seller })).toThrow(/differ from seller/)
  })

  test('rejects unknown parameters, including the wire name arbiter_x', () => {
    // The no-arbiter tree is chosen by leaving `arbiter` out, so without this
    // check an arbiter key under any other name would be dropped and buildTree
    // would return the two-leaf tree, at a different address, with no error.
    // The escrow event's wire field is `arbiter_x`, so an event spread
    // straight in is the likely way to make this mistake.
    const event: Record<string, unknown> = { ...base, arbiter_x: K1.arbiter }
    delete event.arbiter
    expect(() => buildTree(event as never)).toThrow(/unknown parameter "arbiter_x"/)
    expect(() => buildTree({ ...base, arbitor: K1.arbiter } as never)).toThrow(/unknown parameter/)
    expect(() => buildTree({ ...base, network: 'signet' } as never)).toThrow(/unknown parameter/)
    // TypeScript catches none of this: excess-property checking does not apply
    // to a spread or a variable, `arbiter` is optional, and the pages in web/
    // call buildTree from untyped JavaScript.
    expect(buildTree({ ...base }).shape).toBe('arbiter-4leaf')
    expect(
      buildTree({ buyer: K1.buyer, seller: K1.seller, timeoutTo: 'buyer', timeoutBlocks: 1008 })
        .shape,
    ).toBe('no-arbiter-2leaf')
  })

  test('rejects a timeoutTo that is not exactly buyer or seller', () => {
    expect(() => buildTree({ ...base, timeoutTo: 'arbiter' as never })).toThrow(/timeoutTo/)
    expect(() => buildTree({ ...base, timeoutTo: 'Buyer' as never })).toThrow(/timeoutTo/)
    expect(() => buildTree({ ...base, timeoutTo: undefined as never })).toThrow(/timeoutTo/)
  })

  test('rejects a timeoutBlocks outside the BIP-68 block range', () => {
    // Above 65535 BIP-112 masks the operand: 65546 executes as 10 blocks, so a
    // month-long timeout would silently become a 10-block one.
    expect(() => buildTree({ ...base, timeoutBlocks: 0 })).toThrow(/1\.\.65535/)
    expect(() => buildTree({ ...base, timeoutBlocks: -1 })).toThrow(/1\.\.65535/)
    expect(() => buildTree({ ...base, timeoutBlocks: 65536 })).toThrow(/1\.\.65535/)
    expect(() => buildTree({ ...base, timeoutBlocks: 65546 })).toThrow(/1\.\.65535/)
    expect(() => buildTree({ ...base, timeoutBlocks: 1008.5 })).toThrow(/integer/)
    expect(() => buildTree({ ...base, timeoutBlocks: '1008' as never })).toThrow(/integer/)
    expect(() => buildTree({ ...base, timeoutBlocks: NaN })).toThrow(/integer/)
    // The boundaries themselves are accepted.
    expect(buildTree({ ...base, timeoutBlocks: 1 }).leaves.D!.script.length).toBe(37)
    expect(buildTree({ ...base, timeoutBlocks: 65535 }).leaves.D!.script.length).toBe(40)
  })

  test('a rejected timeoutBlocks is rendered so a string cannot pass for a number', () => {
    // On the JSON paths (the escrow event, the recovery flow) a number can
    // arrive as a string, and String("4320") would make the message read
    // "expected an integer, got 4320", which contradicts itself and sends the
    // reader hunting for a range problem that is not there.
    expect(() => buildTree({ ...base, timeoutBlocks: '4320' as never })).toThrow(/got "4320"/)
    expect(() => buildTree({ ...base, timeoutBlocks: true as never })).toThrow(/got true/)
    // ...while a real number still renders bare, with no quotes.
    expect(() => buildTree({ ...base, timeoutBlocks: 4320.5 })).toThrow(/got 4320\.5/)
    // JSON.stringify alone would render NaN and Infinity as `null`, and it
    // throws on the BigInt.
    expect(() => buildTree({ ...base, timeoutBlocks: NaN })).toThrow(/got NaN/)
    expect(() => buildTree({ ...base, timeoutBlocks: Infinity })).toThrow(/got Infinity/)
    expect(() => buildTree({ ...base, timeoutBlocks: 4320n as never })).toThrow(/got 4320n/)
  })

  test('rejects a missing params object', () => {
    expect(() => buildTree(null as never)).toThrow()
    expect(() => buildTree(undefined as never)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// shape
// ---------------------------------------------------------------------------

describe('tree shape', () => {
  test('arbiter present builds four leaves, absent builds two', () => {
    const four = buildTree({ ...K1, timeoutTo: 'buyer', timeoutBlocks: 4320 })
    expect(four.shape).toBe('arbiter-4leaf')
    expect(four.leafList.map((l) => l.name)).toEqual(['A', 'B', 'C', 'D'])
    expect(four.leafList.map((l) => l.role)).toEqual([
      'cooperative',
      'arbiter-release',
      'arbiter-refund',
      'timeout',
    ])
    expect(four.branches.map((b) => b.label)).toEqual([
      'branch(A,B)',
      'branch(C,D)',
      'root = branch(branch(A,B),branch(C,D))',
    ])

    const two = buildTree({
      buyer: K1.buyer,
      seller: K1.seller,
      timeoutTo: 'buyer',
      timeoutBlocks: 1008,
    })
    expect(two.shape).toBe('no-arbiter-2leaf')
    expect(two.leafList.map((l) => l.name)).toEqual(['A', 'D'])
    expect(two.leaves.B).toBeUndefined()
    expect(two.leaves.C).toBeUndefined()
    expect(two.params.arbiter).toBeUndefined()
    expect(hex(two.merkleRoot)).toBe(hex(tapBranchHash(two.leaves.A!.hash, two.leaves.D!.hash)))
  })

  test('the grouping is fixed: ((A,B),(C,D)) is not ((A,C),(B,D))', () => {
    const t = buildTree({ ...K1, timeoutTo: 'buyer', timeoutBlocks: 4320 })
    const h = (n: LeafName) => t.leaves[n]!.hash
    const mandated = tapBranchHash(tapBranchHash(h('A'), h('B')), tapBranchHash(h('C'), h('D')))
    const other = tapBranchHash(tapBranchHash(h('A'), h('C')), tapBranchHash(h('B'), h('D')))
    expect(hex(t.merkleRoot)).toBe(hex(mandated))
    expect(hex(t.merkleRoot)).not.toBe(hex(other))
    // Swapping siblings within a pair is invisible, because TapBranch sorts.
    const swapped = tapBranchHash(tapBranchHash(h('B'), h('A')), tapBranchHash(h('D'), h('C')))
    expect(hex(swapped)).toBe(hex(mandated))
  })

  test('deriveOutputKey is the whole tweak, exposed for auditing', () => {
    const t = buildTree({ ...K1, timeoutTo: 'buyer', timeoutBlocks: 4320 })
    const again = deriveOutputKey(numsInternalKey(), t.merkleRoot)
    expect(hex(again.tweak)).toBe(hex(t.tweak))
    expect(hex(again.outputKey)).toBe(hex(t.outputKey))
    expect(again.parity).toBe(t.parity)
    // Matches the library's own tweak helper. (It lives on btc.utils, not the
    // package root, which exports taprootNumsKey and TaprootControlBlock.)
    const [libKey, libParity] = btc.utils.taprootTweakPubkey(numsInternalKey(), t.merkleRoot)
    expect(hex(libKey)).toBe(hex(t.outputKey))
    expect(libParity).toBe(t.parity)
  })

  test('describeTree renders every derived value for an auditor', () => {
    const d = describeTree(buildTree({ ...K1, timeoutTo: 'buyer', timeoutBlocks: 4320 }))
    expect(d.merkleRoot).toBe('5c8a3100eae52ecdb7655739b23efcfbcf087b8e36f31e23dbd71c356dc88397')
    expect(d.parity).toBe(1)
    expect(d.leaves).toHaveLength(4)
    expect(d.leaves[0].scriptBytes).toBe(68)
    expect(d.leaves[3].sequence).toBe('0x000010e0 (4320)')
    expect(d.addresses.signet).toBe(d.addresses.testnet)
  })
})
