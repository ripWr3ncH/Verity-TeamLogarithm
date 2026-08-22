/**
 * VERITY — the other half of the golden vector.
 *
 * These are the SAME constants as chaincode/claims/test/merkle-verify.test.ts.
 * The Merkle sum construction is duplicated across the off-chain builder and
 * the on-chain verifier (Fabric cannot resolve workspace symlinks inside the
 * peer's build container), so something has to pin the two together. This is it.
 *
 * A domain-separation string changed on one side and not the other turns one of
 * these two suites red. Without them, the drift would surface as every
 * depositor's inclusion proof silently failing — on demo day, in front of
 * judges, with no obvious cause.
 *
 * DO NOT regenerate these to make a test pass. Work out which side changed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MerkleSumTree, SignedLeaf, verifyInclusion } from '../src/merkle-sum';

const PERIOD = '2027-03-31';

const GOLDEN_ROOT = 'c56e60870474983fb56f5d9fbe3320a58f316b1a4c0ffc65248dd745c94f0424';
const GOLDEN_ROOT_SUM = 164_840_000n;
const GOLDEN_LEAF2_HASH = '2c8aa74e015dde5388ce300793c6b9341492834923c8f391461a64cc159d20da';

/** Signatures are not exercised here — the builder is fed already-verified leaves. */
const leaves: SignedLeaf[] = [
  { accountRef: 'acct-salted-0', balance: 34_250_000n, depositorKey: 'x', signature: 'x', period: PERIOD },
  { accountRef: 'acct-salted-1', balance: 120_000_000n, depositorKey: 'x', signature: 'x', period: PERIOD },
  { accountRef: 'acct-salted-2', balance: 5_500_000n, depositorKey: 'x', signature: 'x', period: PERIOD },
  { accountRef: 'acct-salted-3', balance: 890_000n, depositorKey: 'x', signature: 'x', period: PERIOD },
  { accountRef: 'acct-salted-4', balance: 4_200_000n, depositorKey: 'x', signature: 'x', period: PERIOD },
];

describe('golden vector — off-chain builder', () => {
  const tree = new MerkleSumTree(leaves);

  it('produces the pinned root', () => {
    assert.equal(tree.root, GOLDEN_ROOT);
  });

  it('produces the pinned root sum', () => {
    assert.equal(tree.rootSum, GOLDEN_ROOT_SUM);
  });

  it('produces the pinned leaf hash for leaf 2', () => {
    assert.equal(tree.prove(2).leafHash, GOLDEN_LEAF2_HASH);
  });

  it('produces a three-step path for leaf 2', () => {
    const proof = tree.prove(2);
    assert.equal(proof.path.length, 3);
    assert.deepEqual(
      proof.path.map((p) => p.right),
      [true, false, true],
    );
    assert.equal(verifyInclusion(proof), true);
  });

  it('is stable across rebuilds', () => {
    assert.equal(new MerkleSumTree(leaves).root, GOLDEN_ROOT);
  });
});
