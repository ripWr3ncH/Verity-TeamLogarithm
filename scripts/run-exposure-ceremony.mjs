#!/usr/bin/env node
/**
 * VERITY — Module II end to end. ACT 3b.
 *
 * Whitepaper §3.7.2, including its correction:
 *
 *   "Paillier provides addition only. COMPARISON IS NOT A NATIVE HOMOMORPHIC
 *    OPERATION, so it cannot be performed on the ciphertext. Verity therefore
 *    decrypts each group total X_g to Bangladesh Bank, in a ceremony that needs
 *    the supervisor plus a quorum of independent participants, and then
 *    compares X_g > θ·C_system in the clear."
 *
 * The flow, and every step is real:
 *
 *   1. Bangladesh Bank opens a period by publishing the Paillier public key
 *   2. Each bank encrypts its own exposure to borrower group G-0447 and submits
 *   3. Chaincode multiplies the ciphertexts — ON-LEDGER, deterministic, and
 *      nothing is decrypted
 *   4. The ceremony reconstructs the key from the supervisor's share PLUS a
 *      quorum of independent shares, and opens ONLY the aggregate
 *   5. Chaincode VERIFIES the announced total against the ciphertext it holds,
 *      then compares in the clear
 *
 * §1.1 is the problem this answers: "Every exposure limit is computed inside
 * one bank. A group borrowing through nominees across many banks may sit below
 * all of them."
 *
 *   node scripts/run-exposure-ceremony.mjs
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const paillier = require('../packages/crypto/dist/src/paillier.js');
const ceremony = require('../packages/crypto/dist/src/ceremony.js');

const API = process.env.VERITY_API ?? 'http://127.0.0.1:4000';
const PERIOD = process.env.VERITY_PERIOD ?? '2027-Q1';
const GROUP = 'G-0447';

/** §5.2 — Tk 18,24,668 crore outstanding across the system, in crore. */
const SYSTEM_CAPITAL = '2500';
const THETA = 0.25; // single-borrower limit, 25% of capital (BRPD 02/2014)

/**
 * The nominee structure from §1.1: comfortably inside every single-bank limit,
 * over the line once summed. 25% of Tk 2,500 crore is 625 — no leg breaches it.
 */
const EXPOSURES = [
  { identity: 'officer-rahim', bank: 'BankAMSP', crore: 520n },
  { identity: 'officer-shirin', bank: 'BankBMSP', crore: 430n },
];

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

// ==========================================================================

console.log(`\n${C.bold}  Module II — cross-bank exposure to ${GROUP}${C.off}`);
console.log(`  ${C.dim}period ${PERIOD} · all data synthetic${C.off}\n`);

// ── 1 ──────────────────────────────────────────────────────────────────────
console.log('  1. Bangladesh Bank opens the period');
// 1024-bit in this build. Say the size out loud; production uses 3072+.
const keys = paillier.generateKeys(1024);
const material = ceremony.splitDecryptionKey(keys.privateKey, 2, [
  'BIBM',
  'FRC',
  'Academic independent',
]);
console.log(`     Paillier ${keys.publicKey.bits}-bit; private key split`);
console.log(`     ${C.dim}supervisor share + 2 of 3 independent holders required${C.off}`);

let r = await call('/exposure/key', 'supervisor-1', 'POST', {
  period: PERIOD,
  publicKey: keys.publicKey,
});
if (r.status >= 400) fail('publishing the aggregation key', r);
console.log(`     ${C.green}published${C.off} at block ${r.body.receipt.blockNumber}\n`);

