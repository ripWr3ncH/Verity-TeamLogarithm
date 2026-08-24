/**
 * VERITY — the refusal catalogue.
 *
 * These strings are a FIRST-CLASS DELIVERABLE, not error handling. They are
 * what a judge reads on screen during the highest-scoring ninety seconds of the
 * demo, and they are what makes whitepaper §3.7.1's claim literally true:
 *
 *   "An approval level that exists only on paper becomes a condition the code
 *    checks, instead of a box the bank fills in itself."
 *
 * Rules for anything added here:
 *   1. Name the rule that was broken, with its circular reference.
 *   2. Say what was supplied against what was required.
 *   3. No stack traces, no internal identifiers, no apology.
 *
 * A stack trace on stage reads as an accident. A clean refusal reads as design.
 */

export const REFUSAL = {
  STATE_DIVERGENCE: 'STATE_DIVERGENCE',
  PARA_11C: 'PARA_11C',
  AUTHORITY_INSUFFICIENT: 'AUTHORITY_INSUFFICIENT',
  BOARD_AUTHORISATION_REQUIRED: 'BOARD_AUTHORISATION_REQUIRED',
  DIRECTOR_NOT_REGISTERED: 'DIRECTOR_NOT_REGISTERED',
  DIRECTOR_NOT_CONFIRMED: 'DIRECTOR_NOT_CONFIRMED',
  DUPLICATE_SIGNATURE: 'DUPLICATE_SIGNATURE',
  IDENTITY_REVOKED: 'IDENTITY_REVOKED',
  APPEND_ONLY: 'APPEND_ONLY',
  RS_CAP_EXCEEDED: 'RS_CAP_EXCEEDED',
  GOVERNANCE_QUORUM_REQUIRED: 'GOVERNANCE_QUORUM_REQUIRED',
  UNAUTHORISED_INSTITUTION: 'UNAUTHORISED_INSTITUTION',
  ROLE_REQUIRED: 'ROLE_REQUIRED',
  LOAN_NOT_FOUND: 'LOAN_NOT_FOUND',
  LOAN_EXISTS: 'LOAN_EXISTS',
  PARAMETER_UNKNOWN: 'PARAMETER_UNKNOWN',
  PROPOSAL_NOT_FOUND: 'PROPOSAL_NOT_FOUND',
  PROPOSAL_CLOSED: 'PROPOSAL_CLOSED',
  INVALID_EVENT_TYPE: 'INVALID_EVENT_TYPE',
  PAYLOAD_HASH_MISMATCH: 'PAYLOAD_HASH_MISMATCH',
  NO_PRIVATE_COLLECTION: 'NO_PRIVATE_COLLECTION',
} as const;

export type RefusalCode = (typeof REFUSAL)[keyof typeof REFUSAL];

/**
 * A refusal carries its code so the UI can style it and the red-team suite can
 * assert on it without matching prose.
 */
export class Refusal extends Error {
  readonly code: RefusalCode;

  constructor(code: RefusalCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'Refusal';
    this.code = code;
  }
}

export const refuse = (code: RefusalCode, message: string): never => {
  throw new Refusal(code, message);
};

// --------------------------------------------------------------------------
//  The catalogue. Every message a judge might see, in one place.
// --------------------------------------------------------------------------

