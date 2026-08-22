/**
 * VERITY — the threshold decryption ceremony.
 *
 * Whitepaper §3.7.2:
 *   "Verity therefore decrypts each group total X_g to Bangladesh Bank, in a
 *    ceremony that needs THE SUPERVISOR PLUS A QUORUM OF INDEPENDENT
 *    PARTICIPANTS, and then compares X_g > θ·C_system in the clear."
 *
 * And §3.5, on why the supervisor is not simply a custodian:
 *   "It can refuse an event, but cannot author a bank's record, rewrite a
 *    committed one, OR DECRYPT AN AGGREGATE ON ITS OWN."
 *
 * ── The construction ──────────────────────────────────────────────────────
 *
 * The Paillier decryption key λ is split as:
 *
 *     λ  =  supervisorShare  +  R   (mod P)
 *
 * where R is a uniformly random mask, itself (k, n) Shamir-shared among the
 * independent holders. Reconstructing λ therefore needs BOTH:
 *
 *     • the supervisor's share      — without it, R alone reveals nothing
 *     • k of the n independent shares — without them, R cannot be rebuilt
 *
 * Every independent holder colluding still cannot decrypt. The supervisor
 * acting alone still cannot decrypt. That is exactly the sentence in §3.5,
 * made mechanical.
 *
 * ── The honest boundary ───────────────────────────────────────────────────
 *
 * This reconstructs λ in memory at the moment of the ceremony. A production
 * deployment would use Damgård–Jurik threshold decryption, where each holder
 * emits a PARTIAL DECRYPTION and the key is never assembled anywhere.
 *
 * Say that plainly if asked. What this build does prove — and it is the part
 * that matters for the criterion — is that no single party, supervisor
 * included, can produce the plaintext alone.
 *
 * ── Verifiable decryption ─────────────────────────────────────────────────
 *
 * The ceremony also emits the Paillier randomness r, so ANYONE holding the
 * public key can check that the announced total really is the plaintext of the
 * aggregate ciphertext:
 *
 *     c  ≟  (1 + m·n) · rⁿ   (mod n²)
 *
 * That check is deterministic, so it runs in chaincode. Bangladesh Bank cannot
 * announce a total the ciphertext does not carry.
 */

import { mod, modInverse, modPow, ONE, randomBelow } from './bigint';
import { PaillierPrivateKey, PaillierPublicKey } from './paillier';
import { FIELD_PRIME, reconstruct, Share, split } from './shamir';

export interface CeremonyKeyMaterial {
  /** Held by Bangladesh Bank. Mandatory in every ceremony. */
  supervisorShare: string;
  /** Shamir shares of the mask, held by independent Council participants. */
  independentShares: Share[];
  threshold: number;
  publicKey: PaillierPublicKey;
}

export interface DecryptionResult {
  plaintext: string;
  /** Paillier randomness, so the decryption is publicly checkable. */
  randomness: string;
  participants: string[];
}

/**
 * Split a Paillier private key for the ceremony.
 *
 * §3.7.2's "supervisor plus a quorum": the default here is Bangladesh Bank plus
 * 2 of 3 independents, matching the demo script.
 */
export function splitDecryptionKey(
  sk: PaillierPrivateKey,
  threshold = 2,
  holderNames: string[] = ['BIBM', 'FRC', 'Academic independent'],
): CeremonyKeyMaterial {
  const lambda = BigInt(sk.lambda);
  if (lambda >= FIELD_PRIME) throw new Error('key is too large for the sharing field');

  const mask = randomBelow(FIELD_PRIME);
  const supervisorShare = mod(lambda - mask, FIELD_PRIME);
  const independentShares = split(mask, threshold, holderNames.length, holderNames);

  return {
    supervisorShare: supervisorShare.toString(),
    independentShares,
    threshold,
    publicKey: sk.publicKey,
  };
}

/**
 * Run the ceremony against one aggregate ciphertext.
 *
 * Refuses, by name, when the supervisor is absent or the quorum is short. Both
 * refusals are demonstrated live in Act 3b.
 */
export function runCeremony(
  material: CeremonyKeyMaterial,
  supervisorShare: string | undefined,
  presentedShares: Share[],
  aggregateCiphertext: string,
): DecryptionResult {
  if (!supervisorShare) {
    throw new Error(
      'CEREMONY_SUPERVISOR_ABSENT: threshold decryption requires Bangladesh Bank\'s share; ' +
        'no quorum of independent holders can decrypt without the supervisor',
    );
  }

  const distinct = new Map(presentedShares.map((s) => [s.index, s]));
  if (distinct.size < material.threshold) {
    throw new Error(
      `CEREMONY_QUORUM_SHORT: ${distinct.size} of ${material.threshold} independent ` +
        'shares presented; the supervisor cannot decrypt alone',
    );
  }

  const mask = reconstruct([...distinct.values()]);
  const lambda = mod(BigInt(supervisorShare) + mask, FIELD_PRIME);

  const pk = material.publicKey;
  const n = BigInt(pk.n);
  const nSquared = BigInt(pk.nSquared);
  const mu = modInverse(lambda, n);

  // Standard Paillier decryption: L(c^λ mod n²) · μ mod n
  const x = modPow(BigInt(aggregateCiphertext), lambda, nSquared);
  const plaintext = mod(((x - ONE) / n) * mu, n);

  // Recover r so the result is publicly checkable (see the header).
  const gm = mod(ONE + plaintext * n, nSquared);
  const rn = mod(BigInt(aggregateCiphertext) * modInverse(gm, nSquared), nSquared);
  const d = modInverse(n, lambda);
  const randomness = modPow(mod(rn, n), d, n);

  return {
    plaintext: plaintext.toString(),
    randomness: randomness.toString(),
    participants: ['BangladeshBank', ...[...distinct.values()].map((s) => s.holder)],
  };
}

/**
 * Check an announced plaintext against the ciphertext it claims to open.
 *
 *     c  ≟  (1 + m·n) · rⁿ   (mod n²)
 *
 * Pure and deterministic, so chaincode runs it on every endorsing peer. This is
 * what stops a supervisor announcing a total the aggregate does not carry.
 */
export function verifyDecryption(
  pk: PaillierPublicKey,
  ciphertext: string,
  plaintext: string,
  randomness: string,
): boolean {
  try {
    const n = BigInt(pk.n);
    const nSquared = BigInt(pk.nSquared);
    const m = BigInt(plaintext);
    const r = BigInt(randomness);
    if (m < 0n || m >= n) return false;

    const expected = mod(mod(ONE + m * n, nSquared) * modPow(r, n, nSquared), nSquared);
    return expected === mod(BigInt(ciphertext), nSquared);
  } catch {
    return false;
  }
}

/**
 * The comparison — IN THE CLEAR, after decryption, never on ciphertext.
 *
 * §3.7.2: "compares X_g > θ·C_system in the clear. This preserves the property
 * that matters: the aggregate reveals a group's total system-wide exposure […]
 * but never which bank holds how much."
 */
export function evaluateThreshold(
  groupTotal: string,
  theta: number,
  systemCapital: string,
): { alert: boolean; total: string; threshold: string } {
  // θ is a fraction; scale to integers so the comparison stays exact.
  const scale = 10_000n;
  const thetaScaled = BigInt(Math.round(theta * Number(scale)));
  const threshold = (BigInt(systemCapital) * thetaScaled) / scale;
  const total = BigInt(groupTotal);
  return { alert: total > threshold, total: total.toString(), threshold: threshold.toString() };
}
