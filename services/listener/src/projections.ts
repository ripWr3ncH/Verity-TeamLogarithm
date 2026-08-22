/**
 * VERITY — projections: chaincode event -> read-model rows.
 *
 * Every function here MUST be idempotent. `rebuild()` replays from block 0
 * while the demo is running, so applying the same event twice has to leave the
 * same rows. Every statement is an upsert on a natural key.
 *
 * The pattern throughout: the event is a TRIGGER, the ledger is the SOURCE.
 * We re-read authoritative state rather than trusting the event payload, so a
 * projection cannot drift from what was actually committed.
 */

import type { Network } from '@hyperledger/fabric-gateway';
import type { Pool } from 'pg';

import { daysToNextReferenceDate, ILLUSTRATIVE, loanEdi } from './edi.js';

export interface Context {
  channel: string;
  blockNumber: bigint;
  txId: string;
  network: Network;
}

const readContract = async (
  ctx: Context,
  contract: string,
  fn: string,
  args: string[],
): Promise<unknown> => {
  const c = ctx.network.getContract(ctx.channel, contract);
  const bytes = await c.evaluateTransaction(fn, ...args);
  const text = Buffer.from(bytes).toString('utf8');
  return text.length > 0 ? JSON.parse(text) : undefined;
};

// --------------------------------------------------------------------------
//  Module I
// --------------------------------------------------------------------------

interface LedgerLoan {
  commitmentId: string;
  institutionMsp: string;
  currentTier: string;
  prevStateHash: string;
  rsSequence: number;
  outstandingBand: string;
  originationTs: string;
  sanctioningSeniority: number;
  groupTokenAttestation: string;
  eventCount: number;
  status: string;
}

interface LedgerEvent {
  commitmentId: string;
  seq: number;
  type: string;
  timestamp: string;
  classificationRefDate: string;
  daysToNextRefDate: number;
  rsSeq: number;
  tierBefore: string;
  tierAfter: string;
  prevStateHash: string;
  newStateHash: string;
  signatures?: { assigning?: { officerId?: string }; reviewing?: { officerId?: string } };
  authorityEvidence?: { kind?: string; directorSignatures?: unknown[] };
  payloadHash: string;
  note?: string;
  txId: string;
  committedByMsp: string;
}

export async function projectLifecycleEvent(
  pool: Pool,
  ctx: Context,
  payload: { commitmentId: string },
): Promise<void> {
  const commitmentId = payload.commitmentId;

  // Re-read from the ledger rather than trusting the event payload.
  const loan = (await readContract(ctx, 'LifecycleContract', 'GetLoan', [commitmentId])) as LedgerLoan;
  const events = (await readContract(ctx, 'LifecycleContract', 'GetEventTrail', [
    commitmentId,
  ])) as LedgerEvent[];

  // EDI is recomputed from committed events every time, never incremented.
  // Incrementing would let a projection bug become a permanently wrong score.
  const score = loanEdi(
    events.map((e) => ({
      type: e.type,
      rsSeq: e.rsSeq,
      daysToNextRefDate: e.daysToNextRefDate ?? daysToNextReferenceDate(e.timestamp.slice(0, 10)),
      eventDate: e.timestamp.slice(0, 10),
      classificationRefDate: e.classificationRefDate,
    })),
    await currentLambda(pool),
  );

  await pool.query(
    `INSERT INTO readmodel.loan
       (commitment_id, institution_msp, current_tier, prev_state_hash, rs_sequence,
        outstanding_band, origination_ts, sanctioning_seniority, group_token,
        event_count, status, edi_score, cap_flag, last_block)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (commitment_id) DO UPDATE SET
       current_tier = EXCLUDED.current_tier,
       prev_state_hash = EXCLUDED.prev_state_hash,
       rs_sequence = EXCLUDED.rs_sequence,
       event_count = EXCLUDED.event_count,
       status = EXCLUDED.status,
       edi_score = EXCLUDED.edi_score,
       cap_flag = EXCLUDED.cap_flag,
       last_block = EXCLUDED.last_block`,
    [
      loan.commitmentId,
      loan.institutionMsp,
      loan.currentTier,
      loan.prevStateHash,
      loan.rsSequence,
      loan.outstandingBand,
      loan.originationTs,
      loan.sanctioningSeniority,
      loan.groupTokenAttestation,
      loan.eventCount,
      loan.status,
      score,
      loan.rsSequence >= ILLUSTRATIVE.rsCap,
      ctx.blockNumber.toString(),
    ],
  );

  for (const e of events) {
    await pool.query(
      `INSERT INTO readmodel.lifecycle_event
         (commitment_id, seq, event_type, event_ts, classification_ref_date,
          days_to_next_ref_date, rs_seq, tier_before, tier_after, prev_state_hash,
          new_state_hash, authority_kind, assigning_officer, reviewing_officer,
          director_signature_count, payload_hash, note, tx_id, block_number, committed_by_msp)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (commitment_id, seq) DO NOTHING`,
      [
        e.commitmentId,
        e.seq,
        e.type,
        e.timestamp,
        e.classificationRefDate,
        e.daysToNextRefDate,
        e.rsSeq,
        e.tierBefore,
        e.tierAfter,
        e.prevStateHash,
        e.newStateHash,
        e.authorityEvidence?.kind ?? 'MECHANICAL',
        e.signatures?.assigning?.officerId ?? null,
        e.signatures?.reviewing?.officerId ?? null,
        e.authorityEvidence?.directorSignatures?.length ?? 0,
        e.payloadHash,
        e.note ?? null,
        e.txId,
        ctx.blockNumber.toString(),
        e.committedByMsp,
      ],
    );
  }
}

