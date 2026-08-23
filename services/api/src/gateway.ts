/**
 * VERITY — Fabric gateway connections, one per identity.
 *
 * Every call is made with the credentials of the person making it (see
 * identities.ts). Connections are cached per user because building a gRPC
 * channel per request is slow enough to be visible on stage.
 *
 * ── THE RECEIPT ──────────────────────────────────────────────────────────
 *
 * Submitted transactions return a RECEIPT: transaction id, block number,
 * endorsing organisations, timestamp. Act 1 puts it on screen, and it is the
 * simplest possible proof that a real chain wrote a real block — the mandatory
 * back-end criterion, visible rather than asserted.
 */

import { connect, Contract, Gateway, Network, signers } from '@hyperledger/fabric-gateway';
import * as grpc from '@grpc/grpc-js';
import { createPrivateKey } from 'crypto';

import { Credentials, loadCredentials } from './identities.js';

export type ChannelName = 'commitment' | 'exposure' | 'claims';

/** Chaincode name per channel — one chaincode per channel (Phase 0 §2.3). */
const CHAINCODE: Record<ChannelName, string> = {
  commitment: 'commitment',
  exposure: 'exposure',
  claims: 'claims',
};

interface Connection {
  gateway: Gateway;
  client: grpc.Client;
  networks: Map<string, Network>;
}

const pool = new Map<string, Connection>();

function openConnection(userId: string): Connection {
  const creds: Credentials = loadCredentials(userId);

  const client = new grpc.Client(
    creds.peerEndpoint,
    grpc.credentials.createSsl(creds.tlsRootCert),
    {
      // The peer's certificate carries its container hostname, not "localhost".
      'grpc.ssl_target_name_override': creds.peerHostAlias,
      'grpc.max_receive_message_length': 32 * 1024 * 1024,
    },
  );

  const gateway = connect({
    client,
    identity: { mspId: creds.mspId, credentials: creds.certificate },
    signer: signers.newPrivateKeySigner(createPrivateKey(creds.privateKeyPem)),
    // Generous deadlines: a laptop running fifteen containers is not a data centre.
    evaluateOptions: () => ({ deadline: Date.now() + 10_000 }),
    endorseOptions: () => ({ deadline: Date.now() + 30_000 }),
    submitOptions: () => ({ deadline: Date.now() + 10_000 }),
    commitStatusOptions: () => ({ deadline: Date.now() + 90_000 }),
  });

  return { gateway, client, networks: new Map() };
}

function contractFor(userId: string, channel: ChannelName, contractName: string): Contract {
  let connection = pool.get(userId);
  if (!connection) {
    connection = openConnection(userId);
    pool.set(userId, connection);
  }

  let network = connection.networks.get(channel);
  if (!network) {
    network = connection.gateway.getNetwork(channel);
    connection.networks.set(channel, network);
  }

  return network.getContract(CHAINCODE[channel], contractName);
}

// --------------------------------------------------------------------------

export interface Receipt {
  txId: string;
  blockNumber: string;
  /** Organisations whose endorsement the policy required and got. */
  endorsers: string[];
  timestamp: string;
  channel: ChannelName;
  chaincode: string;
  contract: string;
  transaction: string;
}

export interface SubmitResult<T = unknown> {
  result: T;
  receipt: Receipt;
}

/**
 * Submit a transaction and return both the payload and the receipt.
 *
 * The receipt is not decoration. §3.8 step 4 says Bangladesh Bank's endorsement
 * is a precondition of commitment; `endorsers` on screen is how a judge sees
 * that the bank's peer alone was not enough.
 */
export async function submit<T = unknown>(
  userId: string,
  channel: ChannelName,
  contractName: string,
  transaction: string,
  args: string[],
): Promise<SubmitResult<T>> {
  const contract = contractFor(userId, channel, contractName);

  const proposal = contract.newProposal(transaction, { arguments: args });
  const transactionRequest = await proposal.endorse();
  const commit = await transactionRequest.submit();
  const status = await commit.getStatus();

  if (!status.successful) {
    throw new Error(
      `TRANSACTION_NOT_COMMITTED: validation code ${status.code} at block ${status.blockNumber}`,
    );
  }

  const payload = transactionRequest.getResult();

  return {
    result: parseResult<T>(payload),
    receipt: {
      txId: commit.getTransactionId(),
      blockNumber: status.blockNumber.toString(),
      endorsers: endorsingOrgs(channel),
      timestamp: new Date().toISOString(),
      channel,
      chaincode: CHAINCODE[channel],
      contract: contractName,
      transaction,
    },
  };
}

/** Read-only. No block, no receipt — and no trace, which is the point for a bank reading its own book. */
export async function evaluate<T = unknown>(
  userId: string,
  channel: ChannelName,
  contractName: string,
  transaction: string,
  args: string[],
): Promise<T> {
  const contract = contractFor(userId, channel, contractName);
  const payload = await contract.evaluateTransaction(transaction, ...args);
  return parseResult<T>(payload);
}

/**
 * The endorsement policy in force per channel, from scripts/deploy-cc.sh.
 * Displayed beside the receipt so the requirement is legible, not implied.
 */
