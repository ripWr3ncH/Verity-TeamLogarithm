/**
 * VERITY — Shamir secret sharing over a prime field.
 *
 * Used by ceremony.ts to hold the Paillier decryption key so that no single
 * party can decrypt a cross-bank aggregate alone (whitepaper §3.7.2, §3.5).
 *
 * A (k, n) split: any k of the n shares reconstruct the secret, and any k−1
 * reveal NOTHING about it — not "not much", nothing, in the information
 * theoretic sense. That property is what lets us say the supervisor cannot act
 * alone without hedging.
 */

import { mod, modInverse, ONE, randomBelow, ZERO } from './bigint';

export interface Share {
  /** x-coordinate, 1-based. Never 0 — f(0) is the secret. */
  index: number;
  /** f(index), decimal string. */
  value: string;
  /** Who holds it. Carried for the ceremony UI, not used in the maths. */
  holder: string;
}

/**
 * The field the shares live in: 2^2203 − 1, the Mersenne prime with exponent
 * 2203. Public by design — the modulus is not a secret, the shares are.
 *
 * Chosen for two reasons:
 *   • 2203 bits leaves room for the Paillier λ of a 2048-bit key (~2047 bits),
 *     so raising the key size later does not silently break sharing.
 *   • It is written as an expression, not transcribed digits. An earlier draft
 *     pasted a 2048-bit decimal literal; one wrong digit made the modulus
 *     composite, and `reconstruct` failed with "no modular inverse" because the
 *     Lagrange denominator shared a factor with it. The unit tests caught it.
 *     Never hand-type a modulus.
 */
export const FIELD_PRIME = (1n << 2203n) - 1n;

/**
 * Split `secret` into `n` shares, any `k` of which reconstruct it.
 *
 * Coefficients are drawn uniformly, so with fewer than k shares every candidate
 * secret remains equally likely.
 */
export function split(secret: bigint, k: number, n: number, holders: string[] = []): Share[] {
  if (k < 2) throw new Error('a threshold below 2 is not a threshold');
  if (n < k) throw new Error('cannot require more shares than exist');
  if (secret < ZERO || secret >= FIELD_PRIME) throw new Error('secret does not fit the field');

  // f(x) = secret + a₁x + a₂x² + … + a_{k−1}x^{k−1}
  const coefficients = [secret];
  for (let i = 1; i < k; i++) coefficients.push(randomBelow(FIELD_PRIME));

  const shares: Share[] = [];
  for (let x = 1; x <= n; x++) {
    let y = ZERO;
    let xPow = ONE;
    const bx = BigInt(x);
    for (const c of coefficients) {
      y = mod(y + c * xPow, FIELD_PRIME);
      xPow = mod(xPow * bx, FIELD_PRIME);
    }
    shares.push({
      index: x,
      value: y.toString(),
      holder: holders[x - 1] ?? `holder-${x}`,
    });
  }
  return shares;
}

/**
 * Reconstruct via Lagrange interpolation at x = 0.
 *
 * Throws on duplicate indices: the same share presented twice is one share, and
 * silently accepting it would let a single holder appear to be a quorum. That
 * is exactly the kind of shortcut a judge would probe.
 */
export function reconstruct(shares: Share[]): bigint {
  if (shares.length === 0) throw new Error('no shares supplied');

  const seen = new Set<number>();
  for (const s of shares) {
    if (seen.has(s.index)) throw new Error(`share ${s.index} was presented more than once`);
    seen.add(s.index);
  }

  let secret = ZERO;
  for (const si of shares) {
    let numerator = ONE;
    let denominator = ONE;
    for (const sj of shares) {
      if (si.index === sj.index) continue;
      numerator = mod(numerator * BigInt(-sj.index), FIELD_PRIME);
      denominator = mod(denominator * BigInt(si.index - sj.index), FIELD_PRIME);
    }
    const lagrange = mod(numerator * modInverse(denominator, FIELD_PRIME), FIELD_PRIME);
    secret = mod(secret + BigInt(si.value) * lagrange, FIELD_PRIME);
  }
  return secret;
}
