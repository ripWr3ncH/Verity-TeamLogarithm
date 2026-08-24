#!/usr/bin/env node
/**
 * VERITY — register the Board.
 *
 * Whitepaper §3.7.1:
 *   "Board authorisation is a k-of-n threshold signature over the event hash
 *    from registered director credentials, validated by chaincode against the
 *    registered director set for that institution AT THAT BLOCK HEIGHT."
 *
 * Until this has run, every Board-level event is refused with
 * DIRECTOR_NOT_REGISTERED — correctly, because the registered set is empty.
 * That refusal is the control working; it is not a setup you can skip.
 *
 * Generates n ed25519 keypairs, registers the PUBLIC keys on the ledger under
 * the institution's MSP, and writes the private keys to a gitignored wallet
 * that the ceremony endpoint reads.
 *
 * ── HONEST BOUNDARY ──────────────────────────────────────────────────────
 * In this build the director keys live in a file and the API signs on their
 * behalf, so the threshold can be demonstrated by one person. In production
 * each director holds their own key in an HSM (§4.3) and signs on their own
 * device. Say that plainly if asked; the k-of-n verification in chaincode is
 * identical either way, and it is the part that matters.
 *
 *   node scripts/register-directors.mjs
 */

import { generateKeyPairSync, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const API = process.env.VERITY_API ?? 'http://127.0.0.1:4000';
const WALLET = resolve('network/organizations/directors.json');

/**
 * An org admin or MD/CEO registers directors — see LifecycleContract.
 *
 * The registry is PER INSTITUTION: chaincode validates a threshold against the
 * director set of the bank that holds the exposure. BankB needs its own Board,
 * or every BankB event at RS-3 is refused with DIRECTOR_NOT_REGISTERED —
 * correctly, and confusingly if you forgot this step.
 */
const BOARDS = [
  { registrar: 'md-banka', prefix: 'banka', directors: ['director-1', 'director-2', 'director-3'] },
  { registrar: 'md-bankb', prefix: 'bankb', directors: ['bankb-director-1', 'bankb-director-2', 'bankb-director-3'] },
];

const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

async function call(path, identity, method, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Verity-Identity': identity },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

const wallet = {};

for (const board of BOARDS) {
  process.stdout.write(`\n  ${board.prefix} — registrar ${board.registrar}\n`);

  for (const name of board.directors) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    const publicKeyB64 = spki.toString('base64');

    // keyId is SHA-256 of the public key, exactly as domain/hash.ts derives it.
    const keyId = sha256Hex(spki);

    const result = await call('/board/register', board.registrar, 'POST', {
      keyId,
      publicKey: publicKeyB64,
      name,
    });

    if (result.status >= 400) {
      process.stderr.write(`  FAILED ${name}: ${result.body?.message ?? result.body?.error}\n`);
      process.exit(1);
    }

    // The supervisor confirms. A bank cannot constitute its own Board, so this
    // call runs as supervisor-1 and would be refused as anyone else.
    const confirmed = await call('/board/confirm', SUPERVISOR, 'POST', {
      mspId: board.msp,
      keyId,
    });

    if (confirmed.status >= 400) {
      process.stderr.write(
        `  FAILED to confirm ${name}: ${confirmed.body?.message ?? confirmed.body?.error}
`,
      );
      process.exit(1);
    }

    wallet[name] = {
      keyId,
      publicKey: publicKeyB64,
      privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      institution: board.prefix,
    };
    process.stdout.write(`    ${name}  keyId ${keyId.slice(0, 16)}…  registered + confirmed\n`);
  }
}

mkdirSync(dirname(WALLET), { recursive: true });
writeFileSync(WALLET, JSON.stringify(wallet, null, 2));

process.stdout.write(
  [
    '',
    `  wallet: ${WALLET}`,
    '  (gitignored — regenerate with this script after any network rebuild)',
    '',
    '  A Board-level event now needs k of these to sign the event hash.',
    '  Fewer than k, or a signer outside this set, and chaincode refuses.',
    '',
  ].join('\n'),
);
