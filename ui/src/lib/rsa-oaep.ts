// 纯 JS 的 RSA-OAEP(SHA-256) 加密，只在没有 WebCrypto 时使用。
//
// crypto.subtle 仅存在于安全上下文（https / localhost / file）：用 http://<内网IP>:8080
// 打开页面时它是 undefined，而登录表单在那之前就要把口令加密。这里只做「用公钥加密」
// 这一件事，正确性由 rsa-oaep.test.ts 与 Node 的 OpenSSL 实现交叉验证。
//
// 它不改变「无 TLS 时整条链路仍可被中间人看到」的事实：JS 本身也是从同一个源加载的。

import { concatBytes, sha256, writeUint32 } from './sha256'

const HASH_BYTES = 32

function mgf1(seed: Uint8Array, length: number): Uint8Array {
  const output = new Uint8Array(length)
  const counter = new Uint8Array(4)
  let written = 0
  for (let i = 0; written < length; i += 1) {
    writeUint32(counter, 0, i)
    const input = new Uint8Array(seed.length + 4)
    input.set(seed)
    input.set(counter, seed.length)
    const digest = sha256(input)
    output.set(digest.subarray(0, Math.min(digest.length, length - written)), written)
    written += digest.length
  }
  return output
}

function xorBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const output = new Uint8Array(left.length)
  for (let i = 0; i < left.length; i += 1) {
    output[i] = left[i] ^ right[i]
  }
  return output
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte)
  }
  return value
}

function bigIntToBytes(value: bigint, length: number): Uint8Array {
  const output = new Uint8Array(length)
  let rest = value
  for (let i = length - 1; i >= 0; i -= 1) {
    output[i] = Number(rest & 0xffn)
    rest >>= 8n
  }
  if (rest !== 0n) {
    throw new Error('integer does not fit into output length')
  }
  return output
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n
  let factor = base % modulus
  let rest = exponent
  while (rest > 0n) {
    if (rest & 1n) {
      result = (result * factor) % modulus
    }
    factor = (factor * factor) % modulus
    rest >>= 1n
  }
  return result
}

interface Tlv {
  tag: number
  start: number
  end: number
}

function readTlv(bytes: Uint8Array, offset: number): Tlv {
  const tag = bytes[offset]
  let length = bytes[offset + 1]
  let cursor = offset + 2
  if (length & 0x80) {
    const count = length & 0x7f
    length = 0
    for (let i = 0; i < count; i += 1) {
      length = length * 256 + bytes[cursor + i]
    }
    cursor += count
  }
  return { tag, start: cursor, end: cursor + length }
}

// 解析 SubjectPublicKeyInfo：SEQUENCE{ AlgorithmIdentifier, BIT STRING { RSAPublicKey } }
export function parseRsaPublicKey(spki: Uint8Array): { modulus: bigint; exponent: bigint } {
  const outer = readTlv(spki, 0)
  if (outer.tag !== 0x30) {
    throw new Error('public key is not a DER sequence')
  }
  const algorithm = readTlv(spki, outer.start)
  const bitString = readTlv(spki, algorithm.end)
  if (bitString.tag !== 0x03) {
    throw new Error('public key is not an RSA SubjectPublicKeyInfo')
  }
  // BIT STRING 首字节是「未使用位数」，RSA 公钥恒为 0。
  const keySequence = readTlv(spki, bitString.start + 1)
  const modulusTlv = readTlv(spki, keySequence.start)
  const exponentTlv = readTlv(spki, modulusTlv.end)
  if (modulusTlv.tag !== 0x02 || exponentTlv.tag !== 0x02) {
    throw new Error('public key is not a DER integer pair')
  }
  return {
    modulus: bytesToBigInt(spki.subarray(modulusTlv.start, modulusTlv.end)),
    exponent: bytesToBigInt(spki.subarray(exponentTlv.start, exponentTlv.end)),
  }
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

export function rsaOaepEncrypt(
  spki: Uint8Array,
  message: Uint8Array,
  random: (length: number) => Uint8Array = randomBytes
): Uint8Array {
  const { modulus, exponent } = parseRsaPublicKey(spki)
  const modulusLength = Math.ceil(modulus.toString(2).length / 8)
  if (message.length > modulusLength - 2 * HASH_BYTES - 2) {
    throw new Error('message too long for the public key')
  }

  // 服务端用 rsa.EncryptOAEP/DecryptOAEP 且 label 为 nil，等价于空串。
  const labelHash = sha256(new Uint8Array(0))
  const padding = new Uint8Array(modulusLength - message.length - 2 * HASH_BYTES - 2)
  const dataBlock = concatBytes([labelHash, padding, Uint8Array.of(1), message])

  const seed = random(HASH_BYTES)
  const maskedDataBlock = xorBytes(dataBlock, mgf1(seed, dataBlock.length))
  const maskedSeed = xorBytes(seed, mgf1(maskedDataBlock, HASH_BYTES))
  const encoded = concatBytes([Uint8Array.of(0), maskedSeed, maskedDataBlock])

  const cipher = modPow(bytesToBigInt(encoded), exponent, modulus)
  return bigIntToBytes(cipher, modulusLength)
}
