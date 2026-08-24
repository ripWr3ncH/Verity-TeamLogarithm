/**
 * VERITY — cryptographic authority verification.
 *
 * Whitepaper §3.7.1:
 *   "An `authority_level` field asserting 'Board' is worthless unless bound to
 *    something. Verity requires evidence, not a declaration. […] Chaincode
 *    rejects any event whose authority evidence fails. An approval level that
 *    exists only on paper becomes a condition the code checks, instead of a box
 *    the bank fills in itself."
 *
 * This file is pure: no Fabric imports, no I/O. Everything it needs is passed
 * in, which is what makes the whole policy unit-testable without a network.
 */

import { refusals } from './errors';
import { verifyEd25519 } from './hash';
import {
  AuthorityEvidence,
  AuthorityKind,
  ClassificationTier,
  EventType,
  Para11cSignatures,
  RegisteredDirector,
  TIER_RANK,
} from './types';

// --------------------------------------------------------------------------
//  Which approval does this event need?
// --------------------------------------------------------------------------

/**
 * The regulation, as a decision table.
 *
 *   BRPD 16/2022        rescheduling needs approval one level above the
 *                       sanctioning authority; Board approval at the third and
 *                       fourth attempt; capped at three occasions with a fourth
 *                       by special consideration.
 *   BRPD 15/2024 6(d)   qualitative upgrades out of Sub-Standard are reserved
 *                       to the Board.
 *
 * `MECHANICAL` means the event is driven by days past due, so there is no
 * discretionary approval to prove. §3.7.1: "Where days past due drive it the
 * event is mechanical. Where judgment drives it, the event carries the two
 * para 11(c) signatures and the authority evidence the regulation requires."
 */
export function requiredAuthority(
  type: EventType,
  rsSeq: number,
  tierBefore: ClassificationTier,
  tierAfter: ClassificationTier,
): AuthorityKind {
  switch (type) {
    case 'ORIGINATION':
      return 'MECHANICAL';

    case 'RESCHEDULE':
      if (rsSeq > 4) throw refusals.rsCapExceeded(rsSeq);
      // Third and fourth attempts go to the Board (BRPD 16/2022).
      return rsSeq >= 3 ? 'BOARD_THRESHOLD' : 'ONE_LEVEL_ABOVE';

    case 'RECLASSIFY_UP': {
      // Para 6(d): an upgrade OUT OF Sub-Standard or worse is a Board matter.
      const isUpgrade = TIER_RANK[tierAfter] < TIER_RANK[tierBefore];
      const fromClassified = TIER_RANK[tierBefore] >= TIER_RANK.SUB_STANDARD;
      return isUpgrade && fromClassified ? 'BOARD_THRESHOLD' : 'ONE_LEVEL_ABOVE';
    }

    case 'WRITE_OFF':
      return 'BOARD_THRESHOLD';

    case 'CORRECTION':
      return 'MDCEO';

    case 'RESTRUCTURE':
    case 'COLLATERAL_REVALUATION':
    case 'ASSET_PLEDGE':
      return 'ONE_LEVEL_ABOVE';

    // Downgrades, recoveries and devolvement follow the arithmetic, not a
    // judgement call. Recording them is not an approval.
    case 'RECLASSIFY_DOWN':
    case 'RECOVERY':
    case 'LC_DEVOLVEMENT':
      return 'MECHANICAL';

    default:
      throw refusals.invalidEventType(type);
  }
}

// --------------------------------------------------------------------------
//  Para 11(c) — two named officers, on every event after origination
// --------------------------------------------------------------------------

/**
 * BRPD 15/2024 para 11(c) requires written justification carrying the
 * signatures of BOTH the assigning and the reviewing officer. §1.1 notes the
 * gap this closes: today those signatures "sit in loan files, legible only to
 * an inspection team physically present".
 */
