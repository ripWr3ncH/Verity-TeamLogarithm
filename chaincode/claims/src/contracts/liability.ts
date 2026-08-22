/**
 * VERITY — Module III: depositor-verifiable liabilities.
 *
 * Whitepaper §3.7.3:
 *   "We adopt the signed-leaf principle of [24] — a depositor balance enters
 *    the commitment only if the depositor has signed it — and combine it with a
 *    Merkle sum tree for O(log n) inclusion proofs."
 *
 * On-chain: the root, the committed sum, the leaf count, and nothing else.
 * Individual balances are off-chain (§4.2). A depositor's inclusion proof is
 * checked against the committed root, so the bank cannot show one depositor a
 * root and the ledger another.
 *
 * ⚠ BOUNDARY, from §3.7.3, and it must be said out loud in the demo:
 *   "A solvency statement establishes arithmetic consistency, not asset
 *    quality. Standing alone it would have been satisfied by the six reviewed
 *    banks. Its force comes only from Modules I and II."
 *
 * The zk-SNARK of §3.7.3 is NOT built in this prototype. Do not imply it is.
 */

import { Context, Contract, Info, Returns, Transaction } from 'fabric-contract-api';

import { InclusionProof, verifyInclusion } from '../domain/merkle-verify';

const KEY = { ROOT: 'LIABROOT', VERIFICATION: 'LIABVERIF' } as const;
const SUPERVISOR_MSP = 'BangladeshBankMSP';

interface LiabilityRoot {
  institutionMsp: string;
  period: string;
  merkleRoot: string;
  /** Total committed liabilities, smallest currency unit. */
  committedSum: string;
  leafCount: number;
  /** Leaves turned away for want of a depositor signature (§3.7.3). */
  rejectedCount: number;
  committedAt: string;
  committedBy: string;
  txId: string;
}

interface VerificationRecord {
  institutionMsp: string;
  period: string;
  leafHash: string;
  verified: boolean;
  verifiedAt: string;
  txId: string;
}

@Info({ title: 'LiabilityContract', description: 'Module III — signed-leaf Merkle sum liability commitments' })
export class LiabilityContract extends Contract {
  constructor() {
    super('LiabilityContract');
  }

  /**
   * Commit one period's liability root.
   *
   * `rejectedCount` is recorded deliberately. A bank whose depositors did not
   * sign has a smaller commitment, and the number of refusals is exactly the
   * thing a supervisor should be able to see — hiding it would let a bank
   * quietly exclude the depositors it found inconvenient.
   */
  @Transaction()
  async CommitLiabilityRoot(
    ctx: Context,
    period: string,
    merkleRoot: string,
    committedSum: string,
    leafCount: number,
    rejectedCount: number,
  ): Promise<string> {
    const callerMsp = ctx.clientIdentity.getMSPID();

    if (!/^[0-9a-f]{64}$/.test(merkleRoot)) {
      throw new Error('ROOT_INVALID: expected a 64-character hex SHA-256 root');
    }
    if (!/^\d+$/.test(committedSum)) {
      throw new Error('SUM_INVALID: committed sum must be a non-negative integer');
    }
    if (Number(leafCount) < 1) {
      throw new Error('EMPTY_COMMITMENT: a liability commitment must contain at least one signed leaf');
    }

    // Append-only, per period. Restating a period is a new period's problem.
    const key = ctx.stub.createCompositeKey(KEY.ROOT, [callerMsp, period]);
    const existing = await get<LiabilityRoot>(ctx, key);
    if (existing) {
      throw new Error(
        `APPEND_ONLY: ${callerMsp} has already committed a liability root for ${period} ` +
          `(${existing.merkleRoot.slice(0, 10)}…); a commitment cannot be silently restated`,
      );
    }

    const record: LiabilityRoot = {
      institutionMsp: callerMsp,
      period,
      merkleRoot,
      committedSum,
      leafCount: Number(leafCount),
      rejectedCount: Number(rejectedCount) || 0,
      committedAt: txTimestamp(ctx),
      committedBy: ctx.clientIdentity.getID(),
      txId: ctx.stub.getTxID(),
    };

    await put(ctx, key, record);
    ctx.stub.setEvent(
      'LiabilityRootCommitted',
      Buffer.from(JSON.stringify({ institutionMsp: callerMsp, period, leafCount: record.leafCount })),
    );

    return JSON.stringify(record);
  }

