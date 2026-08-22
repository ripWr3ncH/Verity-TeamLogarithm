/**
 * VERITY — chaincode Merkle verification tests.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE GOLDEN VECTOR
 *
 *  The Merkle sum construction exists TWICE: the builder in
 *  packages/crypto/src/merkle-sum.ts (off-chain, needs every leaf) and the
 *  verifier in chaincode/claims/src/domain/merkle-verify.ts (on-chain, needs
 *  only a proof). They are duplicated because Fabric cannot resolve workspace
 *  symlinks inside the peer's build container.
 *
 *  Duplication is a liability unless something pins the two together. The
 *  constants below ARE that pin. They were produced by the off-chain builder,
 *  and the SAME values appear in packages/crypto/test/golden.test.ts.
 *
 *  If a domain-separation string changes in one implementation and not the
 *  other, one of the two suites goes red. Without this, the drift would show up
 *  as every depositor's proof silently failing on demo day.
 *
 *  DO NOT regenerate these values to make a test pass. Find out which side
 *  changed, and why.
 * ══════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InclusionProof, internalHash, leafDigest, leafHash, verifyInclusion } from '../src/domain/merkle-verify';

const PERIOD = '2027-03-31';

export const GOLDEN = {
  root: 'c56e60870474983fb56f5d9fbe3320a58f316b1a4c0ffc65248dd745c94f0424',
  rootSum: '164840000',
  leaves: [
    { accountRef: 'acct-salted-0', balance: '34250000' },
    { accountRef: 'acct-salted-1', balance: '120000000' },
    { accountRef: 'acct-salted-2', balance: '5500000' },
    { accountRef: 'acct-salted-3', balance: '890000' },
    { accountRef: 'acct-salted-4', balance: '4200000' },
  ],
  proofForLeaf2: {
    leafIndex: 2,
    leafHash: '2c8aa74e015dde5388ce300793c6b9341492834923c8f391461a64cc159d20da',
    leafSum: '5500000',
    path: [
      { hash: 'a895cdc7e15ea5ef862966d41244722f4c99e53269759b645515bdc931bf5302', sum: '890000', right: true },
      { hash: '3b04f0f7d07c5c6b28d37c19389f34fcfab13372ad8c4c90ef65b3f4ea9987b1', sum: '154250000', right: false },
      { hash: '34687093c2a7b739546e084274659e25f7071352a1fd0617bf9b84be3c3899db', sum: '4200000', right: true },
    ],
    root: 'c56e60870474983fb56f5d9fbe3320a58f316b1a4c0ffc65248dd745c94f0424',
    rootSum: '164840000',
  } satisfies InclusionProof,
};

// ==========================================================================
describe('golden vector — chaincode verifier agrees with the off-chain builder', () => {
  it('reproduces the leaf hash the builder produced', () => {
    const leaf = GOLDEN.leaves[2]!;
    assert.equal(leafHash(leaf.accountRef, leaf.balance, PERIOD), GOLDEN.proofForLeaf2.leafHash);
  });

  it('verifies the builder-produced proof against the builder-produced root', () => {
    assert.equal(verifyInclusion(GOLDEN.proofForLeaf2, GOLDEN.root, GOLDEN.rootSum), true);
  });

  it('binds the leaf digest to account, balance AND period', () => {
    const d = leafDigest('acct-salted-2', '5500000', PERIOD);
    assert.notEqual(d, leafDigest('acct-salted-2', '5500000', '2027-06-30'));
    assert.notEqual(d, leafDigest('acct-salted-2', '5500001', PERIOD));
    assert.notEqual(d, leafDigest('acct-salted-3', '5500000', PERIOD));
  });

  it('separates leaf hashes from internal hashes', () => {
    // Without domain separation, a leaf could be passed off as an internal node.
    const asLeaf = leafHash('a', '1', PERIOD);
    const asInternal = internalHash({ hash: asLeaf, sum: 1n }, { hash: asLeaf, sum: 1n });
    assert.notEqual(asLeaf, asInternal);
  });
});

// ==========================================================================
describe('proof verification refuses tampering', () => {
  const ok = GOLDEN.proofForLeaf2;

  it('refuses an inflated leaf sum', () => {
    assert.equal(verifyInclusion({ ...ok, leafSum: '99999999' }, GOLDEN.root, GOLDEN.rootSum), false);
  });

  it('refuses an understated root sum', () => {
    // The attack a plain Merkle tree cannot catch: publishing a total smaller
    // than the balances underneath it.
    assert.equal(verifyInclusion({ ...ok, rootSum: '1' }, GOLDEN.root, '1'), false);
  });

  it('refuses a proof presented against a different root', () => {
    assert.equal(verifyInclusion(ok, 'f'.repeat(64), GOLDEN.rootSum), false);
  });

  it('refuses a tampered sibling sum', () => {
    const path = ok.path.map((p, i) => (i === 0 ? { ...p, sum: '0' } : p));
    assert.equal(verifyInclusion({ ...ok, path }, GOLDEN.root, GOLDEN.rootSum), false);
  });

  it('refuses a tampered sibling hash', () => {
    const path = ok.path.map((p, i) => (i === 1 ? { ...p, hash: '0'.repeat(64) } : p));
    assert.equal(verifyInclusion({ ...ok, path }, GOLDEN.root, GOLDEN.rootSum), false);
  });

  it('refuses a flipped path direction', () => {
    const path = ok.path.map((p, i) => (i === 0 ? { ...p, right: !p.right } : p));
    assert.equal(verifyInclusion({ ...ok, path }, GOLDEN.root, GOLDEN.rootSum), false);
  });

  it('refuses a negative sum anywhere in the proof', () => {
    assert.equal(verifyInclusion({ ...ok, leafSum: '-1' }, GOLDEN.root, GOLDEN.rootSum), false);
  });

  it('refuses malformed input rather than throwing', () => {
    assert.equal(verifyInclusion({ ...ok, leafSum: 'not-a-number' }, GOLDEN.root, GOLDEN.rootSum), false);
  });
});
