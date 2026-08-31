/**
 * VERITY — the identity wallet.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  ONE X.509 PER PERSON. NO SHARED ADMIN IDENTITY IN THE DEMO PATH.
 *
 *  Every request is signed by the credentials of the officer making it. If this
 *  service ever signed "as the bank" rather than as a named officer, three
 *  things would quietly stop being true:
 *
 *    · Act 1's refusal — the chaincode reads role and seniority from the
 *      CALLER'S CERTIFICATE. A shared identity has no officer to refuse.
 *    · Act 3a's two-identity comparison — the whole point is that the same
 *      query returns a payload to one certificate and a hash to another.
 *    · Red-team #8 — revoking one officer must break their next write while
 *      leaving their earlier events valid.
 *
 *  If you are tempted to add a service account "just for the seed script",
 *  give the seed script its own registered adapter identity instead. There is
 *  one: `adapter-banka`, role=adapter, seniority=1.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { createPrivateKey, createPublicKey } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

export interface OrgProfile {
  mspId: string;
  domain: string;
  /** Host:port the gateway dials. */
  peerEndpoint: string;
  /** Must match the peer certificate's CN, or TLS fails with a name mismatch. */
  peerHostAlias: string;
}

export const ORGS: Record<string, OrgProfile> = {
  banka: {
    mspId: 'BankAMSP',
    domain: 'banka.verity.bd',
    peerEndpoint: 'localhost:9051',
    peerHostAlias: 'peer0.banka.verity.bd',
  },
  bankb: {
    mspId: 'BankBMSP',
    domain: 'bankb.verity.bd',
    peerEndpoint: 'localhost:9061',
    peerHostAlias: 'peer0.bankb.verity.bd',
  },
  bb: {
    mspId: 'BangladeshBankMSP',
    domain: 'bb.verity.bd',
    peerEndpoint: 'localhost:9071',
    peerHostAlias: 'peer0.bb.verity.bd',
  },
  frc: {
    mspId: 'FRCMSP',
    domain: 'frc.verity.bd',
    peerEndpoint: 'localhost:9081',
    peerHostAlias: 'peer0.frc.verity.bd',
  },
};

export interface DemoUser {
  id: string;
  org: keyof typeof ORGS;
  role: string;
  seniority: number;
  displayName: string;
  /** Shown in the portal's identity switcher so the demo driver never guesses. */
  portal: 'bank' | 'supervisor' | 'depositor' | 'none';
}

/**
 * Mirrors network/scripts/enroll-users.sh. Keep the two in step — this list is
 * only a directory; the ATTRIBUTES that matter live in the certificates.
 */
export const DEMO_USERS: DemoUser[] = [
  { id: 'officer-rahim', org: 'banka', role: 'sanctioning_officer', seniority: 2, displayName: 'Rahim Uddin', portal: 'bank' },
  { id: 'officer-nasrin', org: 'banka', role: 'reviewing_officer', seniority: 3, displayName: 'Nasrin Akhter', portal: 'bank' },
  { id: 'officer-kamal', org: 'banka', role: 'sanctioning_officer', seniority: 2, displayName: 'Kamal Hossain', portal: 'bank' },
  { id: 'officer-farhana', org: 'banka', role: 'sanctioning_officer', seniority: 2, displayName: 'Farhana Islam', portal: 'bank' },
  { id: 'md-banka', org: 'banka', role: 'mdceo', seniority: 5, displayName: 'Managing Director', portal: 'bank' },
  { id: 'director-1', org: 'banka', role: 'director', seniority: 5, displayName: 'Director One', portal: 'bank' },
  { id: 'director-2', org: 'banka', role: 'director', seniority: 5, displayName: 'Director Two', portal: 'bank' },
  { id: 'director-3', org: 'banka', role: 'director', seniority: 5, displayName: 'Director Three', portal: 'bank' },
  { id: 'adapter-banka', org: 'banka', role: 'adapter', seniority: 1, displayName: 'CBS adapter', portal: 'none' },

  { id: 'officer-shirin', org: 'bankb', role: 'sanctioning_officer', seniority: 2, displayName: 'Shirin Sultana', portal: 'bank' },
  { id: 'officer-tanvir', org: 'bankb', role: 'reviewing_officer', seniority: 3, displayName: 'Tanvir Ahmed', portal: 'bank' },
  { id: 'md-bankb', org: 'bankb', role: 'mdceo', seniority: 5, displayName: 'Managing Director', portal: 'bank' },
  { id: 'adapter-bankb', org: 'bankb', role: 'adapter', seniority: 1, displayName: 'CBS adapter', portal: 'none' },

  // Two DIFFERENT people, each with their own certificate and private key.
  //
  // They shared a display name until a dropdown showed the same label twice,
  // which is a bad look and a worse claim: §4.7 logs every supervisory read by
  // identity, so "who opened this exposure" is a question the ledger answers
  // by name. Two indistinguishable entries in the switcher quietly undercut
  // the control the access log exists to provide.
  //
  // supervisor-2 is also the block listener's identity (VERITY_LISTENER_IDENTITY),
  // so the access log carries a human reading a file and a service following
  // the chain. Naming them apart is what makes that legible.
  { id: 'supervisor-1', org: 'bb', role: 'supervisor', seniority: 5, displayName: 'Rehana Karim', portal: 'supervisor' },
  { id: 'supervisor-2', org: 'bb', role: 'supervisor', seniority: 5, displayName: 'Imran Chowdhury', portal: 'supervisor' },

  { id: 'frc-analyst', org: 'frc', role: 'frc', seniority: 4, displayName: 'Nusrat Jahan', portal: 'supervisor' },
];

