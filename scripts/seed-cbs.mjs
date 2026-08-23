#!/usr/bin/env node
/**
 * VERITY — populate the mock core banking system and file its CL-1 returns.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THIS SCRIPT WRITES AS THE DATABASE OWNER, NOT AS THE ADAPTER.
 *
 *  It is standing in for the BANK's own core system — the estate that exists
 *  before Verity and keeps operating unchanged afterwards. Verity never writes
 *  here; the adapter role holds SELECT and nothing else (§4.3), and the API
 *  connects with that role precisely so the claim is structural.
 *
 *  If you ever find yourself needing to write to cbs.* from Verity code, the
 *  design has gone wrong.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── THE OMISSION ─────────────────────────────────────────────────────────
 *
 * §3.7.1: "Omission is prevented by reconciliation. Committed aggregates must
 * reconcile to the CL-1 already submitted. A loan absent from the tree but
 * present in CL-1, or absent from both while sitting on the balance sheet, is
 * an unrecorded asset."
 *
 * So the CL-1 filed here deliberately OMITS the highest-scoring exposures. That
 * is the finding Act 0 opens on: the return is not false, it is incomplete, and
 * nothing in the return itself reveals that.
 *
 *   node scripts/seed-cbs.mjs
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pg = require('pg');

const { Pool } = pg;
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://verity:verity@localhost:5433/verity',
});

/** Reference date the CL-1 return covers. */
const REFERENCE_DATE = process.env.VERITY_REFERENCE_DATE ?? '2029-03-31';

/** How many high-scoring exposures the bank leaves off its return. */
const OMISSIONS = Number(process.env.VERITY_OMISSIONS ?? 2);

const C = { dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', amber: '\x1b[33m', off: '\x1b[0m' };

const seed = JSON.parse(readFileSync('seed/out/seed.json', 'utf8'));

console.log(`\n${C.bold}  Mock core banking system${C.off}`);
console.log(`  ${C.dim}written as the database owner — this is the bank's estate, not Verity's${C.off}\n`);

const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('TRUNCATE cbs.cl1_filing, cbs.reschedule_history, cbs.loan_master, cbs.deposit_account, cbs.borrower CASCADE');

  // ── borrowers ───────────────────────────────────────────────────────────
  // PII. Stays here, off-chain, referenced from the ledger only by hash (§4.2).
  const groups = [...new Set(seed.loans.map((l) => l.groupToken))];
  for (const [i, token] of groups.entries()) {
    await client.query(
      `INSERT INTO cbs.borrower (borrower_id, legal_name, national_id, registered_addr, rjsc_number, declared_owners, cib_subject_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        token,
        `Synthetic Borrower Group ${i + 1} Ltd`,
        `SYNTH-${String(1000000 + i)}`,
        `Plot ${i + 1}, Synthetic Commercial Area, Dhaka`,
        `C-${100000 + i}`,
        JSON.stringify([{ name: `Synthetic Owner ${i + 1}`, share: 100 }]),
        `CIB-${String(200000 + i)}`,
      ],
    );
  }
  console.log(`  borrowers          ${groups.length}`);

  // ── loan master ─────────────────────────────────────────────────────────
  for (const loan of seed.loans) {
    await client.query(
      `INSERT INTO cbs.loan_master
         (loan_account_no, borrower_id, institution_msp, sanction_date, principal_poisha,
          outstanding_poisha, tenor_months, classification, rs_counter,
          collateral_ref, collateral_value_poisha, sanctioning_officer, sanctioning_seniority)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        loan.commitmentId,
        loan.groupToken,
        loan.institutionMsp,
        loan.originationDate,
        String(loan.outstanding),
        String(loan.outstanding),
        60,
        loan.currentTier,
        loan.rsSequence,
        `COL-${loan.commitmentId}`,
        String(Math.round(loan.outstanding * 0.7)),
        loan.sanctioningOfficerRole,
        loan.sanctioningSeniority,
      ],
    );

    // The RS-n counter, as CIB keeps it. §1.1: "records how many times, not
    // when." The reschedule_history below carries a self-reported approval
    // level with nothing binding it to the directors.
    for (const e of loan.events.filter((x) => x.type === 'RESCHEDULE')) {
      await client.query(
        `INSERT INTO cbs.reschedule_history
           (loan_account_no, rs_seq, reschedule_date, tier_before, tier_after, approval_level, approved_by, justification)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT DO NOTHING`,
        [
          loan.commitmentId,
          e.rsSeq,
          e.eventDate,
          e.tierBefore,
          e.tierAfter,
          e.rsSeq >= 3 ? 'Board' : 'One level above sanctioning',
          e.rsSeq >= 3 ? 'Board resolution (self-reported)' : 'Reviewing officer',
          'Cash-flow disruption; borrower request.',
        ],
      );
    }
  }
  console.log(`  loan master        ${seed.loans.length}`);

  // ── deposit accounts ────────────────────────────────────────────────────
  for (const d of seed.depositors) {
    await client.query(
      `INSERT INTO cbs.deposit_account
         (account_no, institution_msp, holder_name, holder_nid, balance_poisha, account_type, opened_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        d.accountRef,
        d.institutionMsp,
        `Synthetic Depositor ${d.accountRef.slice(-5)}`,
        `SYNTH-NID-${d.accountRef.slice(-5)}`,
        d.balancePoisha,
        d.priorityClass === 'PROTECTED' ? 'Savings' : 'Term deposit',
        '2025-06-01',
      ],
    );
  }
  console.log(`  deposit accounts   ${seed.depositors.length}`);

  // ── the CL-1 return, with omissions ─────────────────────────────────────
  //
  // Rank by rescheduling activity, then leave the worst few OFF the return.
  // Every remaining row is accurate. Nothing filed is false.
  const ranked = [...seed.loans]
    .filter((l) => l.rsSequence > 0)
    .sort((a, b) => b.rsSequence - a.rsSequence || b.outstanding - a.outstanding);
  const omitted = new Set(ranked.slice(0, OMISSIONS).map((l) => l.commitmentId));

  let filed = 0;
  for (const loan of seed.loans) {
    if (omitted.has(loan.commitmentId)) continue;
    await client.query(
      `INSERT INTO cbs.cl1_filing
         (institution_msp, reference_date, loan_account_no, reported_classification, reported_outstanding_poisha)
       VALUES ($1,$2,$3,$4,$5)`,
      [loan.institutionMsp, REFERENCE_DATE, loan.commitmentId, loan.currentTier, String(loan.outstanding)],
    );
    filed++;
  }

  await client.query('COMMIT');

  console.log(`  CL-1 filed         ${filed} exposures for ${REFERENCE_DATE}`);
  console.log(`  ${C.amber}CL-1 omitted       ${omitted.size}${C.off}  ${C.dim}${[...omitted].join(', ')}${C.off}`);
  console.log(
    `\n  ${C.dim}Every row filed is accurate. The return is not false — it is incomplete,\n` +
      `  and nothing in the return itself reveals that. Reconciliation against the\n` +
      `  ledger is what surfaces it (§3.7.1).${C.off}\n`,
  );
} catch (error) {
  await client.query('ROLLBACK');
  console.error(`\n  failed: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