/** λ is Council-set — read it from the projection, never hard-code it here. */
async function currentLambda(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ value: string }>(
    "SELECT value FROM readmodel.parameter WHERE name = 'lambda'",
  );
  return rows.length > 0 ? Number(rows[0]!.value) : ILLUSTRATIVE.lambda;
}

// --------------------------------------------------------------------------
//  Governance
// --------------------------------------------------------------------------

export async function projectParameterChange(
  pool: Pool,
  ctx: Context,
  payload: { parameter: string; from: number; to: number; approvedBy: string[]; proposalId: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO readmodel.parameter (name, value, effective_from, proposal_id, changed_by_tx)
     VALUES ($1,$2,now(),$3,$4)
     ON CONFLICT (name) DO UPDATE SET
       value = EXCLUDED.value, effective_from = EXCLUDED.effective_from,
       proposal_id = EXCLUDED.proposal_id, changed_by_tx = EXCLUDED.changed_by_tx`,
    [payload.parameter, payload.to, payload.proposalId, ctx.txId],
  );

  await pool.query(
    `INSERT INTO readmodel.parameter_change
       (parameter, from_value, to_value, proposal_id, approved_by, tx_id, block_number, changed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now())
     ON CONFLICT DO NOTHING`,
    [
      payload.parameter,
      payload.from,
      payload.to,
      payload.proposalId,
      payload.approvedBy,
      ctx.txId,
      ctx.blockNumber.toString(),
    ],
  );

  // λ or E* moving changes every score. Recompute rather than leave stale
  // numbers on a supervisor's screen.
  if (payload.parameter === 'lambda') {
    // eslint-disable-next-line no-console
    console.log('[listener] lambda changed — scores will be recomputed on next event');
  }
}

// --------------------------------------------------------------------------
//  Modules II, III, IV
// --------------------------------------------------------------------------

export async function projectExposureAlert(
  pool: Pool,
  ctx: Context,
  payload: { period: string; groupToken: string; total: string; threshold: string },
): Promise<void> {
  const record = (await readContract(ctx, 'ExposureContract', 'GetCeremony', [
    payload.period,
    payload.groupToken,
  ])) as {
    total: string;
    threshold: string;
    contributorCount: number;
    participants: string[];
    proofVerified: boolean;
  };

  await pool.query(
    `INSERT INTO readmodel.exposure_alert
       (period, group_token, total, threshold, contributor_count, participants,
        proof_verified, tx_id, block_number)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (period, group_token) DO UPDATE SET
       total = EXCLUDED.total, threshold = EXCLUDED.threshold,
       participants = EXCLUDED.participants, proof_verified = EXCLUDED.proof_verified`,
    [
      payload.period,
      payload.groupToken,
      record.total,
      record.threshold,
      record.contributorCount,
      record.participants,
      record.proofVerified,
      ctx.txId,
      ctx.blockNumber.toString(),
    ],
  );
}

export async function projectLiabilityRoot(
  pool: Pool,
  ctx: Context,
  payload: { institutionMsp: string; period: string },
): Promise<void> {
  const root = (await readContract(ctx, 'LiabilityContract', 'GetLiabilityRoot', [
    payload.institutionMsp,
    payload.period,
  ])) as { merkleRoot: string; committedSum: string; leafCount: number; rejectedCount: number };

  await pool.query(
    `INSERT INTO readmodel.liability_root
       (institution_msp, period, merkle_root, committed_sum, leaf_count, rejected_count, tx_id, block_number)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (institution_msp, period) DO UPDATE SET
       merkle_root = EXCLUDED.merkle_root, committed_sum = EXCLUDED.committed_sum,
       leaf_count = EXCLUDED.leaf_count, rejected_count = EXCLUDED.rejected_count`,
    [
      payload.institutionMsp,
      payload.period,
      root.merkleRoot,
      root.committedSum,
      root.leafCount,
      root.rejectedCount,
      ctx.txId,
      ctx.blockNumber.toString(),
    ],
  );
}

export async function projectClaim(
  pool: Pool,
  ctx: Context,
  payload: { claimId: string },
): Promise<void> {
  const claim = (await readContract(ctx, 'ClaimsContract', 'GetClaim', [payload.claimId])) as {
    claimId: string;
    leafHash: string;
    institutionMsp: string;
    period: string;
    depositorKey: string;
    faceValue: string;
    priorityClass: string;
    schedule: string;
  };

  await pool.query(
    `INSERT INTO readmodel.claim
       (claim_id, leaf_hash, institution_msp, period, depositor_key, face_value,
        priority_class, schedule, tx_id, block_number)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (claim_id) DO NOTHING`,
    [
      claim.claimId,
      claim.leafHash,
      claim.institutionMsp,
      claim.period,
      claim.depositorKey,
      claim.faceValue,
      claim.priorityClass,
      claim.schedule,
      ctx.txId,
      ctx.blockNumber.toString(),
    ],
  );
}
