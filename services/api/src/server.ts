/**
 * VERITY — API gateway.
 *
 * Deliberately thin. Business rules live in chaincode, not here, because a
 * judge will ask where they are enforced and "in our Node server" is a much
 * weaker answer than "on every endorsing peer".
 *
 * What this layer legitimately does:
 *   · pick the right identity for the caller  (identities.ts)
 *   · shape arguments for the contract
 *   · turn chaincode refusals into something a human can read
 *   · hand back the transaction receipt
 */

import Fastify, { FastifyReply } from 'fastify';
import cors from '@fastify/cors';

import { DEMO_USERS, ORGS } from './identities.js';
import { ChannelName, closeAll, evaluate, extractRefusal, submit } from './gateway.js';

const PORT = Number(process.env['PORT'] ?? 4000);

const app = Fastify({
  logger: { level: process.env['LOG_LEVEL'] ?? 'info' },
});

await app.register(cors, { origin: true });

/**
 * Every route runs as a NAMED identity supplied by the caller. There is no
 * default and no fallback: omitting it is an error, not an invitation to use a
 * service account.
 */
function actingUser(request: { headers: Record<string, unknown> }): string {
  const user = request.headers['x-verity-identity'];
  if (typeof user !== 'string' || user.length === 0) {
    throw Object.assign(new Error('IDENTITY_REQUIRED: send X-Verity-Identity naming the acting officer'), {
      statusCode: 400,
    });
  }
  return user;
}

/**
 * Refusals are 422, not 500. A chaincode refusal is the system working — the
 * UI renders it as a decision, and the red-team suite asserts on `code`.
 */
function handle(reply: FastifyReply, error: unknown): FastifyReply {
  const message = error instanceof Error ? error.message : String(error);

  // A client mistake is not a chaincode refusal, and must not be reported as
  // one. Anything raised here with its own statusCode came from THIS layer —
  // a missing identity header, malformed JSON — and its message happens to
  // look like a refusal code (IDENTITY_REQUIRED: ...), so the pattern match
  // below would otherwise mis-file it as a 422 policy decision. The red-team
  // suite asserts on refusal codes; a typo must never look like a rule firing.
  const ownStatus = (error as { statusCode?: number }).statusCode;
  if (ownStatus) {
    app.log.warn({ err: message }, 'client error');
    return reply.code(ownStatus).send({ refused: false, error: message });
  }

  const refusal = extractRefusal(error);
  if (refusal) {
    app.log.info({ refusal }, 'chaincode refusal');
    return reply.code(422).send({ refused: true, ...refusal });
  }

  app.log.error({ err: message }, 'request failed');
  return reply.code(500).send({ refused: false, error: message });
}

// ==========================================================================
//  Meta
// ==========================================================================

app.get('/health', async () => ({ status: 'ok', synthetic: true }));

/** The identity switcher in every portal reads this. */
app.get('/identities', async () => ({
  users: DEMO_USERS.map((u) => ({
    id: u.id,
    displayName: u.displayName,
    role: u.role,
    seniority: u.seniority,
    mspId: ORGS[u.org]!.mspId,
    portal: u.portal,
  })),
  note:
    'Each identity is a separate X.509 issued by its own organisation CA. Role and seniority ' +
    'are certificate attributes read by chaincode, not fields this API sets.',
}));

// ==========================================================================
//  Module I — lifecycle
// ==========================================================================

app.post<{
  Body: {
    commitmentId: string;
    initialTier: string;
    outstandingBand: string;
    groupToken: string;
    payloadHash: string;
    originationDate: string;
  };
}>('/loans', async (request, reply) => {
  try {
    const b = request.body;
    const out = await submit(actingUser(request), 'commitment', 'LifecycleContract', 'OriginateLoan', [
      b.commitmentId,
      b.initialTier,
      b.outstandingBand,
      b.groupToken,
      b.payloadHash,
      b.originationDate,
    ]);
    return reply.code(201).send(out);
  } catch (error) {
    return handle(reply, error);
  }
});

/**
 * The transaction Act 1 turns on.
 *
 * Submitted with only the officer's signature at RS-3, this returns 422 with
 *   BOARD_AUTHORISATION_REQUIRED: RS-3 requires Board approval under
 *   BRPD 16/2022; supplied 0 of 3 director signatures
 * Resubmitted with three director signatures, it commits and returns a receipt.
 */
app.post<{
  Body: {
    commitmentId: string;
    eventType: string;
    tierAfter: string;
    eventDate: string;
    prevStateHash: string;
    payloadHash: string;
    signatures: unknown;
    authorityEvidence: unknown;
    note?: string;
  };
}>('/events', async (request, reply) => {
  try {
    const b = request.body;
    const out = await submit(actingUser(request), 'commitment', 'LifecycleContract', 'AppendEvent', [
      b.commitmentId,
      b.eventType,
      b.tierAfter,
      b.eventDate,
      b.prevStateHash,
      b.payloadHash,
      JSON.stringify(b.signatures ?? {}),
      JSON.stringify(b.authorityEvidence ?? {}),
      b.note ?? '',
    ]);
    return reply.code(201).send(out);
  } catch (error) {
    return handle(reply, error);
  }
});

app.get<{ Params: { id: string } }>('/loans/:id', async (request, reply) => {
  try {
    return await evaluate(actingUser(request), 'commitment', 'LifecycleContract', 'GetLoan', [
      request.params.id,
    ]);
  } catch (error) {
    return handle(reply, error);
  }
});

app.get<{ Params: { id: string } }>('/loans/:id/events', async (request, reply) => {
  try {
    return await evaluate(actingUser(request), 'commitment', 'LifecycleContract', 'GetEventTrail', [
      request.params.id,
    ]);
  } catch (error) {
    return handle(reply, error);
  }
});

