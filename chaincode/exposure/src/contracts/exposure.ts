/**
 * VERITY — Module II: cross-bank beneficial-owner exposure.
 *
 * Whitepaper §3.7.2. The problem, from §1.1:
 *   "Every exposure limit is computed inside one bank. A group borrowing
 *    through nominees across many banks may sit below all of them."
 *
 * The flow this contract implements, exactly as corrected in §3.7.2:
 *
 *     banks submit ciphertexts
 *       -> homomorphic aggregation            (here, on-ledger, deterministic)
 *       -> threshold decryption to Bangladesh Bank
 *          under supervisor + quorum          (off-chain ceremony)
 *       -> comparison in the clear            (here, after proof-checking)
 *       -> alert
 *
 * ⚠ The withdrawn v6 design performed the threshold check ON THE CIPHERTEXT.
 * Paillier cannot do that — comparison is not a native homomorphic operation.
 * The whitepaper's own [FIX] notes flag it. Do not reintroduce it.
 *
 * Two properties the code enforces rather than promises:
 *
 *   1. A bank may write only its OWN contribution. Enforced on the caller's MSP.
 *   2. Only an AGGREGATE may be opened by a ceremony. `RecordCeremony` reads the
 *      committed aggregate itself and checks the proof against that — there is
 *      no code path that will open a single bank's submission, so
 *      "never which bank holds how much" is structural, not procedural.
 */

import { Context, Contract, Info, Returns, Transaction } from 'fabric-contract-api';

import {
  AggregationKey,
  aggregateCiphertexts,
  evaluateThreshold,
  verifyDecryptionProof,
} from '../domain/paillier-verify';

const KEY = {
  AGGKEY: 'AGGKEY',
  SUBMISSION: 'EXPSUB',
  AGGREGATE: 'EXPAGG',
  CEREMONY: 'CEREMONY',
} as const;

const SUPERVISOR_MSP = 'BangladeshBankMSP';

interface Submission {
  period: string;
  groupToken: string;
  bankMsp: string;
  ciphertext: string;
  submittedAt: string;
}

interface Aggregate {
  period: string;
  groupToken: string;
  ciphertext: string;
  contributorCount: number;
  contributors: string[];
  aggregatedAt: string;
  txId: string;
}

interface CeremonyRecord {
  period: string;
  groupToken: string;
  total: string;
  threshold: string;
  alert: boolean;
  participants: string[];
  contributorCount: number;
  proofVerified: true;
  recordedAt: string;
  txId: string;
}

@Info({ title: 'ExposureContract', description: 'Module II — encrypted cross-bank exposure aggregation' })
export class ExposureContract extends Contract {
  constructor() {
    super('ExposureContract');
  }

  // ======================================================================
  //  Setup
  // ======================================================================

  /**
   * Publish the Paillier public key for a period. Public by definition — it is
   * what banks encrypt under and what anyone uses to check a decryption proof.
   * The matching private key is never here: it is split across the supervisor
   * and the independent holders (packages/crypto/ceremony.ts).
   */
  @Transaction()
  async SetAggregationKey(ctx: Context, period: string, publicKeyJson: string): Promise<void> {
    requireMsp(ctx, SUPERVISOR_MSP, 'publishing the aggregation key');
    const key = JSON.parse(publicKeyJson) as AggregationKey;
    if (!key.n || !key.nSquared) throw new Error('AGGREGATION_KEY_INVALID: n and nSquared are required');
    await put(ctx, compositeKey(ctx, KEY.AGGKEY, [period]), key);
  }

  @Transaction(false)
  @Returns('string')
  async GetAggregationKey(ctx: Context, period: string): Promise<string> {
    return JSON.stringify(await this.aggregationKey(ctx, period));
  }

  // ======================================================================
  //  Submission
  // ======================================================================

