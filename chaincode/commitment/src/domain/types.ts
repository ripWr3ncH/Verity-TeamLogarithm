/**
 * VERITY — data model for the `commitment` channel.
 *
 * Whitepaper §4.2:
 *   "Ledger state is keyed on a loan commitment identifier. Each record holds
 *    the current classification tier, the hash of the previous state, the RS
 *    sequence number, the outstanding balance band, and an ordered list of
 *    event references. Each event carries its type, timestamp, the signatures
 *    the regulation requires for that type, and the authority evidence."
 *
 * Note what is NOT here: no borrower name, no national ID, no account number,
 * no exact balance. §4.2 — "Borrower-group tokens are held as attestations
 * rather than record keys, so no ledger query returns a borrower's identity."
 * Everything identifying lives off-chain or in a private data collection and is
 * referenced here only by hash.
 *
 * DUPLICATION NOTICE: these types are intentionally duplicated between chaincode
 * packages rather than imported from packages/. Fabric runs `npm install` inside
 * the peer's build container where workspace symlinks do not resolve. See
 * HANDOFF/PHASE_00_FOUNDATION.md §2.4.
 */

// --------------------------------------------------------------------------
//  Classification — BRPD 15/2024
// --------------------------------------------------------------------------

export const TIERS = ['STANDARD', 'SMA', 'SUB_STANDARD', 'DOUBTFUL', 'BAD_LOSS'] as const;
export type ClassificationTier = (typeof TIERS)[number];

/** Rank used to decide whether a reclassification is an upgrade. Higher = worse. */
export const TIER_RANK: Record<ClassificationTier, number> = {
  STANDARD: 0,
  SMA: 1,
  SUB_STANDARD: 2,
  DOUBTFUL: 3,
  BAD_LOSS: 4,
};

// --------------------------------------------------------------------------
//  Events — §3.7.1
// --------------------------------------------------------------------------