export function verifyPara11c(sigs: Para11cSignatures | undefined, evHash: string): void {
  if (!sigs) throw refusals.para11c('no signatures were supplied');

  const missing: string[] = [];
  if (!sigs.assigning?.officerId || !sigs.assigning?.signature) missing.push('assigning officer');
  if (!sigs.reviewing?.officerId || !sigs.reviewing?.signature) missing.push('reviewing officer');
  if (missing.length > 0) throw refusals.para11c(`missing the ${missing.join(' and the ')} signature`);

  // Two names, not one name twice.
  if (sigs.assigning.officerId === sigs.reviewing.officerId) {
    throw refusals.para11c(
      'the assigning and reviewing officer must be different people; ' +
        `both signatures were presented by ${sigs.assigning.officerId}`,
    );
  }

  // The signature must be over THIS event, not some other one.
  if (!sigs.assigning.signature.includes(evHash.slice(0, 8))) {
    // Prototype binding: the officer signature embeds the event-hash prefix.
    // Phase 3 replaces this with a real ed25519 signature under the officer's
    // SoftHSM-held key — the same check, a stronger primitive.
    throw refusals.para11c("the assigning officer's signature is not over this event");
  }
  if (!sigs.reviewing.signature.includes(evHash.slice(0, 8))) {
    throw refusals.para11c("the reviewing officer's signature is not over this event");
  }
}

// --------------------------------------------------------------------------
//  Authority evidence
// --------------------------------------------------------------------------

export interface AuthorityContext {
  /** Directors registered to this institution, as of the current block. */
  registeredDirectors: RegisteredDirector[];
  /** k in the k-of-n threshold. Council-set (§4.6), read from GOVPARAM. */
  boardThresholdK: number;
  /** Seniority recorded on the loan at origination. */
  sanctioningSeniority: number;
  /** Role and seniority from the CALLER'S CERTIFICATE — never from the payload. */
  callerRole: string;
  callerSeniority: number;
  callerMsp: string;
  /** Human-readable block reference for refusal messages. */
  blockHint: string;
}

/**
 * Verify that the evidence supplied actually proves the authority the event
 * requires. Throws a Refusal naming the rule that failed.
 */
export function verifyAuthority(
  required: AuthorityKind,
  evidence: AuthorityEvidence | undefined,
  evHash: string,
  ctx: AuthorityContext,
  detail: { rsSeq: number; tierBefore: string; tierAfter: string },
): void {
  if (required === 'MECHANICAL') return;

  if (!evidence) {
    if (required === 'BOARD_THRESHOLD') {
      throw detail.rsSeq >= 3
        ? refusals.boardAuthorisationRequired(detail.rsSeq, 0, ctx.boardThresholdK)
        : refusals.boardAuthorisationRequiredForUpgrade(
            detail.tierBefore,
            detail.tierAfter,
            0,
            ctx.boardThresholdK,
          );
    }
    throw refusals.roleRequired(required.toLowerCase(), ctx.callerRole);
  }

  switch (required) {
    case 'BOARD_THRESHOLD':
      verifyBoardThreshold(evidence, evHash, ctx, detail);
      return;

    case 'MDCEO':
      if (ctx.callerRole !== 'mdceo') throw refusals.roleRequired('mdceo', ctx.callerRole);
      return;

    case 'ONE_LEVEL_ABOVE':
      // §3.7.1: "the sanctioning officer's role is recorded at origination, and
      // the approving signature must carry a strictly senior role."
      if (ctx.callerSeniority <= ctx.sanctioningSeniority) {
        throw refusals.authorityInsufficient(ctx.callerSeniority, ctx.sanctioningSeniority);
      }
      return;
  }
}