// ── 2 ──────────────────────────────────────────────────────────────────────
console.log('  2. Each bank encrypts its OWN exposure and submits');
for (const e of EXPOSURES) {
  const ciphertext = paillier.encrypt(keys.publicKey, e.crore);
  r = await call('/exposure/submissions', e.identity, 'POST', {
    period: PERIOD,
    groupToken: GROUP,
    ciphertext,
  });
  if (r.status >= 400) fail(`submission from ${e.bank}`, r);
  console.log(
    `     ${e.bank.replace('MSP', '').padEnd(6)} Tk ${String(e.crore).padStart(4)} crore  →  ` +
      `ciphertext ${ciphertext.length} digits, block ${r.body.receipt.blockNumber}`,
  );
}
console.log(`     ${C.dim}each leg is below 25% of Tk ${SYSTEM_CAPITAL} crore capital — none breaches its own limit${C.off}\n`);

// ── 3 ──────────────────────────────────────────────────────────────────────
console.log('  3. Chaincode aggregates — nothing is decrypted');
r = await call('/exposure/aggregate', 'supervisor-1', 'POST', {
  period: PERIOD,
  groupToken: GROUP,
  minContributors: 2,
});
if (r.status >= 400) fail('aggregation', r);
console.log(
  `     ∏ Enc(x) mod n²  over ${r.body.result.contributorCount} institutions, ` +
    `block ${r.body.receipt.blockNumber}`,
);
console.log(`     ${C.dim}deterministic, so every endorsing peer recomputed the same product${C.off}\n`);

// ── 4 ──────────────────────────────────────────────────────────────────────
console.log('  4. Threshold decryption ceremony');

// The supervisor alone cannot open it. Show that, do not just claim it.
try {
  ceremony.runCeremony(material, material.supervisorShare, [], '1');
  console.log('     ⚠ supervisor decrypted alone — THIS SHOULD NOT HAPPEN');
} catch (e) {
  console.log(`     ${C.amber}supervisor alone:${C.off} ${e.message.split(':')[0]}`);
}
try {
  ceremony.runCeremony(material, undefined, material.independentShares, '1');
  console.log('     ⚠ independents decrypted without the supervisor — THIS SHOULD NOT HAPPEN');
} catch (e) {
  console.log(`     ${C.amber}all three independents, no supervisor:${C.off} ${e.message.split(':')[0]}`);
}

// Open the ciphertext the LEDGER holds, never a locally recomputed one.
//
// Paillier encryption is randomised: re-encrypting the same exposures produces
// a different ciphertext, and a proof over it is refused on-chain with
// DECRYPTION_PROOF_INVALID. That refusal is the integrity check doing its job —
// this fetch is how an honest ceremony avoids tripping it.
const committed = await call(`/exposure/aggregate/${PERIOD}/${GROUP}`, 'supervisor-1');
if (committed.status >= 400) fail('fetching the committed aggregate', committed);

const opened = ceremony.runCeremony(
  material,
  material.supervisorShare,
  material.independentShares.slice(0, 2),
  committed.body.ciphertext,
);
console.log(`     ${C.green}opened${C.off} with ${opened.participants.join(' + ')}`);
console.log(`     total Tk ${opened.plaintext} crore`);
console.log(`     ${C.dim}no bank's individual position was ever decrypted${C.off}\n`);

// ── 5 ──────────────────────────────────────────────────────────────────────
console.log('  5. Chaincode checks the proof, then compares IN THE CLEAR');
r = await call('/exposure/ceremony', 'supervisor-1', 'POST', {
  period: PERIOD,
  groupToken: GROUP,
  total: opened.plaintext,
  randomness: opened.randomness,
  participants: opened.participants,
  thetaScaledBy10k: Math.round(THETA * 10_000),
  systemCapital: SYSTEM_CAPITAL,
});
if (r.status >= 400) fail('recording the ceremony', r);

const record = r.body.result;
console.log(`     proof verified on-chain: ${record.proofVerified}`);
console.log(`     Tk ${record.total} crore  vs  θ·C_system = Tk ${record.threshold} crore`);
console.log(
  `\n  ${record.alert ? C.amber + '  ALERT' : C.green + '  no alert'}${C.off} — ` +
    `${GROUP} ${record.alert ? 'exceeds' : 'is within'} the system-wide limit ` +
    `while sitting below every single-bank limit\n`,
);