export const EVENT_TYPES = [
  'ORIGINATION',
  'RESCHEDULE',
  'RESTRUCTURE',
  'RECLASSIFY_UP',
  'RECLASSIFY_DOWN',
  'WRITE_OFF',
  'RECOVERY',
  'COLLATERAL_REVALUATION',
  'ASSET_PLEDGE',
  'LC_DEVOLVEMENT',
  'CORRECTION',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * How the approving authority is proved. §3.7.1:
 *   "An `authority_level` field asserting 'Board' is worthless unless bound to
 *    something. Verity requires evidence, not a declaration."
 */
export type AuthorityKind =
  /** k-of-n threshold signature from registered director credentials. */
  | 'BOARD_THRESHOLD'
  /** Single signature under a registered MD/CEO role credential. */
  | 'MDCEO'
  /** Approver's role attribute must be strictly senior to the sanctioning officer's. */
  | 'ONE_LEVEL_ABOVE'
  /** Driven by days past due, so no discretionary approval exists to prove. */
  | 'MECHANICAL';

/** One director's signature over the canonical event hash. */
export interface DirectorSignature {
  /** SHA-256 of the registered ed25519 public key, hex. Identifies the signer. */
  keyId: string;
  /** ed25519 signature over the event hash, base64. */
  signature: string;
}

export interface AuthorityEvidence {
  kind: AuthorityKind;
  /** Present for BOARD_THRESHOLD. Must contain k distinct registered directors. */
  directorSignatures?: DirectorSignature[];
  /** Present for ONE_LEVEL_ABOVE and MDCEO — read from the caller's certificate. */
  approverRole?: string;
  approverSeniority?: number;
}

/**
 * Officer signatures required by BRPD 15/2024 para 11(c) — written justification
 * carrying BOTH the assigning and the reviewing officer.
 */
export interface Para11cSignatures {
  /** Certificate ID of the assigning officer, plus their signature over the event hash. */
  assigning: { officerId: string; signature: string };
  reviewing: { officerId: string; signature: string };
}

export interface LifecycleEvent {
  commitmentId: string;
  seq: number;
  type: EventType;

  /** From ctx.stub.getTxTimestamp() — never Date.now(), which is non-deterministic. */
  timestamp: string;

  /** The statutory classification reference date this event is measured against. */
  classificationRefDate: string;
  /** Calendar days from the event to that date. The EDI's d_j (§3.7.1 eq. 1). */
  daysToNextRefDate: number;

  /** RS sequence number. The EDI's r_j. Defined for RESCHEDULE only. */
  rsSeq: number;

  tierBefore: ClassificationTier;
  tierAfter: ClassificationTier;

  prevStateHash: string;
  newStateHash: string;

  signatures: Para11cSignatures;
  authorityEvidence: AuthorityEvidence;

  /** SHA-256 of the off-chain payload (agreement, justification memo, valuation). */
  payloadHash: string;

  /** Free-text reason. Required on CORRECTION. */
  note?: string;

  /** Fabric transaction that committed this event. Filled in by the contract. */
  txId: string;
  committedBy: string;
  committedByMsp: string;
}

export interface LoanRecord {
  commitmentId: string;
  institutionMsp: string;

  currentTier: ClassificationTier;
  prevStateHash: string;
  rsSequence: number;

  /** A band, never an exact figure — §4.2 keeps exact amounts off-chain. */
  outstandingBand: string;

  originationTs: string;

  /** Recorded at origination so ONE_LEVEL_ABOVE has something to compare against. */
  sanctioningOfficerRole: string;
  sanctioningSeniority: number;

  /** Pseudonymous borrower-group token, held as an attestation (§3.7.2). */
  groupTokenAttestation: string;

  eventCount: number;
  status: 'ACTIVE' | 'WRITTEN_OFF' | 'CLOSED';
}

// --------------------------------------------------------------------------
//  Governance — §4.6
// --------------------------------------------------------------------------

/**
 * The Council-set parameters. §4.6:
 *   "The detection parameters λ, E* and θ, the authority-evidence thresholds
 *    and the disclosure lag are all Council-set, so no participant can tune the
 *    system to its own advantage."
 */
export const GOVERNED_PARAMETERS = [
  'lambda',            // EDI decay, per day (§3.7.1 eq. 1)
  'eStar',             // institution-level alert threshold (§3.7.1 eq. 2)
  'theta',             // cross-bank exposure threshold, fraction of C_system (§3.7.2)
  'boardThresholdK',   // k in the k-of-n director threshold (§3.7.1)
  'councilQuorum',     // distinct Council orgs required to change a parameter
  'disclosureLagDays', // supervisory disclosure lag (§7.3)
] as const;
export type GovernedParameter = (typeof GOVERNED_PARAMETERS)[number];

export interface Parameter {
  name: GovernedParameter;
  value: number;
  effectiveFrom: string;
  /** Proposal that set this value. 'GENESIS' for the initial calibration. */
  proposalId: string;
  changedByTx: string;
}

export interface ParameterProposal {
  proposalId: string;
  parameter: GovernedParameter;
  currentValue: number;
  proposedValue: number;
  rationale: string;
  proposedBy: string;
  proposedByMsp: string;
  proposedAt: string;
  /** Distinct Council MSPs that have approved. A proposer's own MSP counts once. */
  approvals: string[];
  state: 'OPEN' | 'ACTIVATED' | 'WITHDRAWN';
  activatedAt?: string;
  /** The Council organisation that enacted it. Named, never anonymous. */
  activatedBy?: string;
  activatedByTx?: string;
}

// --------------------------------------------------------------------------
//  Directors — the registered set that BOARD_THRESHOLD is checked against
// --------------------------------------------------------------------------

/**
 * A director is only usable once the SUPERVISOR has confirmed them.
 *
 * `undefined` means the record predates confirmation and is treated as PENDING.
 * Failing closed is deliberate: the alternative would silently grandfather in
 * exactly the directors this control exists to catch.
 */
export type DirectorStatus = 'PENDING' | 'CONFIRMED';

export interface RegisteredDirector {
  keyId: string;
  mspId: string;
  /** ed25519 public key, base64 SPKI DER. */
  publicKey: string;
  name: string;
  registeredAt: string;
  /** The bank admin who submitted the registration. Named, never anonymous. */
  registeredBy?: string;
  status?: DirectorStatus;
  /** The supervisory officer who confirmed. Recorded so the approval has a name. */
  confirmedBy?: string;
  confirmedAt?: string;
  revokedAt?: string;
  revokedBy?: string;
}

// --------------------------------------------------------------------------
//  Supervisory access log — §4.7
// --------------------------------------------------------------------------

/**
 * §4.7: "Access requests are logged append-only, so supervisory queries leave a
 * permanent trace." Oversight is watched too.
 */
export interface AccessLogEntry {
  timestamp: string;
  actorId: string;
  actorMsp: string;
  resource: string;
  action: 'READ_LOAN' | 'READ_TRAIL' | 'READ_PORTFOLIO';
  txId: string;
}
