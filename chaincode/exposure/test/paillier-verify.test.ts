/**
 * VERITY — chaincode Paillier verification tests.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  GOLDEN VECTOR — the second cross-implementation pin.
 *
 *  Paillier lives in two places: packages/crypto (keygen, encrypt, decrypt,
 *  ceremony — needs secrets and randomness) and this chaincode's
 *  src/domain/paillier-verify.ts (aggregate and proof-check — deterministic,
 *  no secrets). They are duplicated because Fabric cannot resolve workspace
 *  symlinks inside the peer's build container.
 *
 *  The values below were produced by packages/crypto. If the two
 *  implementations ever disagree, this suite goes red rather than the
 *  disagreement surfacing as an unexplained endorsement failure on demo day.
 *
 *  A 256-bit key is used ONLY so the numbers fit legibly in a test file. The
 *  demo runs 1024-bit. Say the size out loud when asked.
 * ══════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AggregationKey,
  aggregateCiphertexts,
  evaluateThreshold,
  mod,
  modPow,
  verifyDecryptionProof,
} from '../src/domain/paillier-verify';

const KEY: AggregationKey = {
  n: '89367819948502774322936325681279425583508503783629495451555385186553343033077',
  nSquared:
    '7986607242348010413037555102326340360351735216886574264116083671358801782802' +
    '630818391662102665607996102405047643299381582353919708454736106898853916087929',
  g: '89367819948502774322936325681279425583508503783629495451555385186553343033078',
  bits: 256,
};

/** Enc(520), Enc(430), Enc(290) — three banks' exposure to group G-0447, in crore. */
const CIPHERTEXTS = [
  '7660042738366743366199346669353124801649981201151417626371896289667031970979' +
    '202071505853786958197279613975229278973818754273257274118686940294472827256635',
  '1514849414246498552217489772269888042158543194399491220943279972926191794452' +
    '358234917873852459447655383360387493021763607027745224538339237411481369235966',
  '2672496800269525120098375301660723447284616989009830470268996255919151735862' +
    '128257924802872190472618821690750679220492266469514423713150253208603199861478',
];

const AGGREGATE =
  '3721543245963115587592776337130323816481404807224991604436435347069328775964' +
  '581437061301707145030438393254599360857953282266069056795716805759848190574316';

const PLAINTEXT = '1240'; // 520 + 430 + 290
const RANDOMNESS = '14596508562420424164385810635732650281975979573134956924741129826703697466280';

// ==========================================================================
describe('modular arithmetic mirrors packages/crypto', () => {
  it('computes modular exponentiation', () => {
    assert.equal(modPow(2n, 10n, 1000n), 24n);
    assert.equal(modPow(3n, 0n, 7n), 1n);
  });

  it('returns non-negative residues', () => {
    assert.equal(mod(-7n, 5n), 3n);
    assert.equal(mod(7n, 5n), 2n);
  });
});

// ==========================================================================
describe('golden vector — chaincode aggregation matches the off-chain library', () => {
  it('reproduces the aggregate ciphertext exactly', () => {
    assert.equal(aggregateCiphertexts(KEY, CIPHERTEXTS), AGGREGATE);
  });

  it('is deterministic, which is why it can run on every endorsing peer', () => {
    assert.equal(aggregateCiphertexts(KEY, CIPHERTEXTS), aggregateCiphertexts(KEY, CIPHERTEXTS));
  });

  it('is order-independent, since multiplication commutes', () => {
    const reversed = [...CIPHERTEXTS].reverse();
    assert.equal(aggregateCiphertexts(KEY, reversed), AGGREGATE);
  });

  it('aggregating nothing yields the encryption of zero', () => {
    assert.equal(aggregateCiphertexts(KEY, []), '1');
  });
});

// ==========================================================================
describe('decryption proof — the supervisor cannot announce a false total', () => {
  it('accepts the true total with its randomness', () => {
    assert.equal(verifyDecryptionProof(KEY, AGGREGATE, PLAINTEXT, RANDOMNESS), true);
  });

  it('THE §3.5 CHECK — refuses an understated total', () => {
    // A supervisor claiming 900 where the ciphertext carries 1240.
    assert.equal(verifyDecryptionProof(KEY, AGGREGATE, '900', RANDOMNESS), false);
  });

  it('refuses an overstated total', () => {
    assert.equal(verifyDecryptionProof(KEY, AGGREGATE, '99999', RANDOMNESS), false);
  });

  it('refuses the right total with invented randomness', () => {
    assert.equal(verifyDecryptionProof(KEY, AGGREGATE, PLAINTEXT, '12345'), false);
  });

  it('refuses a proof presented against a different ciphertext', () => {
    assert.equal(verifyDecryptionProof(KEY, CIPHERTEXTS[0]!, PLAINTEXT, RANDOMNESS), false);
  });

  it('refuses out-of-range values rather than throwing', () => {
    assert.equal(verifyDecryptionProof(KEY, AGGREGATE, '-1', RANDOMNESS), false);
    assert.equal(verifyDecryptionProof(KEY, AGGREGATE, KEY.n, RANDOMNESS), false);
    assert.equal(verifyDecryptionProof(KEY, AGGREGATE, PLAINTEXT, '0'), false);
    assert.equal(verifyDecryptionProof(KEY, 'not-a-number', PLAINTEXT, RANDOMNESS), false);
  });
});

// ==========================================================================
describe('threshold comparison happens in the clear (§3.7.2)', () => {
  it('alerts when the group total exceeds theta times system capital', () => {
    // theta = 0.10 -> 10% of 10,000 crore = 1,000; total 1,240 breaches it.
    const r = evaluateThreshold('1240', 1000n, '10000');
    assert.equal(r.alert, true);
    assert.equal(r.threshold, '1000');
  });

  it('does not alert below the threshold', () => {
    // theta = 0.25 -> 2,500; total 1,240 is under.
    const r = evaluateThreshold('1240', 2500n, '10000');
    assert.equal(r.alert, false);
    assert.equal(r.threshold, '2500');
  });

  it('is exact at the boundary — strictly greater than, never equal', () => {
    const r = evaluateThreshold('2500', 2500n, '10000');
    assert.equal(r.alert, false, 'equal to the limit is not a breach');
    assert.equal(evaluateThreshold('2501', 2500n, '10000').alert, true);
  });

  it('uses integer arithmetic, so no float rounding enters consensus', () => {
    // 0.3333 of 3 crore. Floats would give 0.9999000000000001; we get 9999.
    const r = evaluateThreshold('10000', 3333n, '30000');
    assert.equal(r.threshold, '9999');
    assert.equal(r.alert, true);
  });
});

// ==========================================================================
describe('the withdrawn v6 design stays withdrawn', () => {
  it('exposes no ciphertext comparison', async () => {
    // §3.7.2: "Paillier provides addition only. Comparison is not a native
    // homomorphic operation, so it cannot be performed on the ciphertext."
    // The v6 design that did the threshold check on ciphertext was withdrawn.
    const mod = await import('../src/domain/paillier-verify');
    assert.equal('compareEncrypted' in mod, false);
    assert.equal('thresholdOnCiphertext' in mod, false);
  });
});
