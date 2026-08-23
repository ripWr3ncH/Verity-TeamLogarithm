#!/usr/bin/env node
/**
 * VERITY — load the synthetic portfolio onto the ledger.
 *
 * Without this the supervisor's queue holds only whatever was created during
 * testing, and Act 2's "ranked for attention" screen ranks four rows. The
 * base-rate histogram — the honest answer to "won't this flag every bank at
 * quarter-end?" — needs a population to be a histogram of.
 *
 * ── CONCURRENCY, AND THE ONE CONSTRAINT ──────────────────────────────────
 *
 * Events within a loan are STRICTLY SEQUENTIAL: each carries the prior-state
 * hash of the one before it, so two in flight at once means the second is
 * refused with STATE_DIVERGENCE. Loans are independent of each other, so the
 * parallelism goes ACROSS loans and never within one.
 *
 * Fabric batches at 10 messages or 2 seconds (configtx BatchSize), so a
 * concurrency in the low tens keeps blocks full without swamping a laptop
 * running seventeen containers.
 *
 *   node scripts/seed-ledger.mjs                 # everything
 *   node scripts/seed-ledger.mjs --limit=150     # a smaller run
 *   node scripts/seed-ledger.mjs --concurrency=8
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const API = process.env.VERITY_API ?? 'http://127.0.0.1:4000';
const ZERO = '0'.repeat(64);

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);
const LIMIT = Number(args.get('limit') ?? Infinity);
const CONCURRENCY = Number(args.get('concurrency') ?? 12);

// --------------------------------------------------------------------------
//  Must match chaincode/commitment/src/domain/hash.ts exactly.
// --------------------------------------------------------------------------
const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');
const canon = (v) =>
  v === null || typeof v !== 'object'
    ? JSON.stringify(v) ?? 'null'
    : Array.isArray(v)
      ? `[${v.map(canon).join(',')}]`
      : `{${Object.entries(v)
          .filter(([, x]) => x !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => `${JSON.stringify(k)}:${canon(x)}`)
          .join(',')}}`;

const REF = [[3, 31], [6, 30], [9, 30], [12, 31]];
function refDate(iso) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const c = [];
  for (const yr of [y, y + 1]) for (const [mm, dd] of REF) c.push(Date.UTC(yr, mm - 1, dd));
  const next = c.filter((x) => x >= t).sort((a, b) => a - b)[0];
  return { ref: new Date(next).toISOString().slice(0, 10), days: Math.round((next - t) / 86_400_000) };
}

// --------------------------------------------------------------------------

const IDENTITIES = {
  BankAMSP: { originate: 'officer-rahim', approve: 'officer-nasrin', assigning: 'officer-rahim', reviewing: 'officer-nasrin' },
  BankBMSP: { originate: 'officer-shirin', approve: 'officer-tanvir', assigning: 'officer-shirin', reviewing: 'officer-tanvir' },
};
const BOARD = {
  BankAMSP: ['director-1', 'director-2', 'director-3'],
  BankBMSP: ['bankb-director-1', 'bankb-director-2', 'bankb-director-3'],
};

async function call(path, identity, method = 'GET', body) {
  const r = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Verity-Identity': identity },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : undefined };
}

const stats = { loans: 0, events: 0, refused: 0, failed: 0, byCode: {} };
const note = (code) => {
  stats.byCode[code] = (stats.byCode[code] ?? 0) + 1;
};

/** Load one loan and its whole event trail, strictly in order. */
async function loadLoan(seed) {
  const ids = IDENTITIES[seed.institutionMsp];
  if (!ids) return;

  const origination = await call('/loans', ids.originate, 'POST', {
    commitmentId: seed.commitmentId,
    initialTier: seed.initialTier,
    outstandingBand: seed.outstandingBand,
    groupToken: seed.groupToken,
    payloadHash: ZERO,
    originationDate: seed.originationDate,
  });

  if (origination.status >= 400) {
    if (origination.body?.refused) {
      stats.refused++;
      note(origination.body.code);
    } else {
      stats.failed++;
    }
    return;
  }
  stats.loans++;

  // Read back the committed head. Each event needs the one before it.
  let loan = (await call(`/loans/${seed.commitmentId}`, ids.originate)).body;
  if (!loan?.prevStateHash) return;

  for (const event of seed.events) {
    const { ref, days } = refDate(event.eventDate);
    const rsSeq = event.type === 'RESCHEDULE' ? loan.rsSequence + 1 : loan.rsSequence;

    const evHash = sha256Hex(
      canon({
        commitmentId: loan.commitmentId,
        seq: loan.eventCount,
        type: event.type,
        classificationRefDate: ref,
        daysToNextRefDate: days,
        rsSeq,
        tierBefore: loan.currentTier,
        tierAfter: event.tierAfter,
        prevStateHash: loan.prevStateHash,
        payloadHash: ZERO,
      }),
    );
    const stamp = `sig:${evHash.slice(0, 8)}`;

    // RS-3 and RS-4 are Board matters; everything else is one level above.
    let evidence = { kind: 'ONE_LEVEL_ABOVE' };
    if (event.type === 'RESCHEDULE' && rsSeq >= 3) {
      const signed = await call('/board/sign', ids.approve, 'POST', {
        eventHash: evHash,
        signers: BOARD[seed.institutionMsp],
      });
      evidence = { kind: 'BOARD_THRESHOLD', ...(signed.body ?? {}) };
    } else if (event.type === 'RECLASSIFY_DOWN' || event.type === 'RECOVERY') {
      evidence = { kind: 'MECHANICAL' };
    }

    const result = await call('/events', ids.approve, 'POST', {
      commitmentId: loan.commitmentId,
      eventType: event.type,
      tierAfter: event.tierAfter,
      eventDate: event.eventDate,
      prevStateHash: loan.prevStateHash,
      payloadHash: ZERO,
      signatures: {
        assigning: { officerId: ids.assigning, signature: stamp },
        reviewing: { officerId: ids.reviewing, signature: stamp },
      },
      authorityEvidence: evidence,
      note: '',
    });

    if (result.status >= 400) {
      if (result.body?.refused) {
        stats.refused++;
        note(result.body.code);
      } else {
        stats.failed++;
      }
      break; // the chain is broken for this loan; move on
    }

    stats.events++;
    loan = (await call(`/loans/${loan.commitmentId}`, ids.originate)).body;
    if (!loan?.prevStateHash) break;
  }
}