/**
 * The supervisory read — a SUBMIT transaction, because it writes an access-log
 * entry. §4.7: "supervisory queries leave a permanent trace." Oversight is
 * watched too, and in Act 5 this read shows up on the loan's own trail.
 */
app.post<{ Params: { id: string } }>('/supervise/:id', async (request, reply) => {
  try {
    return await submit(actingUser(request), 'commitment', 'LifecycleContract', 'SuperviseLoan', [
      request.params.id,
    ]);
  } catch (error) {
    return handle(reply, error);
  }
});

app.get('/access-log', async (request, reply) => {
  try {
    return await evaluate(actingUser(request), 'commitment', 'AccessLogContract', 'ListAccessLog', []);
  } catch (error) {
    return handle(reply, error);
  }
});

// ==========================================================================
//  Governance — Act 5
// ==========================================================================

app.get('/parameters', async (request, reply) => {
  try {
    return await evaluate(actingUser(request), 'commitment', 'GovernanceContract', 'ListParameters', []);
  } catch (error) {
    return handle(reply, error);
  }
});

app.post<{
  Body: { proposalId: string; parameter: string; proposedValue: number; rationale: string };
}>('/governance/proposals', async (request, reply) => {
  try {
    const b = request.body;
    const out = await submit(
      actingUser(request),
      'commitment',
      'GovernanceContract',
      'ProposeParameterChange',
      [b.proposalId, b.parameter, String(b.proposedValue), b.rationale],
    );
    return reply.code(201).send(out);
  } catch (error) {
    return handle(reply, error);
  }
});

app.post<{ Params: { id: string } }>('/governance/proposals/:id/approve', async (request, reply) => {
  try {
    return await submit(actingUser(request), 'commitment', 'GovernanceContract', 'ApproveProposal', [
      request.params.id,
    ]);
  } catch (error) {
    return handle(reply, error);
  }
});

/** Refuses with GOVERNANCE_QUORUM_REQUIRED until distinct Council orgs sign off. */
app.post<{ Params: { id: string } }>('/governance/proposals/:id/activate', async (request, reply) => {
  try {
    return await submit(actingUser(request), 'commitment', 'GovernanceContract', 'ActivateProposal', [
      request.params.id,
    ]);
  } catch (error) {
    return handle(reply, error);
  }
});

// ==========================================================================
//  Module II — exposure
// ==========================================================================

app.post<{ Body: { period: string; groupToken: string; ciphertext: string } }>(
  '/exposure/submissions',
  async (request, reply) => {
    try {
      const b = request.body;
      const user = actingUser(request);
      const out = await submit(user, 'exposure', 'ExposureContract', 'SubmitEncryptedExposure', [
        b.period,
        b.groupToken,
        b.ciphertext,
        '', // claimed MSP left empty: the contract takes it from the certificate
      ]);
      return reply.code(201).send(out);
    } catch (error) {
      return handle(reply, error);
    }
  },
);

app.post<{ Body: { period: string; groupToken: string; minContributors?: number } }>(
  '/exposure/aggregate',
  async (request, reply) => {
    try {
      const b = request.body;
      return await submit(actingUser(request), 'exposure', 'ExposureContract', 'AggregateGroup', [
        b.period,
        b.groupToken,
        String(b.minContributors ?? 2),
      ]);
    } catch (error) {
      return handle(reply, error);
    }
  },
);

app.post<{
  Body: {
    period: string;
    groupToken: string;
    total: string;
    randomness: string;
    participants: string[];
    thetaScaledBy10k: number;
    systemCapital: string;
  };
}>('/exposure/ceremony', async (request, reply) => {
  try {
    const b = request.body;
    return await submit(actingUser(request), 'exposure', 'ExposureContract', 'RecordCeremony', [
      b.period,
      b.groupToken,
      b.total,
      b.randomness,
      JSON.stringify(b.participants),
      String(b.thetaScaledBy10k),
      b.systemCapital,
    ]);
  } catch (error) {
    return handle(reply, error);
  }
});

// ==========================================================================
//  Modules III and IV — liabilities and claims
// ==========================================================================

app.post<{
  Body: {
    period: string;
    merkleRoot: string;
    committedSum: string;
    leafCount: number;
    rejectedCount: number;
  };
}>('/liability/roots', async (request, reply) => {
  try {
    const b = request.body;
    const out = await submit(actingUser(request), 'claims', 'LiabilityContract', 'CommitLiabilityRoot', [
      b.period,
      b.merkleRoot,
      b.committedSum,
      String(b.leafCount),
      String(b.rejectedCount),
    ]);
    return reply.code(201).send(out);
  } catch (error) {
    return handle(reply, error);
  }
});

/** The depositor's check. Evaluate-only: verifying your own position leaves no trace. */
app.post<{ Body: { institutionMsp: string; period: string; proof: unknown } }>(
  '/liability/verify',
  async (request, reply) => {
    try {
      const b = request.body;
      return await evaluate(actingUser(request), 'claims', 'LiabilityContract', 'VerifyInclusion', [
        b.institutionMsp,
        b.period,
        JSON.stringify(b.proof),
      ]);
    } catch (error) {
      return handle(reply, error);
    }
  },
);

app.get<{ Params: { key: string } }>('/claims/depositor/:key', async (request, reply) => {
  try {
    return await evaluate(actingUser(request), 'claims', 'ClaimsContract', 'ClaimsForDepositor', [
      request.params.key,
    ]);
  } catch (error) {
    return handle(reply, error);
  }
});

// ==========================================================================

const shutdown = async (): Promise<void> => {
  app.log.info('closing gateway connections');
  await closeAll();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: PORT, host: '0.0.0.0' });
app.log.info(`Verity API on :${PORT} — all data synthetic`);