/**
 * Where to dial the peer.
 *
 * ── WHY THIS IS NOT JUST A CONSTANT ──────────────────────────────────────
 *
 * The endpoints above say `localhost`, which is correct exactly half the
 * time. compose publishes the peers on the SAME port inside and out
 * (`9051:9051`, not a translated port), so only the hostname differs:
 *
 *   run from a shell        localhost:9051               the published port
 *   run inside verity_net   peer0.banka.verity.bd:9051   Docker DNS
 *
 * A container that dials `localhost:9071` is dialling itself, and Fabric
 * reports it as `14 UNAVAILABLE ... ECONNREFUSED 127.0.0.1:9071` — which
 * reads like the peer is down when in fact it was never addressed.
 *
 * The alias is already the peer certificate's CN, so it is the right host
 * for TLS as well as for routing.
 */
export function resolvePeerEndpoint(org: OrgProfile): string {
  const port = org.peerEndpoint.split(':')[1] ?? '9051';
  return process.env['VERITY_PEER_HOST'] === 'dns'
    ? `${org.peerHostAlias}:${port}`
    : `localhost:${port}`;
}

export interface Credentials {
  mspId: string;
  certificate: Buffer;
  privateKeyPem: Buffer;
  tlsRootCert: Buffer;
  peerEndpoint: string;
  peerHostAlias: string;
}

const CRYPTO_ROOT =
  process.env['VERITY_CRYPTO_PATH'] ??
  join(process.cwd(), '..', '..', 'network', 'organizations', 'peerOrganizations');

export function loadCredentials(userId: string): Credentials {
  const user = DEMO_USERS.find((u) => u.id === userId);
  if (!user) throw new Error(`UNKNOWN_IDENTITY: no enrolled identity '${userId}'`);

  const org = ORGS[user.org]!;
  const userMsp = join(CRYPTO_ROOT, org.domain, 'users', `${userId}@${org.domain}`, 'msp');

  const certificate = readFileSync(firstFileIn(join(userMsp, 'signcerts')));

  return {
    mspId: org.mspId,
    certificate,
    privateKeyPem: readFileSync(matchingKeyIn(join(userMsp, 'keystore'), certificate)),
    tlsRootCert: readFileSync(
      join(CRYPTO_ROOT, org.domain, 'peers', `peer0.${org.domain}`, 'tls', 'ca.crt'),
    ),
    peerEndpoint: resolvePeerEndpoint(org),
    peerHostAlias: org.peerHostAlias,
  };
}

/**
 * Pick the private key that actually belongs to this certificate.
 *
 * ⚠ Never just take the first file. fabric-ca-client ADDS a key to keystore/ on
 * every enrolment and never removes the old ones, so a directory can hold four
 * keys beside one certificate. Signing with the wrong one produces
 *
 *     access denied: channel [commitment] creator org [BankAMSP]
 *
 * which is indistinguishable from a revoked certificate at the peer and cost
 * real time to diagnose. enroll-users.sh now stages enrolments so this should
 * not arise — this is the second line of defence, and it is cheap.
 */
function matchingKeyIn(dir: string, certificate: Buffer): string {
  const candidates = readdirSync(dir).filter((f) => !f.startsWith('.'));
  if (candidates.length === 0) throw new Error(`CREDENTIALS_MISSING: ${dir} is empty`);
  if (candidates.length === 1) return join(dir, candidates[0]!);

  const certPublicKey = createPublicKey(certificate).export({ type: 'spki', format: 'der' });

  for (const candidate of candidates) {
    const path = join(dir, candidate);
    try {
      const derived = createPublicKey(createPrivateKey(readFileSync(path))).export({
        type: 'spki',
        format: 'der',
      });
      if (derived.equals(certPublicKey as Buffer)) return path;
    } catch {
      // Not a readable key — try the next one.
    }
  }

  throw new Error(
    `KEY_MISMATCH: none of the ${candidates.length} keys in ${dir} matches the certificate. ` +
      'Re-run network/scripts/enroll-users.sh, which stages enrolments so only one key survives.',
  );
}

/**
 * Fabric CA and cryptogen name files differently — `priv_sk`, a long hash, or
 * `cert.pem`. Take whatever is in the directory rather than guessing, which is
 * the same lesson as `normaliseSigncerts` in network.sh.
 */
function firstFileIn(dir: string): string {
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => !f.startsWith('.'));
  } catch {
    throw new Error(
      `CREDENTIALS_MISSING: ${dir} does not exist. Has ./network.sh up and ` +
        './scripts/enroll-users.sh been run?',
    );
  }
  if (entries.length === 0) throw new Error(`CREDENTIALS_MISSING: ${dir} is empty`);
  return join(dir, entries[0]!);
}
