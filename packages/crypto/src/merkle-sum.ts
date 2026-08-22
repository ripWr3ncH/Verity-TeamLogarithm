/**
 * VERITY — Merkle sum tree with signed leaves, for Module III.
 *
 * Whitepaper §3.7.3:
 *   "We adopt the SIGNED-LEAF principle of [24] — a depositor balance enters
 *    the commitment only if the depositor has signed it — and combine it with a
 *    Merkle sum tree for O(log n) inclusion proofs. This hybrid is our
 *    construction, not that of [24], which uses KZG and BLS."
 *
 * Two properties the plain proof-of-liability schemes lack, and why each matters:
 *
 *  1. SIGNED LEAVES. [24] shows deployed schemes cannot resist a provider
 *     colluding with a user — a fake user with a negative or fabricated balance
 *     can be inserted to make liabilities look smaller. A leaf that must carry
 *     the depositor's own signature cannot be fabricated by the bank alone.
 *
 *  2. SUMS AT EVERY NODE. An inclusion proof carries the sibling sums, so a
 *     depositor verifies not only "my balance is in the tree" but "the total
 *     the bank published actually contains mine". A bank cannot publish a root
 *     whose committed sum is smaller than the leaves underneath it.
 *
 * Negative balances are rejected at insertion — that is the other half of the
 * collusion attack in [24].
 */

import { createHash } from 'crypto';

export interface SignedLeaf {
  /** Salted account reference. §4.7: "Account identifiers are salted." */
  accountRef: string;
  /** Balance in the smallest currency unit (poisha). Integers only. */
  balance: bigint;
  /** Depositor's ed25519 public key, base64 SPKI DER. */
  depositorKey: string;
  /** Depositor's signature over the leaf digest. */
  signature: string;
  /** Period this attestation covers, e.g. "2027-03-31". */
  period: string;
}

export interface MerkleSumNode {
  hash: string;
  sum: bigint;
}

export interface InclusionProof {
  leafIndex: number;
  leafHash: string;
  leafSum: string;
  /** Sibling nodes from the leaf up. `right` says which side the sibling is on. */
  path: Array<{ hash: string; sum: string; right: boolean }>;
  root: string;
  rootSum: string;
}

const H = (input: string): string => createHash('sha256').update(input).digest('hex');

/**
 * What the depositor signs. Binds the balance to THIS account and THIS period,
 * so a signature cannot be replayed into a later commitment.
 */
export function leafDigest(accountRef: string, balance: bigint, period: string): string {
  return H(`verity:leaf:v1:${accountRef}:${balance.toString()}:${period}`);
}

/** Leaf node hash. Domain-separated from internal nodes to stop type confusion. */
export function leafHash(leaf: Pick<SignedLeaf, 'accountRef' | 'balance' | 'period'>): string {
  return H(`verity:node:leaf:${leafDigest(leaf.accountRef, leaf.balance, leaf.period)}`);
}

export function internalHash(left: MerkleSumNode, right: MerkleSumNode): string {
  return H(`verity:node:int:${left.hash}:${left.sum}:${right.hash}:${right.sum}`);
}

// --------------------------------------------------------------------------

export class MerkleSumTree {
  private readonly levels: MerkleSumNode[][] = [];
  readonly leaves: SignedLeaf[];