/** Run `workers` loans at a time. Never two events of the same loan at once. */
async function pool(items, workers, fn) {
  let index = 0;
  const runners = Array.from({ length: workers }, async () => {
    for (;;) {
      const i = index++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  });
  await Promise.all(runners);
}

// --------------------------------------------------------------------------

const data = JSON.parse(readFileSync('seed/out/seed.json', 'utf8'));
const loans = data.loans.slice(0, LIMIT);

process.stdout.write(
  `\n  loading ${loans.length} synthetic exposures at concurrency ${CONCURRENCY}\n` +
    '  all data synthetic — no real borrower or institution appears\n\n',
);

const started = Date.now();
let done = 0;

await pool(loans, CONCURRENCY, async (loan) => {
  await loadLoan(loan);
  done++;
  if (done % 25 === 0 || done === loans.length) {
    const secs = (Date.now() - started) / 1000;
    process.stdout.write(
      `  ${String(done).padStart(4)}/${loans.length}  ` +
        `${stats.loans} loans · ${stats.events} events · ` +
        `${((stats.loans + stats.events) / secs).toFixed(1)} tx/s\n`,
    );
  }
});

const secs = (Date.now() - started) / 1000;
process.stdout.write(
  [
    '',
    `  committed   ${stats.loans} loans, ${stats.events} events`,
    `  elapsed     ${secs.toFixed(1)}s  (${((stats.loans + stats.events) / secs).toFixed(1)} tx/s sustained)`,
    `  refused     ${stats.refused}`,
    `  failed      ${stats.failed}`,
    '',
  ].join('\n'),
);

if (Object.keys(stats.byCode).length > 0) {
  process.stdout.write('  refusals by code — each one is a rule doing its job:\n');
  for (const [code, n] of Object.entries(stats.byCode).sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`    ${String(n).padStart(4)}  ${code}\n`);
  }
  process.stdout.write('\n');
}