export const refusals = {
  stateDivergence: (submitted: string, committed: string, blockHint: string) =>
    new Refusal(
      REFUSAL.STATE_DIVERGENCE,
      `submitted prior-state hash ${short(submitted)} does not match committed head ` +
        `${short(committed)} at ${blockHint}`,
    ),

  para11c: (missing: string) =>
    new Refusal(
      REFUSAL.PARA_11C,
      `classification requires the signatures of both the assigning and the reviewing ` +
        `officer (BRPD 15/2024 para 11(c)); ${missing}`,
    ),

  authorityInsufficient: (approverSeniority: number, sanctioningSeniority: number) =>
    new Refusal(
      REFUSAL.AUTHORITY_INSUFFICIENT,
      `approval must be one level above the sanctioning authority ` +
        `(BRPD 16/2022); approver seniority ${approverSeniority} is not senior to ` +
        `the recorded sanctioning officer's ${sanctioningSeniority}`,
    ),

  boardAuthorisationRequired: (rsSeq: number, supplied: number, required: number) =>
    new Refusal(
      REFUSAL.BOARD_AUTHORISATION_REQUIRED,
      `RS-${rsSeq} requires Board approval under BRPD 16/2022; ` +
        `supplied ${supplied} of ${required} director signatures`,
    ),

  boardAuthorisationRequiredForUpgrade: (from: string, to: string, supplied: number, required: number) =>
    new Refusal(
      REFUSAL.BOARD_AUTHORISATION_REQUIRED,
      `qualitative upgrade from ${from} to ${to} is reserved to the Board ` +
        `(BRPD 15/2024 para 6(d)); supplied ${supplied} of ${required} director signatures`,
    ),

  directorNotRegistered: (keyId: string, mspId: string, blockHint: string) =>
    new Refusal(
      REFUSAL.DIRECTOR_NOT_REGISTERED,
      `signer ${short(keyId)} is not in ${mspId}'s registered director set at ${blockHint}`,
    ),

  /**
   * The answer to "who decides who the three directors are?"
   *
   * Without this, a bank admin registers three keys it controls and satisfies
   * its own 3-of-3 Board threshold. The signature count would be enforced; the
   * INDEPENDENCE of the signers would not. This refusal is what makes Act 1
   * mean what it appears to mean.
   */
  directorNotConfirmed: (keyId: string, name: string, mspId: string, registeredAt: string) =>
    new Refusal(
      REFUSAL.DIRECTOR_NOT_CONFIRMED,
      `${short(keyId)} (${name}) was registered by ${mspId} on ${registeredAt.slice(0, 10)} ` +
        `but has not been confirmed by Bangladesh Bank. A bank cannot constitute its own ` +
        `Board: a director's appointment requires the supervisor's prior approval ` +
        `(Bank Company Act 1991, s.15)`,
    ),

  duplicateSignature: (keyId: string) =>
    new Refusal(
      REFUSAL.DUPLICATE_SIGNATURE,
      `director ${short(keyId)} signed more than once; a k-of-n threshold requires k distinct signers`,
    ),

  identityRevoked: (mspId: string) =>
    new Refusal(
      REFUSAL.IDENTITY_REVOKED,
      `signing credential appears on ${mspId}'s certificate revocation list; ` +
        `events signed before revocation remain valid`,
    ),

  appendOnly: (commitmentId: string, seq: number) =>
    new Refusal(
      REFUSAL.APPEND_ONLY,
      `committed events cannot be modified (${commitmentId} event ${seq}); ` +
        `submit a CORRECTION event referencing the prior-state hash`,
    ),

  rsCapExceeded: (rsSeq: number) =>
    new Refusal(
      REFUSAL.RS_CAP_EXCEEDED,
      `rescheduling is capped at three occasions with a fourth by special ` +
        `consideration (BRPD 16/2022); this would be RS-${rsSeq}`,
    ),

  governanceQuorumRequired: (parameter: string, have: number, need: number) =>
    new Refusal(
      REFUSAL.GOVERNANCE_QUORUM_REQUIRED,
      `detection parameters are Council-set (§4.6); '${parameter}' has ${have} of ` +
        `${need} required approvals from distinct Council organisations`,
    ),

  unauthorisedInstitution: (callerMsp: string, ownerMsp: string) =>
    new Refusal(
      REFUSAL.UNAUTHORISED_INSTITUTION,
      `${callerMsp} cannot write to an exposure held by ${ownerMsp}; ` +
        `no participant may write another institution's record`,
    ),

  roleRequired: (required: string, actual: string) =>
    new Refusal(
      REFUSAL.ROLE_REQUIRED,
      `this action requires the '${required}' role attribute on the caller's ` +
        `certificate; the caller presented '${actual || 'none'}'`,
    ),

  loanNotFound: (commitmentId: string) =>
    new Refusal(REFUSAL.LOAN_NOT_FOUND, `no exposure committed under ${commitmentId}`),

  loanExists: (commitmentId: string) =>
    new Refusal(REFUSAL.LOAN_EXISTS, `${commitmentId} is already committed; origination happens once`),

  parameterUnknown: (name: string) =>
    new Refusal(REFUSAL.PARAMETER_UNKNOWN, `'${name}' is not a Council-set parameter`),

  proposalNotFound: (id: string) =>
    new Refusal(REFUSAL.PROPOSAL_NOT_FOUND, `no governance proposal ${id}`),

  proposalClosed: (id: string, state: string) =>
    new Refusal(REFUSAL.PROPOSAL_CLOSED, `proposal ${id} is ${state} and no longer accepts approvals`),

  invalidEventType: (type: string) =>
    new Refusal(REFUSAL.INVALID_EVENT_TYPE, `'${type}' is not a recognised lifecycle event type`),

  payloadHashMismatch: (declared: string, actual: string) =>
    new Refusal(
      REFUSAL.PAYLOAD_HASH_MISMATCH,
      `the declared payload hash ${short(declared)} does not match the private payload supplied ` +
        `(${short(actual)}); the public record must commit to exactly what is held privately`,
    ),

  noPrivateCollection: (mspId: string) =>
    new Refusal(
      REFUSAL.NO_PRIVATE_COLLECTION,
      `${mspId} has no private data collection; only originating institutions hold one`,
    ),
};

const short = (h: string): string => (h.length > 12 ? `${h.slice(0, 10)}…` : h);
