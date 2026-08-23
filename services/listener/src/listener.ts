/**
 * VERITY — block listener. Ledger -> off-chain read model.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THIS PROCESS IS WHY THE ARCHITECTURE ANSWER LANDS.
 *
 *  Judges ask, every time: "is this really on a blockchain, or a database with
 *  hashes in it?" The answer is a button in the supervisor portal that calls
 *  `rebuild()` below: it TRUNCATES every projection and replays the chain from
 *  block 0, reconstructing the entire dashboard in front of them.
 *
 *  Nothing here is a source of truth. Everything is derived. If the read model
 *  and the ledger ever disagree, the ledger is right and this is a bug.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Design note: the listener consumes CHAINCODE EVENTS as a trigger, then reads
 * the authoritative state back from the ledger. Chaincode events carry only
 * what `setEvent` put in them; re-reading keeps the projection honest without
 * having to parse block write-sets.
 */

import { connect, Gateway, Network } from '@hyperledger/fabric-gateway';
import * as grpc from '@grpc/grpc-js';
import { createPrivateKey, randomUUID } from 'crypto';
import { createServer, type Server } from 'node:http';
import { signers } from '@hyperledger/fabric-gateway';
import pg from 'pg';

import { loadCredentials } from './credentials.js';
import { projectClaim, projectExposureAlert, projectLiabilityRoot, projectLifecycleEvent, projectParameterChange } from './projections.js';

const { Pool } = pg;

const CHANNELS = ['commitment', 'exposure', 'claims'] as const;
export type ChannelName = (typeof CHANNELS)[number];

/** The listener runs as a supervisory read identity — it observes, never writes to the ledger. */
const LISTENER_IDENTITY = process.env['VERITY_LISTENER_IDENTITY'] ?? 'supervisor-2';

export const pool = new Pool({
  connectionString:
    process.env['DATABASE_URL'] ?? 'postgres://verity:verity@localhost:5433/verity',
});

let gateway: Gateway | undefined;
let client: grpc.Client | undefined;

function open(): Gateway {
  if (gateway) return gateway;
  const creds = loadCredentials(LISTENER_IDENTITY);

  client = new grpc.Client(creds.peerEndpoint, grpc.credentials.createSsl(creds.tlsRootCert), {
    'grpc.ssl_target_name_override': creds.peerHostAlias,
    'grpc.max_receive_message_length': 32 * 1024 * 1024,
  });

  gateway = connect({
    client,
    identity: { mspId: creds.mspId, credentials: creds.certificate },
    signer: signers.newPrivateKeySigner(createPrivateKey(creds.privateKeyPem)),
  });
  return gateway;
}

// --------------------------------------------------------------------------

async function checkpointOf(channel: ChannelName): Promise<bigint> {
  const { rows } = await pool.query<{ last_block: string }>(
    'SELECT last_block FROM readmodel.checkpoint WHERE channel = $1',
    [channel],
  );
  return rows.length > 0 ? BigInt(rows[0]!.last_block) : 0n;
}

async function saveCheckpoint(channel: ChannelName, block: bigint): Promise<void> {
  await pool.query(
    `INSERT INTO readmodel.checkpoint (channel, last_block, events_applied, updated_at)
     VALUES ($1, $2, 1, now())
     ON CONFLICT (channel) DO UPDATE
       SET last_block = EXCLUDED.last_block,
           events_applied = readmodel.checkpoint.events_applied + 1,
           updated_at = now()`,
    [channel, block.toString()],
  );
}

/**
 * Follow one channel from `startBlock` forever.
 *
 * Replay is idempotent: every projection upserts on its natural key, so
 * restarting from an earlier block re-applies rather than duplicates. That is
 * what makes `rebuild()` safe to run live on stage.
 */
export async function follow(channel: ChannelName, startBlock?: bigint): Promise<void> {
  const network: Network = open().getNetwork(channel);
  const from = startBlock ?? (await checkpointOf(channel));

  // eslint-disable-next-line no-console
  console.log(`[listener] following '${channel}' from block ${from}`);

  const events = await network.getChaincodeEvents(channel, { startBlock: from });

  try {
    for await (const event of events) {
      const payload = JSON.parse(Buffer.from(event.payload).toString('utf8'));
      const context = {
        channel,
        blockNumber: event.blockNumber,
        txId: event.transactionId,
        network,
      };

      try {
        switch (event.eventName) {
          case 'LoanOriginated':
          case 'LifecycleEvent':
            await projectLifecycleEvent(pool, context, payload);
            break;
          case 'ParameterChanged':
            await projectParameterChange(pool, context, payload);
            break;
          case 'ExposureAlert':
            await projectExposureAlert(pool, context, payload);
            break;
          case 'LiabilityRootCommitted':
            await projectLiabilityRoot(pool, context, payload);
            break;
          case 'ClaimIssued':
            await projectClaim(pool, context, payload);
            break;
          default:
            // An unrecognised event is not an error. New chaincode may emit
            // events an older listener does not know; the ledger is still right.
            break;
        }
        await saveCheckpoint(channel, event.blockNumber);
      } catch (error) {
        // Never let one bad projection stop the stream. The read model is a
        // cache; losing a row is recoverable, losing the follower is not.
        // eslint-disable-next-line no-console
        console.error(`[listener] projection failed for ${event.eventName}`, error);
      }
    }
  } finally {
    events.close();
  }
}

/**
 * Wipe every projection and replay all three channels from block 0.
 *
 * This is the live demonstration that the ledger is the source of truth. It is
 * exposed in the supervisor portal as "Rebuild from block 0" and it is meant to
 * be pressed while the judges watch.
 */
export async function rebuild(): Promise<{ runId: string; startedAt: string }> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();

  // eslint-disable-next-line no-console
  console.log(`[listener] rebuild ${runId}: truncating every projection`);
  await pool.query('CALL readmodel.truncate_all()');

  for (const channel of CHANNELS) {
    void follow(channel, 0n);
  }
  return { runId, startedAt };
}

export async function shutdown(): Promise<void> {
  gateway?.close();
  client?.close();
  await pool.end();
}

/**
 * A very small control surface, so `rebuild()` can be triggered from the
 * supervisor portal instead of by restarting this process.
 *
 * This is the architecture answer made pressable: wipe every projection and
 * replay the chain from block 0 while a judge watches the dashboard empty and
 * refill. Kept on its own port and deliberately tiny — the API proxies to it,
 * and nothing here touches the ledger.
 */
function startControlServer(port: number): Server {
  return createServer((req, res) => {
    const json = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && req.url === '/status') {
      pool
        .query('SELECT channel, last_block, events_applied FROM readmodel.checkpoint ORDER BY channel')
        .then((r) => json(200, { checkpoints: r.rows }))
        .catch((e: Error) => json(500, { error: e.message }));
      return;
    }

    if (req.method === 'POST' && req.url === '/rebuild') {
      rebuild()
        .then((r) => json(202, { ...r, note: 'replaying all three channels from block 0' }))
        .catch((e: Error) => json(500, { error: e.message }));
      return;
    }

    json(404, { error: 'not found' });
  }).listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`[listener] control surface on :${port}`);
  });
}

if (process.argv[1]?.endsWith('listener.js')) {
  for (const channel of CHANNELS) void follow(channel);
  const control = startControlServer(Number(process.env['LISTENER_CONTROL_PORT'] ?? 4100));
  process.on('SIGINT', () => {
    control.close();
    void shutdown().then(() => process.exit(0));
  });
}
