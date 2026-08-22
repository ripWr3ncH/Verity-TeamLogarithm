/**
 * VERITY — Module I: lifecycle commitments.
 *
 * Whitepaper §3.7.1. The spine of the prototype.
 *
 *   "Verity changes where the record lives, not what the rules say. The
 *    classification events that already occur, carrying the signatures the
 *    regulation already requires, are committed to an append-only ledger that
 *    the reporting institution cannot silently revise."
 *
 * Endorsement policy (set at deploy time, not here):
 *   AND(OR('BankAMSP.peer','BankBMSP.peer'), 'BangladeshBankMSP.peer')
 * so Bangladesh Bank's endorsement is a PRECONDITION OF COMMITMENT, not a
 * review afterwards (§3.8 step 4).
 */

import { Context, Contract, Info, Returns, Transaction } from 'fabric-contract-api';

import {
  daysToNextReferenceDate,
  nextReferenceDate,
  requiredAuthority,
  verifyAuthority,
  verifyPara11c,
} from '../domain/authority';
import { refusals } from '../domain/errors';
import { eventHash, sha256Hex, stateHash } from '../domain/hash';
import {
  AuthorityEvidence,
  ClassificationTier,
  EventType,
  EVENT_TYPES,
  LifecycleEvent,
  LoanRecord,
  Para11cSignatures,
  RegisteredDirector,
  TIERS,
} from '../domain/types';
import {
  blockHint,
  caller,
  eventKey,
  getJson,
  KEY,
  listByPartialKey,
  loanKey,
  putJson,
  txTimestamp,
} from '../ledger';
import { readParameter } from './governance';
import { recordAccess } from './accesslog';

const GENESIS_STATE_HASH = '0'.repeat(64);

/**
 * Which private data collection holds an institution's payloads.
 * Mirrors chaincode/commitment/collections.json — change one, change the other.
 */
const COLLECTIONS: Record<string, string> = {
  BankAMSP: 'bankAPrivate',
  BankBMSP: 'bankBPrivate',
};

function collectionFor(institutionMsp: string): string {
  const collection = COLLECTIONS[institutionMsp];
  if (!collection) throw refusals.noPrivateCollection(institutionMsp);
  return collection;
}

@Info({ title: 'LifecycleContract', description: 'Module I — signed lifecycle events and authority evidence' })
export class LifecycleContract extends Contract {
  constructor() {
    super('LifecycleContract');
  }

  // ======================================================================
  //  Origination
  // ======================================================================

  /**
   * §3.7.1: "Origination emits a signed commitment over loan identifiers,
   * declared beneficial owners, principal, tenor, collateral and its valuation
   * […] and the initial classification."
   *
   * The sanctioning officer's seniority is recorded HERE so that every later
   * ONE_LEVEL_ABOVE check has a fixed thing to compare against. A bank cannot
   * retroactively lower it, because this record is append-only.
   */
  @Transaction()
  async OriginateLoan(
    ctx: Context,
    commitmentId: string,
    initialTier: string,
    outstandingBand: string,
    groupTokenAttestation: string,
    payloadHash: string,
    originationDate: string,
  ): Promise<string> {
    const who = caller(ctx);

    if (await getJson<LoanRecord>(ctx, loanKey(ctx, commitmentId))) {
      throw refusals.loanExists(commitmentId);
    }
    const tier = asTier(initialTier);

    const ts = txTimestamp(ctx);
    const refDate = nextReferenceDate(originationDate);
    const evHash = eventHash({
      commitmentId,
      seq: 0,
      type: 'ORIGINATION',
      classificationRefDate: refDate,
      daysToNextRefDate: daysToNextReferenceDate(originationDate),
      rsSeq: 0,
      tierBefore: tier,
      tierAfter: tier,
      prevStateHash: GENESIS_STATE_HASH,
      payloadHash,
    });
    const newState = stateHash(GENESIS_STATE_HASH, evHash);

    const loan: LoanRecord = {
      commitmentId,
      institutionMsp: who.mspId,
      currentTier: tier,
      prevStateHash: newState,
      rsSequence: 0,
      outstandingBand,
      originationTs: ts,
      sanctioningOfficerRole: who.role,
      sanctioningSeniority: who.seniority,
      groupTokenAttestation,
      eventCount: 1,
      status: 'ACTIVE',
    };

    const event: LifecycleEvent = {
      commitmentId,
      seq: 0,
      type: 'ORIGINATION',
      timestamp: ts,
      classificationRefDate: refDate,
      daysToNextRefDate: daysToNextReferenceDate(originationDate),
      rsSeq: 0,
      tierBefore: tier,
      tierAfter: tier,
      prevStateHash: GENESIS_STATE_HASH,
      newStateHash: newState,
      signatures: {
        assigning: { officerId: who.id, signature: `origination:${evHash.slice(0, 8)}` },
        reviewing: { officerId: who.id, signature: `origination:${evHash.slice(0, 8)}` },
      },
      authorityEvidence: { kind: 'MECHANICAL' },
      payloadHash,
      txId: ctx.stub.getTxID(),
      committedBy: who.id,
      committedByMsp: who.mspId,
    };

    await putJson(ctx, loanKey(ctx, commitmentId), loan);
    await putJson(ctx, eventKey(ctx, commitmentId, 0), event);
    ctx.stub.setEvent('LoanOriginated', Buffer.from(JSON.stringify({ commitmentId, tier })));

    return JSON.stringify({ commitmentId, stateHash: newState, txId: event.txId });
  }

