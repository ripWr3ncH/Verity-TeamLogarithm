/**
 * VERITY — modular arithmetic over BigInt.
 *
 * Small, dependency-free, and deliberately readable: a judge may well ask to
 * see the Paillier implementation, and "we pulled in a library" is a weaker
 * answer than showing the four functions it rests on.
 *
 * PROTOTYPE BOUNDARY, stated once and repeated in the UI: this is constant-time
 * in no sense whatsoever. It is correct, not hardened. A production deployment
 * would use a vetted, side-channel-resistant implementation inside the HSM
 * boundary described in whitepaper §4.3.
 */

import { randomBytes } from 'crypto';

export const ZERO = 0n;
export const ONE = 1n;
export const TWO = 2n;

/** Modular exponentiation by square-and-multiply. */
export function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  if (modulus === ONE) return ZERO;
  if (exponent < ZERO) return modPow(modInverse(base, modulus), -exponent, modulus);

  let result = ONE;
  let b = mod(base, modulus);
  let e = exponent;

  while (e > ZERO) {
    if (e & ONE) result = (result * b) % modulus;
    e >>= ONE;
    b = (b * b) % modulus;
  }
  return result;
}

/** Always returns a non-negative residue, unlike the % operator. */
export function mod(a: bigint, m: bigint): bigint {
  const r = a % m;
  return r < ZERO ? r + m : r;
}

/** Extended Euclid, returning [g, x, y] with a*x + b*y = g. */
export function egcd(a: bigint, b: bigint): [bigint, bigint, bigint] {
  if (b === ZERO) return [a, ONE, ZERO];
  const [g, x, y] = egcd(b, a % b);
  return [g, y, x - (a / b) * y];
}

export function modInverse(a: bigint, m: bigint): bigint {
  const [g, x] = egcd(mod(a, m), m);
  if (g !== ONE) throw new Error('no modular inverse: values are not coprime');
  return mod(x, m);
}

export function gcd(a: bigint, b: bigint): bigint {
  let x = a < ZERO ? -a : a;
  let y = b < ZERO ? -b : b;
  while (y) [x, y] = [y, x % y];
  return x;
}

export function lcm(a: bigint, b: bigint): bigint {
  return (a / gcd(a, b)) * b;
}

export function bitLength(n: bigint): number {
  return n <= ZERO ? 0 : n.toString(2).length;
}

// --------------------------------------------------------------------------
//  Randomness and primality
// --------------------------------------------------------------------------

/** Uniform random BigInt in [0, max). Rejection-sampled, so no modulo bias. */
export function randomBelow(max: bigint): bigint {
  if (max <= ZERO) throw new Error('randomBelow needs a positive bound');
  const bits = bitLength(max);
  const bytes = Math.ceil(bits / 8);
  for (;;) {
    const candidate = bytesToBigInt(randomBytes(bytes)) >> BigInt(bytes * 8 - bits);
    if (candidate < max) return candidate;
  }
}

export function bytesToBigInt(buf: Buffer): bigint {
  return buf.length === 0 ? ZERO : BigInt(`0x${buf.toString('hex')}`);
}

export function bigIntToBytes(n: bigint, length?: number): Buffer {
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const buf = Buffer.from(hex, 'hex');
  if (length === undefined || buf.length === length) return buf;
  if (buf.length > length) throw new Error('value does not fit the requested length');
  return Buffer.concat([Buffer.alloc(length - buf.length), buf]);
}

const SMALL_PRIMES = [
  3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n, 41n, 43n, 47n, 53n, 59n,
  61n, 67n, 71n, 73n, 79n, 83n, 89n, 97n, 101n, 103n, 107n, 109n, 113n,
];

/** Miller-Rabin. 40 rounds gives a failure probability under 2^-80. */
export function isProbablyPrime(n: bigint, rounds = 40): boolean {
  if (n < TWO) return false;
  if (n === TWO) return true;
  if ((n & ONE) === ZERO) return false;
  for (const p of SMALL_PRIMES) {
    if (n === p) return true;
    if (n % p === ZERO) return false;
  }

  let d = n - ONE;
  let r = 0;
  while ((d & ONE) === ZERO) {
    d >>= ONE;
    r++;
  }

  witness: for (let i = 0; i < rounds; i++) {
    const a = TWO + randomBelow(n - 4n);
    let x = modPow(a, d, n);
    if (x === ONE || x === n - ONE) continue;
    for (let j = 0; j < r - 1; j++) {
      x = (x * x) % n;
      if (x === n - ONE) continue witness;
    }
    return false;
  }
  return true;
}

/** A random prime of exactly `bits` bits, with the top two bits set. */
export function randomPrime(bits: number): bigint {
  if (bits < 16) throw new Error('use at least 16 bits');
  const top = ONE << BigInt(bits - 1);
  const secondTop = ONE << BigInt(bits - 2);

  for (;;) {
    // Top bit set fixes the length; second bit set keeps p*q at 2*bits.
    const candidate = (randomBelow(top) | top | secondTop) | ONE;
    if (isProbablyPrime(candidate)) return candidate;
  }
}