  @Transaction(false)
  @Returns('string')
  async GetLiabilityRoot(ctx: Context, institutionMsp: string, period: string): Promise<string> {
    const record = await this.rootOf(ctx, institutionMsp, period);
    return JSON.stringify(record);
  }

  /**
   * Verify a depositor's inclusion proof against the COMMITTED root.
   *
   * Evaluate-only, so a depositor checking their own position costs nothing and
   * leaves no trace of who looked. The same verification also runs in the
   * depositor's browser (packages/crypto) — §3.7.3 and §4.7 both turn on the
   * depositor not having to trust our server either. This endpoint exists so
   * the ledger will confirm the same answer independently.
   */
  @Transaction(false)
  @Returns('string')
  async VerifyInclusion(
    ctx: Context,
    institutionMsp: string,
    period: string,
    proofJson: string,
  ): Promise<string> {
    const record = await this.rootOf(ctx, institutionMsp, period);
    const proof = JSON.parse(proofJson) as InclusionProof;
    const verified = verifyInclusion(proof, record.merkleRoot, record.committedSum);

    return JSON.stringify({
      verified,
      institutionMsp,
      period,
      merkleRoot: record.merkleRoot,
      committedSum: record.committedSum,
      leafCount: record.leafCount,
      reason: verified
        ? undefined
        : 'PROOF_INVALID: this leaf and path do not reconstruct the committed root and sum',
    });
  }

  /**
   * A supervisor recording that it checked a proof. Submit, so the check is on
   * the record — §4.7's "supervisory queries leave a permanent trace" applies to
   * verification as much as to reading.
   */
  @Transaction()
  async RecordVerification(
    ctx: Context,
    institutionMsp: string,
    period: string,
    proofJson: string,
  ): Promise<string> {
    const callerMsp = ctx.clientIdentity.getMSPID();
    if (callerMsp !== SUPERVISOR_MSP && callerMsp !== 'FRCMSP') {
      throw new Error(
        `UNAUTHORISED_INSTITUTION: recording a verification is reserved to the supervisor ` +
          `and the FRC; caller is ${callerMsp}`,
      );
    }

    const record = await this.rootOf(ctx, institutionMsp, period);
    const proof = JSON.parse(proofJson) as InclusionProof;
    const verified = verifyInclusion(proof, record.merkleRoot, record.committedSum);

    const verification: VerificationRecord = {
      institutionMsp,
      period,
      leafHash: proof.leafHash,
      verified,
      verifiedAt: txTimestamp(ctx),
      txId: ctx.stub.getTxID(),
    };
    await put(
      ctx,
      ctx.stub.createCompositeKey(KEY.VERIFICATION, [institutionMsp, period, proof.leafHash]),
      verification,
    );
    return JSON.stringify(verification);
  }

  @Transaction(false)
  @Returns('string')
  async ListLiabilityRoots(ctx: Context, institutionMsp: string): Promise<string> {
    return JSON.stringify(await list<LiabilityRoot>(ctx, KEY.ROOT, [institutionMsp]));
  }

  private async rootOf(ctx: Context, institutionMsp: string, period: string): Promise<LiabilityRoot> {
    const record = await get<LiabilityRoot>(
      ctx,
      ctx.stub.createCompositeKey(KEY.ROOT, [institutionMsp, period]),
    );
    if (!record) {
      throw new Error(`ROOT_NOT_FOUND: ${institutionMsp} has committed no liability root for ${period}`);
    }
    return record;
  }
}

// --------------------------------------------------------------------------

async function get<T>(ctx: Context, key: string): Promise<T | undefined> {
  const bytes = await ctx.stub.getState(key);
  return bytes && bytes.length > 0 ? (JSON.parse(bytes.toString()) as T) : undefined;
}

async function put(ctx: Context, key: string, value: unknown): Promise<void> {
  await ctx.stub.putState(key, Buffer.from(JSON.stringify(value)));
}

async function list<T>(ctx: Context, type: string, attrs: string[]): Promise<T[]> {
  const out: T[] = [];
  const it = await ctx.stub.getStateByPartialCompositeKey(type, attrs);
  try {
    for (let r = await it.next(); !r.done; r = await it.next()) {
      const v = r.value?.value;
      if (v && v.length > 0) out.push(JSON.parse(v.toString()) as T);
    }
  } finally {
    await it.close();
  }
  return out;
}

function txTimestamp(ctx: Context): string {
  const ts = ctx.stub.getTxTimestamp();
  return new Date(Number(ts.seconds) * 1000 + Math.floor(ts.nanos / 1e6)).toISOString();
}