/**
 * k-of-n threshold over the registered director set.
 *
 * §3.7.1: "Board authorisation is a k-of-n threshold signature over the event
 * hash from registered director credentials, validated by chaincode against the
 * registered director set for that institution AT THAT BLOCK HEIGHT."
 *
 * Four ways this refuses, and each is a red-team attack:
 *   - too few valid signatures        -> BOARD_AUTHORISATION_REQUIRED  (attack 1)
 *   - a signer outside the set        -> DIRECTOR_NOT_REGISTERED       (attack 3)
 *   - a signer the bank registered
 *     but the supervisor has not
 *     confirmed                       -> DIRECTOR_NOT_CONFIRMED        (attack 9)
 *   - the same director signing twice -> DUPLICATE_SIGNATURE
 *
 * The third is the one that makes the other three worth anything. Counting
 * signatures proves a THRESHOLD was met; it says nothing about whether the
 * signers are independent of the bank that benefits. A bank admin can register
 * three keys it controls in a single transaction. Only the supervisor's
 * confirmation makes the Board a board.
 */
function verifyBoardThreshold(
  evidence: AuthorityEvidence,
  evHash: string,
  ctx: AuthorityContext,
  detail: { rsSeq: number; tierBefore: string; tierAfter: string },
): void {
  const supplied = evidence.directorSignatures ?? [];
  const k = ctx.boardThresholdK;

  const active = new Map(
    ctx.registeredDirectors.filter((d) => !d.revokedAt).map((d) => [d.keyId, d]),
  );

  const counted = new Set<string>();
  for (const sig of supplied) {
    const director = active.get(sig.keyId);
    if (!director) throw refusals.directorNotRegistered(sig.keyId, ctx.callerMsp, ctx.blockHint);
    // Registered is not the same as confirmed, and the difference is the whole
    // point. `status` is absent on records written before this control existed,
    // and those fail closed rather than being grandfathered in.
    if (director.status !== 'CONFIRMED') {
      throw refusals.directorNotConfirmed(
        director.keyId,
        director.name,
        director.mspId,
        director.registeredAt,
      );
    }
    if (counted.has(sig.keyId)) throw refusals.duplicateSignature(sig.keyId);
    if (verifyEd25519(director.publicKey, evHash, sig.signature)) counted.add(sig.keyId);
  }

  if (counted.size < k) {
    throw detail.rsSeq >= 3
      ? refusals.boardAuthorisationRequired(detail.rsSeq, counted.size, k)
      : refusals.boardAuthorisationRequiredForUpgrade(
          detail.tierBefore,
          detail.tierAfter,
          counted.size,
          k,
        );
  }
}

// --------------------------------------------------------------------------
//  Statutory calendar — the EDI's d_j
// --------------------------------------------------------------------------

/** BRPD 15/2024: 31 March, 30 June, 30 September, 31 December. */
const REF_MONTH_DAY: ReadonlyArray<readonly [number, number]> = [
  [3, 31],
  [6, 30],
  [9, 30],
  [12, 31],
];

/**
 * Calendar-exact days from an event date to the NEXT classification reference
 * date. This is d_j in equation (1) of §3.7.1 — the term that makes an event
 * placed just before quarter-end weigh more than one placed months out.
 *
 * `isoDate` is YYYY-MM-DD. UTC throughout: a local timezone would make the
 * result non-deterministic across peers.
 */
export function daysToNextReferenceDate(isoDate: string): number {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) throw new Error(`not an ISO date: ${isoDate}`);

  const t = Date.UTC(y, m - 1, d);
  const candidates: number[] = [];
  for (const yr of [y, y + 1]) {
    for (const [mm, dd] of REF_MONTH_DAY) candidates.push(Date.UTC(yr, mm - 1, dd));
  }
  const next = candidates.filter((c) => c >= t).sort((a, b) => a - b)[0]!;
  return Math.round((next - t) / 86_400_000);
}

/** The reference date itself, as YYYY-MM-DD. */
export function nextReferenceDate(isoDate: string): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  const t = Date.UTC(y!, m! - 1, d!);
  const candidates: number[] = [];
  for (const yr of [y!, y! + 1]) {
    for (const [mm, dd] of REF_MONTH_DAY) candidates.push(Date.UTC(yr, mm - 1, dd));
  }
  const next = candidates.filter((c) => c >= t).sort((a, b) => a - b)[0]!;
  return new Date(next).toISOString().slice(0, 10);
}