  /**
   * A bank submits its encrypted exposure to one borrower-group token.
   *
   * The caller's MSP is taken from the certificate and used as the key, so a
   * bank physically cannot submit on another's behalf — red-team territory, and
   * the refusal names both institutions.
   */
  @Transaction()
  async SubmitEncryptedExposure(
    ctx: Context,
    period: string,
    groupToken: string,
    ciphertext: string,
    claimedBankMsp: string,
  ): Promise<string> {
    const callerMsp = ctx.clientIdentity.getMSPID();

    if (claimedBankMsp && claimedBankMsp !== callerMsp) {
      throw new Error(
        `UNAUTHORISED_INSTITUTION: ${callerMsp} cannot submit an exposure on behalf of ` +
          `${claimedBankMsp}; no participant may write another institution's record`,
      );
    }
    if (!/^\d+$/.test(ciphertext)) {
      throw new Error('CIPHERTEXT_INVALID: expected a decimal Paillier ciphertext');
    }
    await this.aggregationKey(ctx, period); // fails loudly if the period is not open

    const submission: Submission = {
      period,
      groupToken,
      bankMsp: callerMsp,
      ciphertext,
      submittedAt: txTimestamp(ctx),
    };
    await put(ctx, compositeKey(ctx, KEY.SUBMISSION, [period, groupToken, callerMsp]), submission);

    return JSON.stringify({ period, groupToken, bankMsp: callerMsp, accepted: true });
  }

  // ======================================================================
  //  Aggregation — deterministic, so it runs here rather than off-chain
  // ======================================================================

  /**
   * Enc(X_g) = ∏_b Enc(x_{b,g}). Nothing is decrypted, and the aggregator holds
   * no key. Running it in chaincode means every endorsing peer recomputes the
   * same product — the aggregate is not something one party asserts.
   *
   * §4.7 also asks for a MINIMUM CONTRIBUTOR COUNT, because an aggregate over a
   * single bank IS that bank's position. Enforced here.
   */
  @Transaction()
  async AggregateGroup(
    ctx: Context,
    period: string,
    groupToken: string,
    minContributors: number,
  ): Promise<string> {
    const key = await this.aggregationKey(ctx, period);
    const submissions = await list<Submission>(ctx, KEY.SUBMISSION, [period, groupToken]);

    const floor = Math.max(2, Number(minContributors) || 2);
    if (submissions.length < floor) {
      throw new Error(
        `MINIMUM_CONTRIBUTORS: ${submissions.length} of ${floor} institutions have submitted for ` +
          `${groupToken}; an aggregate over fewer would disclose an individual position`,
      );
    }

    const ordered = [...submissions].sort((a, b) => a.bankMsp.localeCompare(b.bankMsp));
    const ciphertext = aggregateCiphertexts(key, ordered.map((s) => s.ciphertext));

    const aggregate: Aggregate = {
      period,
      groupToken,
      ciphertext,
      contributorCount: ordered.length,
      contributors: ordered.map((s) => s.bankMsp),
      aggregatedAt: txTimestamp(ctx),
      txId: ctx.stub.getTxID(),
    };
    await put(ctx, compositeKey(ctx, KEY.AGGREGATE, [period, groupToken]), aggregate);

    return JSON.stringify({
      period,
      groupToken,
      contributorCount: aggregate.contributorCount,
      ciphertextDigits: ciphertext.length,
      decrypted: false,
    });
  }

  // ======================================================================
  //  Ceremony result — proof-checked, then compared in the clear
  // ======================================================================

