/**
 * VERITY — cryptography tests.
 *
 * These prove the two claims Modules II and III rest on:
 *
 *   Module II  — three banks' exposures can be summed WITHOUT any of them being
 *                decrypted, and no single party, supervisor included, can open
 *                the aggregate alone.
 *   Module III — a depositor can verify their balance is inside the bank's
 *                published commitment, and a bank cannot insert a balance the
 *                depositor never signed.
 *
 * Run: npm test  (in packages/crypto)
 */

import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto';
import { describe, it } from 'node:test';

import { gcd, isProbablyPrime, modInverse, modPow, randomPrime } from '../src/bigint';
import {
  evaluateThreshold,
  runCeremony,
  splitDecryptionKey,
  verifyDecryption,
} from '../src/ceremony';
import {
  buildVerifiedTree,
  leafDigest,
  MerkleSumTree,
  SignedLeaf,
  verifyInclusion,
} from '../src/merkle-sum';
import { addEncrypted, aggregate, decrypt, encrypt, generateKeys, multiplyByScalar } from '../src/paillier';
import { FIELD_PRIME, reconstruct, split } from '../src/shamir';

/** 512-bit keys keep the suite fast. The demo runs 1024. */
const TEST_BITS = 512;
const keys = generateKeys(TEST_BITS);

// ==========================================================================
describe('modular arithmetic', () => {
  it('computes modular exponentiation', () => {
    assert.equal(modPow(2n, 10n, 1000n), 24n);
    assert.equal(modPow(3n, 0n, 7n), 1n);
    assert.equal(modPow(5n, 117n, 19n), 1n); // Fermat: 5^18 = 1 mod 19, 117 = 6*18+9
  });

  it('inverts modulo a prime', () => {
    const inv = modInverse(17n, 3120n);
    assert.equal((17n * inv) % 3120n, 1n);
  });

  it('refuses an inverse when values are not coprime', () => {
    assert.throws(() => modInverse(4n, 8n), /no modular inverse/);
  });

  it('computes gcd', () => {
    assert.equal(gcd(48n, 18n), 6n);
    assert.equal(gcd(17n, 31n), 1n);
  });

  it('recognises primes and composites', () => {
    assert.equal(isProbablyPrime(97n), true);
    assert.equal(isProbablyPrime(561n), false); // Carmichael number — fools Fermat
    assert.equal(isProbablyPrime(1105n), false); // another Carmichael
    assert.equal(isProbablyPrime(2n ** 61n - 1n), true); // Mersenne prime
  });

  it('generates primes of the requested size', () => {
    const p = randomPrime(128);
    assert.equal(p.toString(2).length, 128);
    assert.ok(isProbablyPrime(p));
  });
});

// ==========================================================================
describe('Paillier — additive homomorphism (§3.7.2)', () => {
  it('round-trips a value', () => {
    const m = 123_456_789n;
    assert.equal(decrypt(keys.privateKey, encrypt(keys.publicKey, m)), m);
  });

  it('produces a different ciphertext each time for the same value', () => {
    // Without fresh randomness, two banks reporting the same exposure to the
    // same group would be readable off the ciphertexts directly.
    const a = encrypt(keys.publicKey, 1000n);
    const b = encrypt(keys.publicKey, 1000n);
    assert.notEqual(a, b);
    assert.equal(decrypt(keys.privateKey, a), decrypt(keys.privateKey, b));
  });

  it('adds under encryption', () => {
    const sum = addEncrypted(
      keys.publicKey,
      encrypt(keys.publicKey, 400n),
      encrypt(keys.publicKey, 350n),
    );
    assert.equal(decrypt(keys.privateKey, sum), 750n);
  });

  it('THE MODULE II CLAIM — sums three banks without decrypting any of them', () => {
    // Exposure of borrower group G-0447 across three institutions, in crore.
    const perBank = [520n, 430n, 290n];
    const ciphertexts = perBank.map((x) => encrypt(keys.publicKey, x));

    // The aggregator never holds a private key. It multiplies, nothing else.
    const aggregated = aggregate(keys.publicKey, ciphertexts);

    assert.equal(decrypt(keys.privateKey, aggregated), 1240n);
    // And the aggregate is not any individual contribution.
    for (const c of ciphertexts) assert.notEqual(aggregated, c);
  });

  it('aggregation is deterministic, so chaincode can do it', () => {
    // This is why the multiplication runs on-ledger: every endorsing peer must
    // reach the same bytes independently.
    const cs = [encrypt(keys.publicKey, 11n), encrypt(keys.publicKey, 22n)];
    assert.equal(aggregate(keys.publicKey, cs), aggregate(keys.publicKey, cs));
    assert.equal(aggregate(keys.publicKey, cs), addEncrypted(keys.publicKey, cs[0]!, cs[1]!));
  });

  it('scales a ciphertext by a plaintext factor', () => {
    const c = multiplyByScalar(keys.publicKey, encrypt(keys.publicKey, 7n), 6n);
    assert.equal(decrypt(keys.privateKey, c), 42n);
  });

  it('refuses to encode a negative exposure', () => {
    assert.throws(() => encrypt(keys.publicKey, -1n), /non-negative/);
  });

  it('has no compareEncrypted — comparison is not homomorphic', async () => {
    // Guards the §3.7.2 correction. The withdrawn v6 design compared on
    // ciphertext; Paillier cannot do that, and reintroducing it would
    // contradict our own whitepaper in front of judges who have read it.
    const paillier = await import('../src/paillier');
    assert.equal('compareEncrypted' in paillier, false);
    assert.equal('greaterThan' in paillier, false);
  });
});

