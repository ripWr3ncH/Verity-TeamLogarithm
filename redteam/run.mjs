#!/usr/bin/env node
/**
 * VERITY — the red-team suite.
 *
 * Eight attacks, eight expected refusals. Runnable in front of judges.
 *
 * Offering to attack your own system is a strong move: it converts the Privacy
 * and Governance criteria from claims into demonstrations, and every message
 * below is one the contract wrote, not one this script invented.
 *
 * A refusal here is a PASS. The suite fails when an attack SUCCEEDS.
 *
 *   node redteam/run.mjs
 *   node redteam/run.mjs --only=5
 */

import { createHash } from 'node:crypto';

const API = process.env.VERITY_API ?? 'http://127.0.0.1:4000';
const Z = '0'.repeat(64);
const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1];

const C = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', bold: '\x1b[1m', off: '\x1b[0m' };

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
  const n = c.filter((x) => x >= t).sort((a, b) => a - b)[0];
  return { ref: new Date(n).toISOString().slice(0, 10), days: Math.round((n - t) / 86_400_000) };
}

async function call(path, identity, method = 'GET', body) {
  const r = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Verity-Identity': identity },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : undefined };
}

const wait = async (id) => {
  for (let i = 0; i < 30; i++) {
    const r = await call(`/loans/${id}`, 'supervisor-1');
    if (r.status === 200) return r.body;
    await new Promise((s) => setTimeout(s, 2000));
  }
  throw new Error(`${id} never committed`);
};

/** Build an AppendEvent body with signatures that bind to THIS event. */
async function eventBody(loan, over = {}) {
  const date = over.eventDate ?? '2027-06-18';
  const { ref, days } = refDate(date);
  const type = over.eventType ?? 'RESCHEDULE';
  const rsSeq = type === 'RESCHEDULE' ? loan.rsSequence + 1 : loan.rsSequence;
  const prevStateHash = over.prevStateHash ?? loan.prevStateHash;

  const evHash = sha256Hex(
    canon({
      commitmentId: loan.commitmentId,
      seq: loan.eventCount,
      type,
      classificationRefDate: ref,
      daysToNextRefDate: days,
      rsSeq,
      tierBefore: loan.currentTier,
      tierAfter: over.tierAfter ?? 'STANDARD',
      prevStateHash: loan.prevStateHash,
      payloadHash: Z,
    }),
  );
  const stamp = `sig:${evHash.slice(0, 8)}`;

  return {
    evHash,
    body: {
      commitmentId: loan.commitmentId,
      eventType: type,
      tierAfter: over.tierAfter ?? 'STANDARD',
      eventDate: date,
      prevStateHash,
      payloadHash: Z,
      signatures: {
        assigning: { officerId: 'officer-rahim', signature: stamp },
        reviewing: { officerId: 'officer-nasrin', signature: stamp },
      },
      authorityEvidence: over.authorityEvidence ?? { kind: 'ONE_LEVEL_ABOVE' },
      note: '',
    },
  };
}

// --------------------------------------------------------------------------

const results = [];
const record = (n, name, expected, got, detail) => {
  const pass = got === expected;
  results.push({ n, name, expected, got, pass, detail });
  const mark = pass ? `${C.green}PASS${C.off}` : `${C.red}FAIL${C.off}`;
  console.log(`  ${mark}  ${String(n).padStart(2)}. ${name}`);
  console.log(`        expected ${expected}`);
  console.log(`        got      ${got}`);
  if (detail) console.log(`        ${C.dim}${detail}${C.off}`);
  console.log();
};

const want = (n, name, expected, result) => {
  const code = result.body?.refused ? result.body.code : result.status < 400 ? 'ACCEPTED' : 'ERROR';
  record(n, name, expected, code, result.body?.message?.slice(0, 140));
};

// --------------------------------------------------------------------------

console.log(`\n${C.bold}  VERITY — red team${C.off}`);
console.log(`  ${C.dim}A refusal is a PASS. The suite fails when an attack succeeds.${C.off}\n`);

// Fresh subject exposure.
const LOAN = `BD-RT-${Math.floor(Math.random() * 99999)}`;
await call('/loans', 'officer-rahim', 'POST', {
  commitmentId: LOAN,
  initialTier: 'STANDARD',
  outstandingBand: 'Tk 100-150 crore',
  groupToken: 'G-0447',
  payloadHash: Z,
  originationDate: '2027-01-15',
});
let loan = await wait(LOAN);
console.log(`  ${C.dim}subject: ${LOAN}${C.off}\n`);

const run = (n) => !only || Number(only) === n;

// ── 1 ──────────────────────────────────────────────────────────────────────
if (run(1)) {
  // Push to RS-2 first so the next reschedule is a Board matter.
  for (let i = 0; i < 2; i++) {
    const { body } = await eventBody(loan, { eventDate: i ? '2027-12-20' : '2027-06-18' });
    await call('/events', 'officer-nasrin', 'POST', body);
    loan = await wait(LOAN);
  }
  const { body } = await eventBody(loan, {
    eventDate: '2028-09-15',
    authorityEvidence: { kind: 'BOARD_THRESHOLD', directorSignatures: [] },
  });
  want(1, 'RS-3 reschedule with no Board signatures', 'BOARD_AUTHORISATION_REQUIRED',
    await call('/events', 'officer-nasrin', 'POST', body));
}

// ── 2 ──────────────────────────────────────────────────────────────────────
if (run(2)) {
  // officer-farhana is ALSO seniority 2 — the same rank as the sanctioning
  // officer who originated. Deliberately NOT officer-kamal: he is the standing
  // subject of the revocation demo, and once revoked he fails this for the
  // wrong reason.
  const fresh = `BD-RT2-${Math.floor(Math.random() * 99999)}`;
  await call('/loans', 'officer-rahim', 'POST', {
    commitmentId: fresh, initialTier: 'STANDARD', outstandingBand: 'Tk 10-50 crore',
    groupToken: 'G-0447', payloadHash: Z, originationDate: '2027-01-15',
  });
  const l2 = await wait(fresh);
  const { body } = await eventBody(l2);
  want(2, 'Approval by an officer of EQUAL seniority', 'AUTHORITY_INSUFFICIENT',
    await call('/events', 'officer-farhana', 'POST', body));
}

// ── 3 ──────────────────────────────────────────────────────────────────────
if (run(3)) {
  const { body } = await eventBody(loan, {
    eventDate: '2028-09-15',
    authorityEvidence: {
      kind: 'BOARD_THRESHOLD',
      directorSignatures: [
        { keyId: 'f'.repeat(64), signature: 'AAAA' },
        { keyId: 'e'.repeat(64), signature: 'AAAA' },
        { keyId: 'd'.repeat(64), signature: 'AAAA' },
      ],
    },
  });
  want(3, 'Board signature from outside the registered set', 'DIRECTOR_NOT_REGISTERED',
    await call('/events', 'officer-nasrin', 'POST', body));
}

// ── 4 ──────────────────────────────────────────────────────────────────────
if (run(4)) {
  const r = await call(`/loans/${LOAN}/payload/1`, 'officer-shirin');
  const authorised = r.body?.authorised;
  record(4, 'Competing bank reads a private payload',
    'authorised=false',
    `authorised=${authorised}`,
    r.body?.reason?.slice(0, 120) ?? `collection ${r.body?.collection}`);
}

// ── 5 ──────────────────────────────────────────────────────────────────────
if (run(5)) {
  // No update path exists; the transaction is there only to refuse legibly.
  const r = await fetch(`${API}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Verity-Identity': 'officer-nasrin' },
    body: JSON.stringify({ commitmentId: LOAN, eventType: 'BOGUS_MUTATE', tierAfter: 'STANDARD',
      eventDate: '2027-06-18', prevStateHash: loan.prevStateHash, payloadHash: Z,
      signatures: {}, authorityEvidence: {} }),
  });
  const b = await r.json().catch(() => undefined);
  record(5, 'Unknown event type (a mutation by another name)',
    'INVALID_EVENT_TYPE', b?.refused ? b.code : r.status < 400 ? 'ACCEPTED' : 'ERROR',
    b?.message?.slice(0, 140));
}

// ── 6 ──────────────────────────────────────────────────────────────────────
if (run(6)) {
  const { body } = await eventBody(loan, { prevStateHash: 'deadbeef'.repeat(8) });
  want(6, 'Event carrying a STALE prior-state hash', 'STATE_DIVERGENCE',
    await call('/events', 'officer-nasrin', 'POST', body));
}

// ── 7 ──────────────────────────────────────────────────────────────────────
if (run(7)) {
  const pid = `rt-${Math.floor(Math.random() * 99999)}`;
  await call('/governance/proposals', 'officer-rahim', 'POST', {
    proposalId: pid, parameter: 'eStar', proposedValue: 9.9,
    rationale: 'the bank would prefer fewer alerts',
  });
  await new Promise((s) => setTimeout(s, 4000));
  want(7, 'One bank raising its OWN alert threshold', 'GOVERNANCE_QUORUM_REQUIRED',
    await call(`/governance/proposals/${pid}/activate`, 'officer-rahim', 'POST'));
}

// ── 8 ──────────────────────────────────────────────────────────────────────
if (run(8)) {
  // Requires `bash redteam/revoke.sh` to have run against this network:
  // it revokes officer-kamal at the CA and writes the CRL into BankAMSP's MSP
  // through a channel config update. Without that this attack cannot fire, and
  // saying so is better than quietly testing something weaker.
  const probe = await call('/loans', 'officer-kamal', 'POST', {
    commitmentId: `BD-RT8-${Math.floor(Math.random() * 99999)}`,
    initialTier: 'STANDARD',
    outstandingBand: 'Tk 1-10 crore',
    groupToken: 'G-0447',
    payloadHash: Z,
    originationDate: '2027-02-01',
  });
  const code = probe.body?.refused ? probe.body.code : probe.status < 400 ? 'ACCEPTED' : 'ERROR';
  record(8, 'Revoked certificate signs a new event', 'IDENTITY_NOT_VALID', code,
    probe.body?.message?.slice(0, 150));

  if (code === 'ACCEPTED') {
    console.log(`  ${C.dim}  officer-kamal has not been revoked on this network.`);
    console.log(`        Run: bash redteam/revoke.sh${C.off}\n`);
  } else if (code === 'IDENTITY_NOT_VALID') {
    // The other half of §4.4, and the half people forget to check.
    const earlier = await call(`/loans/${LOAN}`, 'supervisor-1');
    console.log(
      `  ${C.dim}  and their earlier events remain valid: ${LOAN} is still ` +
        `${earlier.status === 200 ? 'readable on the ledger' : 'UNREADABLE — investigate'}${C.off}\n`,
    );
  }
}

// --------------------------------------------------------------------------

const passed = results.filter((r) => r.pass).length;
console.log(`${C.bold}  ${passed}/${results.length} attacks refused as expected${C.off}\n`);
process.exit(passed === results.length ? 0 : 1);
