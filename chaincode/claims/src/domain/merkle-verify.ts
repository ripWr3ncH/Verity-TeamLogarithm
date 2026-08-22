/**
 * VERITY — Merkle sum verification for chaincode.
 *
 * The verifying half of packages/crypto/merkle-sum.ts. Building a tree needs
 * every leaf, so it happens off-chain; VERIFYING a proof needs only the proof,
 * and is deterministic, so chaincode does it.
 *
 * DUPLICATION NOTICE: intentional. Fabric runs `npm install` inside the peer's
 * build container where workspace symlinks do not resolve.
 * See HANDOFF/PHASE_00_FOUNDATION.md §2.4.
 *
 * ⚠ The hash construction here MUST stay byte-identical to
 * packages/crypto/src/merkle-sum.ts. If you change a domain-separation string
 * in one, change it in the other in the same commit, or every depositor's proof
 * silently stops verifying.
 */

import { createHash } from 'crypto';

const H = (input: string): string => createHash('sha256').update(input).digest('hex');

export interface MerkleSumNode {
  hash: string;
  sum: bigint;
}

export interface InclusionProof {
  leafIndex: number;
  leafHash: string;
  leafSum: string;
  path: Array<{ hash: string; sum: string; right: boolean }>;
  root: string;
  rootSum: string;
}

export function leafDigest(accountRef: string, balance: string, period: string): string {
  return H(`verity:leaf:v1:${accountRef}:${balance}:${period}`);
}

export function leafHash(accountRef: string, balance: string, period: string): string {
  return H(`verity:node:leaf:${leafDigest(accountRef, balance, period)}`);
}

export function internalHash(left: MerkleSumNode, right: MerkleSumNode): string {
  return H(`verity:node:int:${left.hash}:${left.sum}:${right.hash}:${right.sum}`);
}

/**
 * Verify an inclusion proof against a committed root.
 *
 * BOTH the hash and the sum must match. Checking only the hash would let a bank
 * publish a committed total smaller than the balances actually underneath it —
 * which is the specific failure a plain Merkle tree cannot catch, and the
 * reason §3.7.3 specifies a Merkle SUM tree.
 */
export function verifyInclusion(proof: InclusionProof, expectedRoot: string, expectedRootSum: string): boolean {
  try {
    if (proof.root !== expectedRoot) return false;
    if (proof.rootSum !== expectedRootSum) return false;

    let node: MerkleSumNode = { hash: proof.leafHash, sum: BigInt(proof.leafSum) };
    if (node.sum < 0n) return false;

    for (const step of proof.path) {
      const sibling: MerkleSumNode = { hash: step.hash, sum: BigInt(step.sum) };
      if (sibling.sum < 0n) return false;
      node = step.right
        ? { hash: internalHash(node, sibling), sum: node.sum + sibling.sum }
        : { hash: internalHash(sibling, node), sum: sibling.sum + node.sum };
    }

    return node.hash === expectedRoot && node.sum === BigInt(expectedRootSum);
  } catch {
    return false;
  }
}
