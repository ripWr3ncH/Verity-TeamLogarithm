/**
 * VERITY — the deterministic half of Paillier, for chaincode.
 *
 * Only two operations happen on-ledger, and both are deterministic, which is
 * why every endorsing peer can reproduce them byte for byte:
 *
 *   1. AGGREGATION       ∏_b Enc(x_{b,g}) mod n²  — plain modular multiplication
 *   2. PROOF CHECKING    c ≟ (1 + m·n) · rⁿ mod n²
 *
 * Key generation, encryption and decryption need secrets or randomness, so they
 * stay off-chain in packages/crypto. Nothing in this file holds a secret.
 *
 * DUPLICATION NOTICE: this repeats a little of packages/crypto on purpose.
 * Fabric runs `npm install` inside the peer's build container, where workspace
 * symlinks do not resolve. See HANDOFF/PHASE_00_FOUNDATION.md §2.4.
 */

export const ONE = 1n;
export const ZERO = 0n;

export function mod(a: bigint, m: bigint): bigint {
  const r = a % m;
  return r < ZERO ? r + m : r;
}

export function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  if (modulus === ONE) return ZERO;
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

export interface AggregationKey {
  n: string;
  nSquared: string;
  g: string;
  bits: number;
}

/**
 * ∏_b Enc(x_{b,g}) mod n² — the aggregation from §3.7.2.
 *
 * Nothing is decrypted. The aggregator holds no key and learns nothing; it
 * multiplies numbers. That is the whole mechanism, and it is four lines long.
 */
export function aggregateCiphertexts(key: AggregationKey, ciphertexts: string[]): string {
  const nSquared = BigInt(key.nSquared);
  let acc = ONE;
  for (const c of ciphertexts) acc = mod(acc * BigInt(c), nSquared);
  return acc.toString();
}

/**
 * Check that an announced plaintext really is what the ciphertext carries:
 *
 *     c  ≟  (1 + m·n) · rⁿ   (mod n²)
 *
 * The ceremony emits `r` alongside the total, so this check needs no secret and
 * runs on every endorsing peer. It is what stops the supervisor announcing a
 * group total the aggregate does not support — a real limit on the one party
 * that could otherwise be accused of being the custodian (§3.5).
 */
export function verifyDecryptionProof(
  key: AggregationKey,
  ciphertext: string,
  plaintext: string,
  randomness: string,
): boolean {
  try {
    const n = BigInt(key.n);
    const nSquared = BigInt(key.nSquared);
    const m = BigInt(plaintext);
    const r = BigInt(randomness);
    if (m < ZERO || m >= n) return false;
    if (r <= ZERO || r >= n) return false;

    const expected = mod(mod(ONE + m * n, nSquared) * modPow(r, n, nSquared), nSquared);
    return expected === mod(BigInt(ciphertext), nSquared);
  } catch {
    return false;
  }
}

/**
 * X_g > θ · C_system, IN THE CLEAR (§3.7.2).
 *
 * θ is scaled to an integer so the comparison is exact — floating point in
 * chaincode is a determinism hazard as well as a correctness one.
 */
export function evaluateThreshold(
  groupTotal: string,
  thetaScaledBy10k: bigint,
  systemCapital: string,
): { alert: boolean; threshold: string } {
  const threshold = (BigInt(systemCapital) * thetaScaledBy10k) / 10_000n;
  return { alert: BigInt(groupTotal) > threshold, threshold: threshold.toString() };
}