  // ======================================================================
  //  The append — every transition (§3.7.1)
  // ======================================================================

  /**
   * "Every transition is an append, carrying event type, prior state hash, new
   *  state, signatures, authority evidence and timestamp."
   *
   * Refuses, with a legible reason, when:
   *   - the prior-state hash does not match the committed head  STATE_DIVERGENCE
   *   - either para 11(c) signature is missing                  PARA_11C
   *   - the approver is not strictly senior                     AUTHORITY_INSUFFICIENT
   *   - RS-3+ arrives without a k-of-n Board threshold          BOARD_AUTHORISATION_REQUIRED
   *   - a signer is outside the registered director set         DIRECTOR_NOT_REGISTERED
   *   - the caller's MSP does not own the exposure              UNAUTHORISED_INSTITUTION
   *   - rescheduling would exceed the statutory cap             RS_CAP_EXCEEDED
   */
  @Transaction()
  async AppendEvent(
    ctx: Context,
    commitmentId: string,
    eventType: string,
    tierAfterRaw: string,
    eventDate: string,
    prevStateHash: string,
    payloadHash: string,
    signaturesJson: string,
    authorityEvidenceJson: string,
    note: string,
  ): Promise<string> {
    const who = caller(ctx);
    const type = asEventType(eventType);

    const loan = await getJson<LoanRecord>(ctx, loanKey(ctx, commitmentId));
    if (!loan) throw refusals.loanNotFound(commitmentId);

    // No participant may write another institution's record (§4.4 Table 3).
    if (loan.institutionMsp !== who.mspId) {
      throw refusals.unauthorisedInstitution(who.mspId, loan.institutionMsp);
    }

    // Append-only: the submitted head must be the committed head.
    if (prevStateHash !== loan.prevStateHash) {
      throw refusals.stateDivergence(prevStateHash, loan.prevStateHash, blockHint(ctx));
    }

    const tierBefore = loan.currentTier;
    const tierAfter = asTier(tierAfterRaw);
    const rsSeq = type === 'RESCHEDULE' ? loan.rsSequence + 1 : loan.rsSequence;

    // Throws RS_CAP_EXCEEDED before anything else if this would be RS-5.
    const required = requiredAuthority(type, rsSeq, tierBefore, tierAfter);

    const seq = loan.eventCount;
    const refDate = nextReferenceDate(eventDate);
    const daysOut = daysToNextReferenceDate(eventDate);

    const evHash = eventHash({
      commitmentId,
      seq,
      type,
      classificationRefDate: refDate,
      daysToNextRefDate: daysOut,
      rsSeq,
      tierBefore,
      tierAfter,
      prevStateHash,
      payloadHash,
    });

    // Para 11(c) applies to every event after origination.
    const signatures = parse<Para11cSignatures>(signaturesJson, 'signatures');
    verifyPara11c(signatures, evHash);

    // Authority evidence — checked against the certificate and the registered
    // director set, never against a self-reported field.
    const evidence = parse<AuthorityEvidence>(authorityEvidenceJson, 'authorityEvidence');
    verifyAuthority(required, evidence, evHash, {
      registeredDirectors: await this.directorsOf(ctx, loan.institutionMsp),
      boardThresholdK: await readParameter(ctx, 'boardThresholdK'),
      sanctioningSeniority: loan.sanctioningSeniority,
      callerRole: who.role,
      callerSeniority: who.seniority,
      callerMsp: who.mspId,
      blockHint: blockHint(ctx),
    }, { rsSeq, tierBefore, tierAfter });

    if (type === 'CORRECTION' && !note.trim()) {
      throw refusals.appendOnly(commitmentId, seq);
    }

    const newState = stateHash(prevStateHash, evHash);
    const ts = txTimestamp(ctx);

    const event: LifecycleEvent = {
      commitmentId,
      seq,
      type,
      timestamp: ts,
      classificationRefDate: refDate,
      daysToNextRefDate: daysOut,
      rsSeq,
      tierBefore,
      tierAfter,
      prevStateHash,
      newStateHash: newState,
      signatures,
      authorityEvidence: { ...evidence, approverRole: who.role, approverSeniority: who.seniority },
      payloadHash,
      note: note || undefined,
      txId: ctx.stub.getTxID(),
      committedBy: who.id,
      committedByMsp: who.mspId,
    };

    const updated: LoanRecord = {
      ...loan,
      currentTier: tierAfter,
      prevStateHash: newState,
      rsSequence: rsSeq,
      eventCount: seq + 1,
      status: type === 'WRITE_OFF' ? 'WRITTEN_OFF' : loan.status,
    };

    // ------------------------------------------------------------------
    //  Private payload — §4.2's on-chain / off-chain boundary, enforced.
    //
    //  The justification memo, the borrower reference and the exact amounts
    //  travel in the TRANSIENT field, never in the arguments, so they are not
    //  written into the transaction the whole channel can read. Chaincode puts
    //  them in the originating institution's private data collection, shared
    //  only with Bangladesh Bank (and that institution's auditor).
    //
    //  What lands on the public channel is the HASH. Every channel member can
    //  verify that a payload exists and has not changed; only collection
    //  members can read it. That is Act 3a.
    // ------------------------------------------------------------------
    const transient = ctx.stub.getTransient();
    const privatePayload = transient.get('payload');

    if (privatePayload && privatePayload.length > 0) {
      // The public record must commit to exactly what is held privately, or
      // the hash proves nothing.
      const actual = sha256Hex(Buffer.from(privatePayload));
      if (actual !== payloadHash) throw refusals.payloadHashMismatch(payloadHash, actual);

      await ctx.stub.putPrivateData(
        collectionFor(loan.institutionMsp),
        eventKey(ctx, commitmentId, seq),
        Buffer.from(privatePayload),
      );
    }

    await putJson(ctx, eventKey(ctx, commitmentId, seq), event);
    await putJson(ctx, loanKey(ctx, commitmentId), updated);

    // The listener turns this into the off-chain read model (Phase 3).
    ctx.stub.setEvent(
      'LifecycleEvent',
      Buffer.from(JSON.stringify({ commitmentId, seq, type, rsSeq, daysOut, tierAfter })),
    );

    return JSON.stringify({
      commitmentId,
      seq,
      rsSeq,
      stateHash: newState,
      txId: event.txId,
      authorityVerified: required,
      daysToNextReferenceDate: daysOut,
    });
  }