// ==========================================================================
describe('Shamir secret sharing', () => {
  it('the field modulus really is prime', () => {
    // Guards a bug that actually happened: a hand-transcribed 2048-bit decimal
    // literal was composite, and reconstruct() failed with "no modular inverse"
    // whenever a Lagrange denominator shared a factor with it.
    assert.equal(isProbablyPrime(FIELD_PRIME), true);
    assert.ok(FIELD_PRIME.toString(2).length >= 2048, 'field must exceed a 2048-bit Paillier lambda');
  });

  it('reconstructs from exactly the threshold', () => {
    const secret = 987_654_321_987_654_321n;
    const shares = split(secret, 2, 3);
    assert.equal(reconstruct([shares[0]!, shares[1]!]), secret);
    assert.equal(reconstruct([shares[0]!, shares[2]!]), secret);
    assert.equal(reconstruct([shares[1]!, shares[2]!]), secret);
  });

  it('reconstructs from more than the threshold', () => {
    const secret = 42n;
    const shares = split(secret, 3, 5);
    assert.equal(reconstruct(shares), secret);
  });

  it('gives nothing away below the threshold', () => {
    const secret = 1_000_000n;
    const shares = split(secret, 3, 5);
    // Two of three: interpolation returns some field element, not the secret.
    assert.notEqual(reconstruct([shares[0]!, shares[1]!]), secret);
  });

  it('refuses the same share presented twice', () => {
    // Otherwise one holder could look like a quorum.
    const shares = split(7n, 2, 3);
    assert.throws(() => reconstruct([shares[0]!, shares[0]!]), /more than once/);
  });

  it('refuses a threshold larger than the share count', () => {
    assert.throws(() => split(1n, 4, 3), /more shares than exist/);
  });

  it('rejects a secret that does not fit the field', () => {
    assert.throws(() => split(FIELD_PRIME, 2, 3), /does not fit/);
  });
});

// ==========================================================================
describe('threshold ceremony — supervisor plus quorum (§3.7.2, §3.5)', () => {
  const material = splitDecryptionKey(keys.privateKey, 2, ['BIBM', 'FRC', 'Academic']);
  const ciphertext = aggregate(keys.publicKey, [
    encrypt(keys.publicKey, 520n),
    encrypt(keys.publicKey, 430n),
    encrypt(keys.publicKey, 290n),
  ]);

  it('opens the aggregate with the supervisor and two independents', () => {
    const result = runCeremony(
      material,
      material.supervisorShare,
      material.independentShares.slice(0, 2),
      ciphertext,
    );
    assert.equal(result.plaintext, '1240');
    assert.deepEqual(result.participants, ['BangladeshBank', 'BIBM', 'FRC']);
  });

  it('THE §3.5 CLAIM — the supervisor alone cannot decrypt', () => {
    assert.throws(
      () => runCeremony(material, material.supervisorShare, [], ciphertext),
      /CEREMONY_QUORUM_SHORT/,
    );
    assert.throws(
      () => runCeremony(material, material.supervisorShare, material.independentShares.slice(0, 1), ciphertext),
      /CEREMONY_QUORUM_SHORT/,
    );
  });

  it('THE §3.5 CLAIM — every independent holder together cannot decrypt', () => {
    assert.throws(
      () => runCeremony(material, undefined, material.independentShares, ciphertext),
      /CEREMONY_SUPERVISOR_ABSENT/,
    );
  });

  it('emits randomness that makes the decryption publicly checkable', () => {
    const result = runCeremony(
      material,
      material.supervisorShare,
      material.independentShares.slice(0, 2),
      ciphertext,
    );
    assert.equal(
      verifyDecryption(keys.publicKey, ciphertext, result.plaintext, result.randomness),
      true,
    );
  });

  it('a supervisor cannot announce a total the ciphertext does not carry', () => {
    const result = runCeremony(
      material,
      material.supervisorShare,
      material.independentShares.slice(0, 2),
      ciphertext,
    );
    // Claim 900 instead of the true 1240, keeping the same randomness.
    assert.equal(verifyDecryption(keys.publicKey, ciphertext, '900', result.randomness), false);
    assert.equal(verifyDecryption(keys.publicKey, ciphertext, '1240', '12345'), false);
  });

  it('compares in the clear, after decryption', () => {
    // θ · C_system, computed on plaintext. Never on ciphertext.
    const under = evaluateThreshold('1240', 0.25, '10000');
    assert.equal(under.alert, false);
    assert.equal(under.threshold, '2500');

    const over = evaluateThreshold('1240', 0.1, '10000');
    assert.equal(over.alert, true);
    assert.equal(over.threshold, '1000');
  });
});