function endorsingOrgs(channel: ChannelName): string[] {
  switch (channel) {
    case 'commitment':
    case 'exposure':
      return ['originating bank peer', 'BangladeshBankMSP peer'];
    case 'claims':
      return ['BankAMSP peer', 'BangladeshBankMSP peer'];
  }
}

function parseResult<T>(payload: Uint8Array): T {
  const text = Buffer.from(payload).toString('utf8');
  if (text.length === 0) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

/**
 * Chaincode refusals arrive wrapped in gRPC noise. The demo needs the message
 * the contract actually wrote — `BOARD_AUTHORISATION_REQUIRED: RS-3 requires…`
 * — not a stack trace. A stack trace on stage reads as an accident; a clean
 * refusal reads as design.
 */
export function extractRefusal(error: unknown): { code: string; message: string } | null {
  if (!(error instanceof Error)) return null;

  // ── Look in `details` FIRST, and this ordering is the whole point. ────────
  //
  // A fabric-gateway EndorseError's own `.message` is the gRPC status —
  // "ABORTED: failed to endorse transaction, see attached details for more
  // info". The message the CONTRACT actually wrote is nested in `.details[]`,
  // one entry per endorsing peer.
  //
  // Match the outer message and Act 1 puts "ABORTED" on screen instead of
  //   UNAUTHORISED_INSTITUTION: BankBMSP cannot write to an exposure held by
  //   BankAMSP; no participant may write another institution's record
  // which is the entire point of the refusal catalogue.
  const details = (error as { details?: Array<{ message?: string }> }).details;
  const messages = Array.isArray(details)
    ? details.map((d) => d?.message ?? '').filter(Boolean)
    : [];
  messages.push(error.message);

  // Identity failures happen at the MSP layer, BEFORE chaincode runs, so there
  // is no contract message to find — just "access denied". Without this the
  // revocation demo puts "ABORTED" on screen, which tells a judge nothing.
  for (const message of messages) {
    const identity = matchIdentityFailure(message);
    if (identity) return identity;
  }

  for (const message of messages) {
    const refusal = matchRefusal(message);
    if (refusal) return refusal;
  }
  return null;
}

/**
 * MSP-level rejections, which are not chaincode refusals but must read like
 * decisions rather than accidents.
 *
 * The two are worth telling apart. "access denied … creator org [X]" means the
 * certificate no longer validates in that MSP — a revocation, which is §4.4
 * working. "creator is malformed" means it never chained to the MSP root at
 * all, which is a misconfiguration and cost real time to diagnose once already.
 */
function matchIdentityFailure(text: string): { code: string; message: string } | null {
  if (/creator is malformed|creator org unknown/i.test(text)) {
    return {
      code: 'IDENTITY_NOT_RECOGNISED',
      message:
        'IDENTITY_NOT_RECOGNISED: this certificate does not chain to the organisation MSP the ' +
        'channel was created with. Usually means the network was regenerated without re-running ' +
        'enroll-users.sh, or the CA did not adopt the cryptogen root.',
    };
  }
  const denied = text.match(/access denied: channel \[([^\]]+)\] creator org \[([^\]]+)\]/i);
  if (denied) {
    // The peer says only "this identity is not currently valid here". It does
    // NOT say why, and the two causes look identical from outside:
    //   · the certificate is on the CRL      — §4.4 working
    //   · the client signed with a key that does not match the certificate
    //     — a setup fault, which happened here once and wasted real time
    //
    // An earlier version of this function reported the first unconditionally.
    // Telling a judge "revoked" when it is a stale key in the keystore is
    // exactly the kind of overclaim §7.4 exists to avoid, so name both.
    return {
      code: 'IDENTITY_NOT_VALID',
      message:
        `IDENTITY_NOT_VALID: the signing credential is not currently valid in ${denied[2]} on ` +
        `channel '${denied[1]}'. Either the certificate has been revoked — in which case events ` +
        'this officer signed earlier remain valid (§4.4) — or the client signed with a key that ' +
        'does not match it. Check the CRL first, then the keystore.',
    };
  }
  return null;
}

/**
 * Refusals are written as `CODE: explanation` (see the catalogue in
 * chaincode/commitment/src/domain/errors.ts). gRPC status names are excluded
 * so a transport failure is never mistaken for a policy decision.
 */
const GRPC_STATUS = new Set([
  'ABORTED', 'UNKNOWN', 'UNAVAILABLE', 'INTERNAL', 'DEADLINE_EXCEEDED',
  'FAILED_PRECONDITION', 'PERMISSION_DENIED', 'UNAUTHENTICATED',
  'INVALID_ARGUMENT', 'NOT_FOUND', 'RESOURCE_EXHAUSTED', 'CANCELLED',
]);

function matchRefusal(text: string): { code: string; message: string } | null {
  if (!text) return null;
  // Chaincode errors surface as: "... message: CODE: explanation" or bare.
  const pattern = /\b([A-Z][A-Z0-9_]{4,}):\s+(.+?)(?:\s*\[|$)/g;
  for (const match of text.matchAll(pattern)) {
    const code = match[1]!;
    if (GRPC_STATUS.has(code)) continue;
    return { code, message: `${code}: ${match[2]!.trim()}` };
  }
  return null;
}

export async function closeAll(): Promise<void> {
  for (const { gateway, client } of pool.values()) {
    gateway.close();
    client.close();
  }
  pool.clear();
}