  /**
   * Record the outcome of a threshold decryption ceremony.
   *
   * The chaincode does NOT trust the announced total. It re-derives the check
   *
   *     c ≟ (1 + m·n) · rⁿ  (mod n²)
   *
   * against the aggregate IT committed, using only public values. A supervisor
   * announcing a total the ciphertext does not carry is refused by every peer.
   *
   * There is no parameter here for "which ciphertext" — it always reads the
   * committed aggregate. That is what makes "never which bank holds how much"
   * structural: no code path opens an individual submission.
   */
  @Transaction()
  async RecordCeremony(
    ctx: Context,
    period: string,
    groupToken: string,
    total: string,
    randomness: string,
    participantsJson: string,
    thetaScaledBy10k: number,
    systemCapital: string,
  ): Promise<string> {
    requireMsp(ctx, SUPERVISOR_MSP, 'recording a decryption ceremony');

    const key = await this.aggregationKey(ctx, period);
    const aggregate = await get<Aggregate>(ctx, compositeKey(ctx, KEY.AGGREGATE, [period, groupToken]));
    if (!aggregate) {
      throw new Error(`AGGREGATE_NOT_FOUND: no committed aggregate for ${groupToken} in ${period}`);
    }

    const participants = JSON.parse(participantsJson) as string[];
    const independents = participants.filter((p) => p !== 'BangladeshBank' && p !== SUPERVISOR_MSP);
    if (independents.length < 2) {
      throw new Error(
        `CEREMONY_QUORUM_SHORT: ${independents.length} of 2 independent holders recorded; ` +
          'the supervisor cannot decrypt alone (§3.7.2)',
      );
    }

    if (!verifyDecryptionProof(key, aggregate.ciphertext, total, randomness)) {
      throw new Error(
        'DECRYPTION_PROOF_INVALID: the announced total is not the plaintext of the committed ' +
          'aggregate; c != (1 + m*n) * r^n mod n^2',
      );
    }

    const { alert, threshold } = evaluateThreshold(
      total,
      BigInt(Math.round(Number(thetaScaledBy10k))),
      systemCapital,
    );

    const record: CeremonyRecord = {
      period,
      groupToken,
      total,
      threshold,
      alert,
      participants,
      contributorCount: aggregate.contributorCount,
      proofVerified: true,
      recordedAt: txTimestamp(ctx),
      txId: ctx.stub.getTxID(),
    };
    await put(ctx, compositeKey(ctx, KEY.CEREMONY, [period, groupToken]), record);

    if (alert) {
      ctx.stub.setEvent(
        'ExposureAlert',
        Buffer.from(JSON.stringify({ period, groupToken, total, threshold })),
      );
    }

    return JSON.stringify(record);
  }

  // ======================================================================
  //  Reads
  // ======================================================================

  @Transaction(false)
  @Returns('string')
  async GetAggregate(ctx: Context, period: string, groupToken: string): Promise<string> {
    const aggregate = await get<Aggregate>(ctx, compositeKey(ctx, KEY.AGGREGATE, [period, groupToken]));
    if (!aggregate) throw new Error(`AGGREGATE_NOT_FOUND: ${groupToken} in ${period}`);
    return JSON.stringify(aggregate);
  }

  @Transaction(false)
  @Returns('string')
  async GetCeremony(ctx: Context, period: string, groupToken: string): Promise<string> {
    const record = await get<CeremonyRecord>(ctx, compositeKey(ctx, KEY.CEREMONY, [period, groupToken]));
    if (!record) throw new Error(`CEREMONY_NOT_FOUND: ${groupToken} in ${period}`);
    return JSON.stringify(record);
  }

  @Transaction(false)
  @Returns('string')
  async ListAlerts(ctx: Context, period: string): Promise<string> {
    const all = await list<CeremonyRecord>(ctx, KEY.CEREMONY, [period]);
    return JSON.stringify(all.filter((r) => r.alert));
  }

  /**
   * How many institutions submitted, WITHOUT revealing any ciphertext.
   * Enough for a bank to see the aggregation ran; not enough to learn anything.
   */
  @Transaction(false)
  @Returns('string')
  async ContributorCount(ctx: Context, period: string, groupToken: string): Promise<string> {
    const submissions = await list<Submission>(ctx, KEY.SUBMISSION, [period, groupToken]);
    return JSON.stringify({ period, groupToken, contributorCount: submissions.length });
  }

  private async aggregationKey(ctx: Context, period: string): Promise<AggregationKey> {
    const key = await get<AggregationKey>(ctx, compositeKey(ctx, KEY.AGGKEY, [period]));
    if (!key) {
      throw new Error(
        `AGGREGATION_PERIOD_CLOSED: no aggregation key published for ${period}; ` +
          'Bangladesh Bank opens a period before submissions are accepted',
      );
    }
    return key;
  }
}

// --------------------------------------------------------------------------

function compositeKey(ctx: Context, type: string, attrs: string[]): string {
  return ctx.stub.createCompositeKey(type, attrs);
}

function requireMsp(ctx: Context, mspId: string, action: string): void {
  const callerMsp = ctx.clientIdentity.getMSPID();
  if (callerMsp !== mspId) {
    throw new Error(`UNAUTHORISED_INSTITUTION: ${action} is reserved to ${mspId}; caller is ${callerMsp}`);
  }
}

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