  /**
   * There is deliberately no UpdateEvent and no DeleteEvent.
   *
   * This transaction exists so the refusal is explicit rather than a missing
   * function — red-team attack #5. §3.7:
   *   "Verity guarantees that committed history cannot be silently rewritten:
   *    any change is itself a recorded, endorsed event. We describe the property
   *    as tamper-evident, attributable and append-only rather than absolutely
   *    immutable."
   */
  @Transaction()
  async UpdateEvent(ctx: Context, commitmentId: string, seq: number): Promise<void> {
    throw refusals.appendOnly(commitmentId, seq);
  }

  // ======================================================================
  //  Reads
  // ======================================================================

  @Transaction(false)
  @Returns('string')
  async GetLoan(ctx: Context, commitmentId: string): Promise<string> {
    const loan = await getJson<LoanRecord>(ctx, loanKey(ctx, commitmentId));
    if (!loan) throw refusals.loanNotFound(commitmentId);
    return JSON.stringify(loan);
  }

  @Transaction(false)
  @Returns('string')
  async GetEventTrail(ctx: Context, commitmentId: string): Promise<string> {
    const events = await listByPartialKey<LifecycleEvent>(ctx, KEY.EVENT, [commitmentId]);
    return JSON.stringify(events.sort((a, b) => a.seq - b.seq));
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════
   *  ACT 3a. The same query, from two identities.
   *
   *  §4.4 Table 3: "No row grants any participant sight of another
   *  institution's per-borrower position."
   *
   *  Run this as Bangladesh Bank and you get the payload. Run it as an officer
   *  of a competing bank and you get the hash — not because this function
   *  decides to withhold it, but because THE PAYLOAD WAS NEVER DISSEMINATED
   *  TO THAT PEER. Fabric's private data collections enforce it at the gossip
   *  layer; the chaincode could not reveal it if it wanted to.
   *
   *  Both callers can see the hash, and can therefore both verify that a
   *  payload exists and has not been altered. That is the distinction worth
   *  drawing out on stage: confidentiality without giving up integrity.
   * ═══════════════════════════════════════════════════════════════════════
   */
  @Transaction(false)
  @Returns('string')
  async ReadEventPayload(ctx: Context, commitmentId: string, seq: string): Promise<string> {
    const loan = await getJson<LoanRecord>(ctx, loanKey(ctx, commitmentId));
    if (!loan) throw refusals.loanNotFound(commitmentId);

    const who = caller(ctx);
    const collection = collectionFor(loan.institutionMsp);
    const key = eventKey(ctx, commitmentId, Number(seq));

    // getPrivateData returns empty — or errors — for a peer outside the
    // collection. Either way it is a refusal, not a payload.
    let payload: Uint8Array | undefined;
    try {
      payload = await ctx.stub.getPrivateData(collection, key);
    } catch {
      payload = undefined;
    }

    // The hash lives in public state, so every channel member can read it.
    const hashBytes = await ctx.stub.getPrivateDataHash(collection, key);
    const payloadHash = Buffer.from(hashBytes).toString('hex');

    if (payload && payload.length > 0) {
      return JSON.stringify({
        authorised: true,
        callerMsp: who.mspId,
        collection,
        payloadHash,
        payload: JSON.parse(Buffer.from(payload).toString('utf8')),
      });
    }

    return JSON.stringify({
      authorised: false,
      callerMsp: who.mspId,
      collection,
      payloadHash,
      reason:
        `PRIVATE_DATA: ${who.mspId} is not a member of collection '${collection}'. ` +
        'The hash is public and verifiable; the payload was never replicated to this peer.',
    });
  }

  /**
   * The supervisory read. §4.7: "Access requests are logged append-only, so
   * supervisory queries leave a permanent trace."
   *
   * This is a SUBMIT transaction, not an evaluate, precisely because it writes
   * that trace. Oversight is watched too — and in the demo, the regulator's own
   * read from Act 2 shows up on the loan's trail in Act 5.
   */
  @Transaction()
  async SuperviseLoan(ctx: Context, commitmentId: string): Promise<string> {
    const who = caller(ctx);
    if (who.role !== 'supervisor' && who.role !== 'frc') {
      throw refusals.roleRequired('supervisor', who.role);
    }

    const loan = await getJson<LoanRecord>(ctx, loanKey(ctx, commitmentId));
    if (!loan) throw refusals.loanNotFound(commitmentId);
    const events = await listByPartialKey<LifecycleEvent>(ctx, KEY.EVENT, [commitmentId]);

    await recordAccess(ctx, commitmentId, 'READ_TRAIL');

    return JSON.stringify({ loan, events: events.sort((a, b) => a.seq - b.seq) });
  }

  // ======================================================================
  //  Director registry — the set BOARD_THRESHOLD is checked against
  // ======================================================================

  /**
   * §4.4: "directors additionally hold threshold-signing shares."
   * Only an org admin may register a director, and only for their own MSP.
   */
  @Transaction()
  async RegisterDirector(ctx: Context, keyId: string, publicKey: string, name: string): Promise<void> {
    const who = caller(ctx);
    if (who.role !== 'admin' && who.role !== 'mdceo') {
      throw refusals.roleRequired('admin', who.role);
    }
    const director: RegisteredDirector = {
      keyId,
      mspId: who.mspId,
      publicKey,
      name,
      registeredAt: txTimestamp(ctx),
    };
    await putJson(ctx, ctx.stub.createCompositeKey(KEY.DIRECTOR, [who.mspId, keyId]), director);
  }

  /**
   * Revocation is forward-only. §4.4: "a departed officer cannot sign a later
   * event while their earlier signatures remain valid."
   */
  @Transaction()
  async RevokeDirector(ctx: Context, keyId: string): Promise<void> {
    const who = caller(ctx);
    if (who.role !== 'admin' && who.role !== 'mdceo') {
      throw refusals.roleRequired('admin', who.role);
    }
    const key = ctx.stub.createCompositeKey(KEY.DIRECTOR, [who.mspId, keyId]);
    const director = await getJson<RegisteredDirector>(ctx, key);
    if (!director) throw refusals.directorNotRegistered(keyId, who.mspId, blockHint(ctx));
    await putJson(ctx, key, { ...director, revokedAt: txTimestamp(ctx) });
  }

  @Transaction(false)
  @Returns('string')
  async ListDirectors(ctx: Context, mspId: string): Promise<string> {
    return JSON.stringify(await this.directorsOf(ctx, mspId));
  }

  private async directorsOf(ctx: Context, mspId: string): Promise<RegisteredDirector[]> {
    return listByPartialKey<RegisteredDirector>(ctx, KEY.DIRECTOR, [mspId]);
  }
}

// --------------------------------------------------------------------------

function asTier(value: string): ClassificationTier {
  if (!(TIERS as readonly string[]).includes(value)) {
    throw refusals.invalidEventType(`classification tier '${value}'`);
  }
  return value as ClassificationTier;
}

function asEventType(value: string): EventType {
  if (!(EVENT_TYPES as readonly string[]).includes(value)) throw refusals.invalidEventType(value);
  return value as EventType;
}

function parse<T>(json: string, what: string): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    throw refusals.invalidEventType(`${what} is not valid JSON`);
  }
}
