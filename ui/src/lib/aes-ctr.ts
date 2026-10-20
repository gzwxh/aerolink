// 纯 JS 的 AES-256-CTR，只在没有 WebCrypto 时使用（http://<内网IP> 不是安全上下文）。
//
// 浏览器只负责加密：MAC 由服务端用 Go 的 crypto/hmac 校验，所以这里不需要实现解密，
// 也不需要 GHASH/Poly1305。S 盒按 FIPS-197 的定义现算（GF(2^8) 逆元 + 仿射变换），
// 避免手抄 256 字节常量；正确性由 aes-ctr.test.ts 与 Node 的 OpenSSL 实现交叉验证。

function gfMultiply(a: number, b: number): number {
  let result = 0
  let x = a
  let y = b
  for (let i = 0; i < 8; i += 1) {
    if (y & 1) {
      result ^= x
    }
    const high = x & 0x80
    x = (x << 1) & 0xff
    if (high) {
      x ^= 0x1b
    }
    y >>= 1
  }
  return result
}

function rotl8(value: number, bits: number): number {
  return ((value << bits) | (value >> (8 - bits))) & 0xff
}

const SBOX = (() => {
  const sbox = new Uint8Array(256)
  for (let x = 0; x < 256; x += 1) {
    let inverse = 0
    if (x !== 0) {
      for (let candidate = 1; candidate < 256; candidate += 1) {
        if (gfMultiply(x, candidate) === 1) {
          inverse = candidate
          break
        }
      }
    }
    sbox[x] =
      (inverse ^
        rotl8(inverse, 1) ^
        rotl8(inverse, 2) ^
        rotl8(inverse, 3) ^
        rotl8(inverse, 4) ^
        0x63) &
      0xff
  }
  return sbox
})()

function xtime(value: number): number {
  return ((value << 1) ^ (value & 0x80 ? 0x1b : 0)) & 0xff
}

// AES-256：Nk=8，Nr=14，展开成 15 组 16 字节轮密钥。
function expandKey(key: Uint8Array): Uint8Array {
  const rounds = 15
  const words = 4 * rounds
  const schedule = new Uint8Array(16 * rounds)
  schedule.set(key)
  let rcon = 1

  for (let word = 8; word < words; word += 1) {
    const prev = (word - 1) * 4
    let b0 = schedule[prev]
    let b1 = schedule[prev + 1]
    let b2 = schedule[prev + 2]
    let b3 = schedule[prev + 3]

    if (word % 8 === 0) {
      const rotated = b0
      b0 = SBOX[b1] ^ rcon
      b1 = SBOX[b2]
      b2 = SBOX[b3]
      b3 = SBOX[rotated]
      rcon = xtime(rcon)
    } else if (word % 8 === 4) {
      b0 = SBOX[b0]
      b1 = SBOX[b1]
      b2 = SBOX[b2]
      b3 = SBOX[b3]
    }

    const base = (word - 8) * 4
    schedule[word * 4] = schedule[base] ^ b0
    schedule[word * 4 + 1] = schedule[base + 1] ^ b1
    schedule[word * 4 + 2] = schedule[base + 2] ^ b2
    schedule[word * 4 + 3] = schedule[base + 3] ^ b3
  }
  return schedule
}

function addRoundKey(state: Uint8Array, schedule: Uint8Array, round: number): void {
  const offset = round * 16
  for (let i = 0; i < 16; i += 1) {
    state[i] ^= schedule[offset + i]
  }
}

function subBytes(state: Uint8Array): void {
  for (let i = 0; i < 16; i += 1) {
    state[i] = SBOX[state[i]]
  }
}

// 状态按列优先存放：state[row + 4 * column]。第 r 行循环左移 r 个字节。
function shiftRows(state: Uint8Array): void {
  let tmp = state[1]
  state[1] = state[5]
  state[5] = state[9]
  state[9] = state[13]
  state[13] = tmp

  tmp = state[2]
  state[2] = state[10]
  state[10] = tmp
  tmp = state[6]
  state[6] = state[14]
  state[14] = tmp

  tmp = state[15]
  state[15] = state[11]
  state[11] = state[7]
  state[7] = state[3]
  state[3] = tmp
}

function mixColumns(state: Uint8Array): void {
  for (let column = 0; column < 16; column += 4) {
    const a0 = state[column]
    const a1 = state[column + 1]
    const a2 = state[column + 2]
    const a3 = state[column + 3]
    state[column] = xtime(a0) ^ (xtime(a1) ^ a1) ^ a2 ^ a3
    state[column + 1] = a0 ^ xtime(a1) ^ (xtime(a2) ^ a2) ^ a3
    state[column + 2] = a0 ^ a1 ^ xtime(a2) ^ (xtime(a3) ^ a3)
    state[column + 3] = (xtime(a0) ^ a0) ^ a1 ^ a2 ^ xtime(a3)
  }
}

function encryptBlock(input: Uint8Array, schedule: Uint8Array, output: Uint8Array): void {
  const state = new Uint8Array(16)
  state.set(input)
  addRoundKey(state, schedule, 0)
  for (let round = 1; round < 14; round += 1) {
    subBytes(state)
    shiftRows(state)
    mixColumns(state)
    addRoundKey(state, schedule, round)
  }
  subBytes(state)
  shiftRows(state)
  addRoundKey(state, schedule, 14)
  output.set(state)
}

/**
 * AES-256-CTR 加密。计数器是 16 字节大端整数，从 iv 起递增，与服务端 crypto/cipher 的
 * CTR 模式一致。
 */
export function aesCtrEncrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  if (key.length !== 32) {
    throw new Error('AES-256 requires a 32-byte key')
  }
  if (iv.length !== 16) {
    throw new Error('AES-CTR requires a 16-byte counter block')
  }
  const schedule = expandKey(key)
  const counter = new Uint8Array(16)
  counter.set(iv)
  const stream = new Uint8Array(16)
  const output = new Uint8Array(data.length)

  for (let offset = 0; offset < data.length; offset += 16) {
    encryptBlock(counter, schedule, stream)
    const limit = Math.min(16, data.length - offset)
    for (let i = 0; i < limit; i += 1) {
      output[offset + i] = data[offset + i] ^ stream[i]
    }
    for (let i = 15; i >= 0; i -= 1) {
      counter[i] = (counter[i] + 1) & 0xff
      if (counter[i] !== 0) {
        break
      }
    }
  }
  return output
}