// ==========================================================================
describe('Merkle sum tree with signed leaves (§3.7.3)', () => {
  const PERIOD = '2027-03-31';

  function depositor(accountRef: string, balance: bigint) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const key = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64');
    const digest = leafDigest(accountRef, balance, PERIOD);
    return {
      leaf: {
        accountRef,
        balance,
        depositorKey: key,
        period: PERIOD,
        signature: edSign(null, Buffer.from(digest, 'utf8'), privateKey).toString('base64'),
      } satisfies SignedLeaf,
      privateKey,
    };
  }

  const verify = (pk: string, digestHex: string, sig: string): boolean => {
    try {
      return edVerify(
        null,
        Buffer.from(digestHex, 'utf8'),
        { key: Buffer.from(pk, 'base64'), format: 'der', type: 'spki' },
        Buffer.from(sig, 'base64'),
      );
    } catch {
      return false;
    }
  };

  const balances = [342_500_00n, 1_200_000_00n, 55_000_00n, 8_900_00n, 42_000_00n];
  const depositors = balances.map((b, i) => depositor(`acct-salted-${i}`, b));
  const leaves = depositors.map((d) => d.leaf);

  it('sums every balance into the root', () => {
    const tree = new MerkleSumTree(leaves);
    assert.equal(tree.rootSum, balances.reduce((a, b) => a + b, 0n));
    assert.equal(tree.size, 5);
  });

  it('proves inclusion for every depositor', () => {
    const tree = new MerkleSumTree(leaves);
    for (let i = 0; i < leaves.length; i++) {
      assert.equal(verifyInclusion(tree.prove(i)), true, `leaf ${i}`);
    }
  });

  it('proof size is logarithmic', () => {
    const many = Array.from({ length: 1000 }, (_, i) => depositor(`acct-${i}`, BigInt(i + 1) * 100n).leaf);
    const tree = new MerkleSumTree(many);
    // 1000 leaves -> depth 10, so at most 10 siblings.
    assert.ok(tree.prove(500).path.length <= 10, 'path should be O(log n)');
    assert.equal(verifyInclusion(tree.prove(500)), true);
  });

  it('rejects a tampered balance in the proof', () => {
    const tree = new MerkleSumTree(leaves);
    const proof = tree.prove(0);
    assert.equal(verifyInclusion({ ...proof, leafSum: '999999999' }), false);
  });

  it('rejects a proof whose root sum has been understated', () => {
    // A bank publishing a smaller total than it actually holds is the whole
    // attack a plain Merkle tree cannot catch.
    const tree = new MerkleSumTree(leaves);
    const proof = tree.prove(2);
    assert.equal(verifyInclusion({ ...proof, rootSum: '1' }), false);
  });

  it('rejects a tampered sibling', () => {
    const tree = new MerkleSumTree(leaves);
    const proof = tree.prove(1);
    const path = [...proof.path];
    path[0] = { ...path[0]!, sum: '0' };
    assert.equal(verifyInclusion({ ...proof, path }), false);
  });

  it('THE SIGNED-LEAF PRINCIPLE — an unsigned balance never enters the tree', () => {
    const forged: SignedLeaf = {
      accountRef: 'acct-forged',
      balance: 999_999_999n,
      depositorKey: depositors[0]!.leaf.depositorKey,
      period: PERIOD,
      signature: Buffer.from('not-a-real-signature').toString('base64'),
    };
    const { tree, rejected } = buildVerifiedTree([...leaves, forged], verify);
    assert.ok(tree);
    assert.equal(tree.size, 5);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0]!.reason, /UNSIGNED_LEAF/);
    assert.equal(tree.rootSum, balances.reduce((a, b) => a + b, 0n));
  });

  it('rejects a signature replayed from a different period', () => {
    const d = depositor('acct-replay', 500_00n);
    const replayed: SignedLeaf = { ...d.leaf, period: '2027-06-30' };
    const { tree, rejected } = buildVerifiedTree([replayed], verify);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0]!.reason, /UNSIGNED_LEAF/);
    // Nothing survived, so there is no commitment to publish — and the caller
    // gets the reason rather than an exception.
    assert.equal(tree, null);
  });

  it('rejects a negative balance outright', () => {
    // The other half of the collusion attack in [24].
    const bad: SignedLeaf = { ...depositors[0]!.leaf, balance: -1n };
    const { rejected } = buildVerifiedTree([...leaves, bad], verify);
    assert.equal(rejected.some((r) => r.reason === 'NEGATIVE_BALANCE'), true);
    assert.throws(() => new MerkleSumTree([bad]), /NEGATIVE_BALANCE/);
  });

  it('does not double-count an odd leaf', () => {
    // Duplicating the last leaf to pad the level would inflate the sum.
    const odd = leaves.slice(0, 3);
    const tree = new MerkleSumTree(odd);
    assert.equal(tree.rootSum, odd.reduce((a, l) => a + l.balance, 0n));
  });

  it('refuses to commit an empty liability set', () => {
    assert.throws(() => new MerkleSumTree([]), /empty liability set/);
  });
});
