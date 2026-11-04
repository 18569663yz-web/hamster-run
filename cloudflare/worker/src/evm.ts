// Minimal EVM personal_sign (EIP-191) verification: Keccak-256 hashing plus
// secp256k1 public-key recovery, implemented with BigInt so the artifact
// needs no external crypto dependency. No transaction is ever made — a
// signature only proves the player controls the address.

// ---- Keccak-256 (Keccak-f[1600], rate 1088, suffix 0x01) ----

const MASK64 = (1n << 64n) - 1n;

const KECCAK_RC: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

const KECCAK_ROT: number[] = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

const KECCAK_PI: number[] = [
  0, 10, 20, 5, 15, 16, 1, 11, 21, 6, 7, 17, 2, 12, 22, 23, 8, 18, 3, 13, 14, 24, 9, 19, 4,
];

function rotl64(x: bigint, n: number): bigint {
  if (n === 0) return x;
  const b = BigInt(n);
  return ((x << b) | (x >> (64n - b))) & MASK64;
}

function keccakF(state: bigint[]) {
  for (let round = 0; round < 24; round++) {
    // theta
    const c: bigint[] = new Array(5).fill(0n);
    for (let x = 0; x < 5; x++) {
      c[x] = state[x]! ^ state[x + 5]! ^ state[x + 10]! ^ state[x + 15]! ^ state[x + 20]!;
    }
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5]! ^ rotl64(c[(x + 1) % 5]!, 1);
      for (let y = 0; y < 5; y++) state[x + 5 * y] = state[x + 5 * y]! ^ d;
    }
    // rho + pi
    const b: bigint[] = new Array(25).fill(0n);
    for (let i = 0; i < 25; i++) {
      b[KECCAK_PI[i]!] = rotl64(state[i]!, KECCAK_ROT[i]!);
    }
    // chi
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        state[x + 5 * y] =
          b[x + 5 * y]! ^ (~b[((x + 1) % 5) + 5 * y]! & b[((x + 2) % 5) + 5 * y]!);
      }
    }
    // iota
    state[0] = state[0]! ^ KECCAK_RC[round]!;
  }
}