  /**
   * @param leaves  Must already be signature-verified. Build via
   *                `buildVerifiedTree` rather than calling this directly, so
   *                unsigned leaves cannot slip in.
   */
  constructor(leaves: SignedLeaf[]) {
    if (leaves.length === 0) throw new Error('cannot commit an empty liability set');
    for (const leaf of leaves) {
      if (leaf.balance < 0n) {
        throw new Error(
          `NEGATIVE_BALANCE: ${leaf.accountRef} carries a negative balance; a negative ` +
            'leaf is how a provider colluding with a user shrinks apparent liabilities [24]',
        );
      }
    }

    this.leaves = leaves;
    let level: MerkleSumNode[] = leaves.map((l) => ({ hash: leafHash(l), sum: l.balance }));
    this.levels.push(level);

    while (level.length > 1) {
      const next: MerkleSumNode[] = [];
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i]!;
        // Odd node is promoted, not duplicated: duplicating a leaf would double
        // its balance in the sum.
        const right = level[i + 1];
        next.push(
          right
            ? { hash: internalHash(left, right), sum: left.sum + right.sum }
            : { hash: left.hash, sum: left.sum },
        );
      }
      this.levels.push(next);
      level = next;
    }
  }

  get root(): string {
    return this.levels[this.levels.length - 1]![0]!.hash;
  }

  get rootSum(): bigint {
    return this.levels[this.levels.length - 1]![0]!.sum;
  }

  get size(): number {
    return this.leaves.length;
  }

  /** O(log n) inclusion proof for one depositor. */
  prove(leafIndex: number): InclusionProof {
    if (leafIndex < 0 || leafIndex >= this.leaves.length) throw new Error('leaf index out of range');

    const path: InclusionProof['path'] = [];
    let index = leafIndex;

    for (let level = 0; level < this.levels.length - 1; level++) {
      const nodes = this.levels[level]!;
      const isRightChild = index % 2 === 1;
      const siblingIndex = isRightChild ? index - 1 : index + 1;
      const sibling = nodes[siblingIndex];

      // No sibling means this node was promoted unchanged.
      if (sibling) {
        path.push({ hash: sibling.hash, sum: sibling.sum.toString(), right: !isRightChild });
      }
      index = Math.floor(index / 2);
    }

    const leafNode = this.levels[0]![leafIndex]!;
    return {
      leafIndex,
      leafHash: leafNode.hash,
      leafSum: leafNode.sum.toString(),
      path,
      root: this.root,
      rootSum: this.rootSum.toString(),
    };
  }
}

/**
 * Verify an inclusion proof.
 *
 * Runs CLIENT-SIDE in the depositor's browser. §3.7.3 and §4.7 both turn on
 * this: usability is treated as a security property, and a proof the depositor
 * cannot check themselves is not a proof they have any reason to believe. They
 * are not trusting our server either.
 */
export function verifyInclusion(proof: InclusionProof): boolean {
  try {
    let node: MerkleSumNode = { hash: proof.leafHash, sum: BigInt(proof.leafSum) };

    for (const step of proof.path) {
      const sibling: MerkleSumNode = { hash: step.hash, sum: BigInt(step.sum) };
      node = step.right
        ? { hash: internalHash(node, sibling), sum: node.sum + sibling.sum }
        : { hash: internalHash(sibling, node), sum: sibling.sum + node.sum };
    }

    // Both must match. A root alone would let a bank publish a sum smaller than
    // the balances it actually holds.
    return node.hash === proof.root && node.sum === BigInt(proof.rootSum);
  } catch {
    return false;
  }
}

/**
 * Build a tree from candidate leaves, admitting only those whose depositor
 * signature verifies. Returns the tree and the leaves that were turned away.
 *
 * This is the signed-leaf principle enforced, rather than described.
 *
 * `tree` is null when every candidate was rejected. That is a real outcome, not
 * an error: a bank whose depositors have all declined to sign has no liability
 * commitment to publish, and the caller needs to see the rejection list to know
 * why. (An earlier version threw here, which hid the reasons.)
 */
export function buildVerifiedTree(
  candidates: SignedLeaf[],
  verify: (publicKey: string, digestHex: string, signature: string) => boolean,
): { tree: MerkleSumTree | null; rejected: Array<{ accountRef: string; reason: string }> } {
  const accepted: SignedLeaf[] = [];
  const rejected: Array<{ accountRef: string; reason: string }> = [];

  for (const leaf of candidates) {
    if (leaf.balance < 0n) {
      rejected.push({ accountRef: leaf.accountRef, reason: 'NEGATIVE_BALANCE' });
      continue;
    }
    const digest = leafDigest(leaf.accountRef, leaf.balance, leaf.period);
    if (!verify(leaf.depositorKey, digest, leaf.signature)) {
      rejected.push({
        accountRef: leaf.accountRef,
        reason: 'UNSIGNED_LEAF: the depositor has not signed this balance for this period',
      });
      continue;
    }
    accepted.push(leaf);
  }

  return { tree: accepted.length > 0 ? new MerkleSumTree(accepted) : null, rejected };
}
