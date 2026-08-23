#!/usr/bin/env node
/**
 * VERITY — Modules III and IV end to end. ACT 4.
 *
 * §3.7.3: "We adopt the SIGNED-LEAF principle of [24] — a depositor balance
 * enters the commitment only if the depositor has signed it — and combine it
 * with a Merkle sum tree for O(log n) inclusion proofs."
 *
 * §3.7.4: "Each verified claim is issued as a non-fungible token bound to the
 * depositor's signed leaf […] the tokenised asset is an existing legal claim on
 * a resolution estate, not an invented utility token."
 *
 * What this does:
 *   1. Depositors sign their own balances (ed25519, one key each)
 *   2. Unsigned and negative leaves are TURNED AWAY, and the count of refusals
 *      is committed alongside the root — a bank cannot quietly exclude the
 *      depositors it finds inconvenient
 *   3. The root and committed sum go on the ledger; individual balances do not
 *   4. A claim token is issued against one depositor's leaf
 *   5. That depositor's inclusion proof is verified AGAINST THE COMMITTED ROOT
 *
 *   node scripts/run-liability-commitment.mjs
 */

import { generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const merkle = require('../packages/crypto/dist/src/merkle-sum.js');

const API = process.env.VERITY_API ?? 'http://127.0.0.1:4000';
const PERIOD = process.env.VERITY_PERIOD ?? '2027-03-31';
const INSTITUTION = 'BankAMSP';

const C = { dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', amber: '\x1b[33m', off: '\x1b[0m' };

async function call(path, identity, method = 'GET', body) {
  const r = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Verity-Identity': identity },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : undefined };
}
const fail = (label, r) => {
  console.error(`\n  ${label} failed: ${r.body?.message ?? r.body?.error ?? r.status}`);
  process.exit(1);
};

const verify = (pk, digestHex, sig) => {
  try {
    return edVerify(
      null,
      Buffer.from(digestHex, 'utf8'),
      { key: Buffer.from(pk, 'base64'), format: 'der', type: 'spki' },
      Buffer.from(sig, 'base64'),
    );
  } catch {
    return false;
  }
};

// ==========================================================================

console.log(`\n${C.bold}  Modules III & IV — depositor liabilities and claims${C.off}`);
console.log(`  ${C.dim}${INSTITUTION} · period ${PERIOD} · all data synthetic${C.off}\n`);

// ── 1 ──────────────────────────────────────────────────────────────────────
const seed = JSON.parse(readFileSync('seed/out/seed.json', 'utf8'));
const accounts = seed.depositors.filter((d) => d.institutionMsp === INSTITUTION).slice(0, 250);

console.log(`  1. ${accounts.length} depositors sign their own balances`);

const wallets = new Map();
const candidates = accounts.map((a) => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const depositorKey = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const balance = BigInt(a.balancePoisha);
  const digest = merkle.leafDigest(a.accountRef, balance, PERIOD);
  const signature = edSign(null, Buffer.from(digest, 'utf8'), privateKey).toString('base64');
  wallets.set(a.accountRef, { depositorKey, balance, priorityClass: a.priorityClass });
  return { accountRef: a.accountRef, balance, depositorKey, signature, period: PERIOD };
});

// ── 2 ──────────────────────────────────────────────────────────────────────
// The two halves of the collusion attack in [24], both refused at insertion.
const forged = {
  accountRef: 'acct-A-FORGED',
  balance: 99_999_999_99n,
  depositorKey: candidates[0].depositorKey,
  signature: Buffer.from('not-a-real-signature').toString('base64'),
  period: PERIOD,
};
const negative = { ...candidates[1], accountRef: 'acct-A-NEGATIVE', balance: -1n };

const { tree, rejected } = merkle.buildVerifiedTree([...candidates, forged, negative], verify);
if (!tree) fail('building the tree', { body: { error: 'every leaf was rejected' } });

console.log(`     ${C.green}${tree.size} admitted${C.off}, ${C.amber}${rejected.length} turned away${C.off}`);
for (const r of rejected) console.log(`       ${C.dim}${r.accountRef}: ${r.reason.split(':')[0]}${C.off}`);
console.log(
  `     ${C.dim}an unsigned leaf cannot be inserted by the bank, and a negative one\n` +
    `     cannot shrink apparent liabilities — [24]'s attack, closed at insertion${C.off}\n`,
);

// ── 3 ──────────────────────────────────────────────────────────────────────
console.log('  3. Commit the root — balances stay off-chain');
const totalTaka = (Number(tree.rootSum) / 100).toLocaleString('en-BD', { maximumFractionDigits: 0 });

let r = await call('/liability/roots', 'officer-rahim', 'POST', {
  period: PERIOD,
  merkleRoot: tree.root,
  committedSum: tree.rootSum.toString(),
  leafCount: tree.size,
  rejectedCount: rejected.length,
});
if (r.status >= 400) fail('committing the liability root', r);

console.log(`     root       ${tree.root.slice(0, 40)}…`);
console.log(`     committed  Tk ${totalTaka} across ${tree.size} depositors`);
console.log(`     block      ${r.body.receipt.blockNumber}`);
console.log(
  `     ${C.dim}the rejected count is committed too — a bank cannot quietly drop\n` +
    `     the depositors it finds inconvenient${C.off}\n`,
);

// ── 4 ──────────────────────────────────────────────────────────────────────
// Pick a depositor above the Tk 2 lakh protection ceiling — §3.7.4's point is
// that most ACCOUNTS are covered while most VALUE is not.
const index = candidates.findIndex((c) => wallets.get(c.accountRef).priorityClass !== 'PROTECTED');
const subjectIndex = index >= 0 ? index : 0;
const subject = candidates[subjectIndex];
const wallet = wallets.get(subject.accountRef);
const leafHash = merkle.leafHash({ accountRef: subject.accountRef, balance: subject.balance, period: PERIOD });

console.log('  4. Issue a claim token bound to that depositor’s signed leaf');
const claimId = `CLM-${PERIOD}-${subjectIndex}`;
r = await call('/claims', 'officer-rahim', 'POST', {
  claimId,
  leafHash,
  period: PERIOD,
  depositorKey: wallet.depositorKey,
  faceValue: subject.balance.toString(),
  priorityClass: wallet.priorityClass,
  schedule: 'Payout within 17 working days of a resolution event (Deposit Protection Act, 2026)',
});
if (r.status >= 400) fail('issuing the claim', r);
console.log(`     ${claimId}  Tk ${(Number(subject.balance) / 100).toLocaleString('en-BD')}  ${wallet.priorityClass}`);
console.log(`     block ${r.body.receipt.blockNumber}`);
console.log(`     ${C.dim}no transfer function exists — §7.4 #9 asserts no legal authority for one${C.off}\n`);

// ── 5 ──────────────────────────────────────────────────────────────────────
console.log('  5. Verify inclusion against the COMMITTED root');
const proof = tree.prove(subjectIndex);
r = await call('/liability/verify', 'supervisor-1', 'POST', {
  institutionMsp: INSTITUTION,
  period: PERIOD,
  proof,
});
if (r.status >= 400) fail('verifying inclusion', r);

console.log(`     verified   ${r.body.verified ? C.green + 'yes' + C.off : C.amber + 'NO' + C.off}`);
console.log(`     path       ${proof.path.length} steps for ${tree.size} leaves`);

// A tampered balance must fail, or the proof proves nothing.
const tampered = await call('/liability/verify', 'supervisor-1', 'POST', {
  institutionMsp: INSTITUTION,
  period: PERIOD,
  proof: { ...proof, leafSum: '999999999999' },
});
console.log(`     tampered   ${tampered.body?.verified === false ? C.green + 'refused' + C.off : C.amber + 'ACCEPTED — BUG' + C.off}`);

// Hand the depositor portal something real to read.
mkdirSync('seed/out', { recursive: true });
writeFileSync(
  'seed/out/depositor.json',
  JSON.stringify(
    {
      institutionMsp: INSTITUTION,
      period: PERIOD,
      accountRef: subject.accountRef,
      balancePoisha: subject.balance.toString(),
      priorityClass: wallet.priorityClass,
      depositorKey: wallet.depositorKey,
      claimId,
      merkleRoot: tree.root,
      committedSum: tree.rootSum.toString(),
      leafCount: tree.size,
      proof,
      synthetic: true,
    },
    null,
    1,
  ),
);
console.log(`\n  ${C.dim}wrote seed/out/depositor.json for the depositor portal${C.off}\n`);