export function keccak256(data: Uint8Array): Uint8Array {
  const rate = 136; // bytes for 256-bit output
  const state: bigint[] = new Array(25).fill(0n);
  const padded = new Uint8Array(data.length + (rate - (data.length % rate)));
  padded.set(data);
  padded[data.length] = 0x01;
  padded[padded.length - 1] = padded[padded.length - 1]! | 0x80;
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let j = 0; j < 8; j++) {
        lane |= BigInt(padded[off + i * 8 + j]!) << BigInt(8 * j);
      }
      state[i] = state[i]! ^ lane;
    }
    keccakF(state);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = state[i]!;
    for (let j = 0; j < 8; j++) {
      out[i * 8 + j] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// ---- secp256k1 recovery ----

const FIELD_P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const ORDER_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

function mod(a: bigint, m: bigint): bigint {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

function modInv(a: bigint, m: bigint): bigint {
  return modPow(a, m - 2n, m);
}

interface Point {
  x: bigint;
  y: bigint;
}

function pointAdd(p1: Point | null, p2: Point | null): Point | null {
  if (!p1) return p2;
  if (!p2) return p1;
  if (p1.x === p2.x) {
    if (mod(p1.y + p2.y, FIELD_P) === 0n) return null;
    const s = mod(3n * p1.x * p1.x * modInv(2n * p1.y, FIELD_P), FIELD_P);
    const x = mod(s * s - 2n * p1.x, FIELD_P);
    const y = mod(s * (p1.x - x) - p1.y, FIELD_P);
    return { x, y };
  }
  const s = mod((p2.y - p1.y) * modInv(p2.x - p1.x, FIELD_P), FIELD_P);
  const x = mod(s * s - p1.x - p2.x, FIELD_P);
  const y = mod(s * (p1.x - x) - p1.y, FIELD_P);
  return { x, y };
}

function pointMul(k: bigint, p: Point): Point | null {
  let result: Point | null = null;
  let addend: Point | null = p;
  let scalar = mod(k, ORDER_N);
  while (scalar > 0n) {
    if (scalar & 1n) result = pointAdd(result, addend);
    addend = pointAdd(addend, addend);
    scalar >>= 1n;
  }
  return result;
}

function bigintFromBytes(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

function bigintTo32Bytes(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

export function publicKeyToAddress(x: bigint, y: bigint): string {
  const pub = new Uint8Array(64);
  pub.set(bigintTo32Bytes(x), 0);
  pub.set(bigintTo32Bytes(y), 32);
  const hash = keccak256(pub);
  return "0x" + bytesToHex(hash.slice(12));
}

/** Sign a 32-byte digest with a secp256k1 private key (ECDSA, low-s
 *  normalised, v = 27/28) — the inverse of the recovery above. Random-k
 *  signing with rejection sampling; retries whenever r would need a
 *  recovery id the contracts' ECDSA.recover cannot represent. Returns
 *  the 65-byte signature as 0x-prefixed hex, or null on bad input. */
export function signDigest(digest: Uint8Array, privateKeyHex: string): string | null {
  try {
    if (digest.length !== 32) return null;
    const pkBytes = hexToBytes(privateKeyHex);
    if (pkBytes.length !== 32) return null;
    const d = bigintFromBytes(pkBytes);
    if (d <= 0n || d >= ORDER_N) return null;
    const z = bigintFromBytes(digest);
    for (let attempt = 0; attempt < 64; attempt++) {
      const kBytes = new Uint8Array(32);
      crypto.getRandomValues(kBytes);
      const k = bigintFromBytes(kBytes);
      if (k <= 0n || k >= ORDER_N) continue;
      const rPoint = pointMul(k, { x: GX, y: GY });
      if (!rPoint) continue;
      if (rPoint.x >= ORDER_N) continue; // keep recovery id in {0,1}
      const r = rPoint.x % ORDER_N;
      if (r === 0n) continue;
      let s = mod(modInv(k, ORDER_N) * mod(z + r * d, ORDER_N), ORDER_N);
      if (s === 0n) continue;
      let recId = Number(rPoint.y & 1n);
      if (s > ORDER_N / 2n) {
        s = ORDER_N - s;
        recId ^= 1;
      }
      const sig = new Uint8Array(65);
      sig.set(bigintTo32Bytes(r), 0);
      sig.set(bigintTo32Bytes(s), 32);
      sig[64] = 27 + recId;
      return "0x" + bytesToHex(sig);
    }
    return null;
  } catch {
    return null;
  }
}

/** Recover the signer address from a signature over a raw 32-byte digest. */
export function recoverDigestSign(digest: Uint8Array, signatureHex: string): string | null {
  try {
    const sig = hexToBytes(signatureHex);
    if (sig.length !== 65) return null;
    const r = bigintFromBytes(sig.slice(0, 32));
    const s = bigintFromBytes(sig.slice(32, 64));
    let v = sig[64]!;
    if (v >= 27) v -= 27;
    if (v !== 0 && v !== 1) return null;
    if (r <= 0n || r >= ORDER_N || s <= 0n || s >= ORDER_N) return null;

    const z = bigintFromBytes(digest);

    // R = point with x = r, y parity = v
    const alpha = mod(r * r * r + 7n, FIELD_P);
    let y = modPow(alpha, (FIELD_P + 1n) / 4n, FIELD_P);
    if (Number(y & 1n) !== v) y = FIELD_P - y;
    const rPoint: Point = { x: r, y };

    // Q = r^-1 (s*R - z*G)
    const rInv = modInv(r, ORDER_N);
    const sR = pointMul(mod(s * rInv, ORDER_N), rPoint);
    const zG = pointMul(mod(-z * rInv, ORDER_N), { x: GX, y: GY });
    const q = pointAdd(sR, zG);
    if (!q) return null;
    return publicKeyToAddress(q.x, q.y);
  } catch {
    return null;
  }
}

/** Recover the signer address of an EIP-191 personal_sign signature. */
export function recoverPersonalSign(message: string, signatureHex: string): string | null {
  const msgBytes = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msgBytes.length}`);
  const digest = keccak256(new Uint8Array([...prefix, ...msgBytes]));
  return recoverDigestSign(digest, signatureHex);
}
