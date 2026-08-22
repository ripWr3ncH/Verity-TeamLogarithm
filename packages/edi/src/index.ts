/**
 * VERITY — the Evergreening Detection Index.
 *
 * Whitepaper §3.7.1, equations (1) and (2):
 *
 *        k                                              outstanding_i
 *   E_i = Σ  r_j · e^(−λ d_j)      E_bank = Σ w_i E_i ,  w_i = ─────────────
 *       j=1                               i               Σ_j outstanding_j
 *
 *   d_j = calendar days from rescheduling event τ_j to the NEXT statutory
 *         classification reference date (31 Mar / 30 Jun / 30 Sep / 31 Dec)
 *   r_j = RS sequence number of that rescheduling
 *
 * Computed OFF-CHAIN, over events read from the ledger. It is analytics over
 * committed facts, not a consensus concern — so it belongs in the read model,
 * where it can be recomputed deterministically on rebuild.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  λ AND E* ARE COUNCIL-SET. They are read from the governance chaincode, never
 *  hard-coded here. §4.6: "no participant can tune the system to its own
 *  advantage." The defaults below exist only so a unit test can run.
 *
 *  §3.7.1 is explicit about what this is and is not:
 *
 *    "The EDI is a screening indicator that ranks exposures for supervisory
 *     attention, not a finding of misconduct. […] Rescheduling also clusters
 *     near period-ends for legitimate operational reasons, so a naive index
 *     would flag ordinary administrative rhythm as evergreening. E* must be set
 *     against the measured system-wide base rate rather than against zero."
 *
 *  Every UI surface that shows a score must carry that sentence. See
 *  DISCLAIMER below — import it, do not retype it.
 * ══════════════════════════════════════════════════════════════════════════
 */

export const DISCLAIMER =
  'Screening indicator, not a finding of misconduct. Synthetic data. ' +
  'λ and E* are illustrative and Council-set at calibration; thresholds must be set against the ' +
  'measured system-wide base rate, not against zero. (§3.7.1, §7.4 #10)';

/** Illustrative only. Production reads these from the governance chaincode. */
export const ILLUSTRATIVE = {
  /** per day; half-life ln2/λ = 23.1 days */
  lambda: 0.03,
  /** institution-level alert threshold */
  eStar: 0.5,
  /** statutory cap on rescheduling occasions (BRPD 16/2022) */
  rsCap: 3,
} as const;

// --------------------------------------------------------------------------
//  Inputs
// --------------------------------------------------------------------------

export interface EdiEvent {
  type: string;
  /** r_j. Defined for RESCHEDULE only. */
  rsSeq: number;
  /** d_j — calendar days to the next classification reference date. */
  daysToNextRefDate: number;
  eventDate: string;
  classificationRefDate: string;
}

export interface EdiLoan {
  commitmentId: string;
  institutionMsp: string;
  /** Outstanding balance, for the weighting in equation (2). */
  outstanding: number;
  currentTier: string;
  rsSequence: number;
  events: EdiEvent[];
}

export interface EdiParameters {
  lambda: number;
  eStar: number;
  rsCap: number;
}

// --------------------------------------------------------------------------
//  Equation (1) — one exposure
// --------------------------------------------------------------------------

/**
 * §3.7.1: "The EDI is computed over rescheduling events only, where the RS
 * sequence number is defined. Qualitative upgrades are watched through the
 * authority-evidence trail."
 */
export const isCounted = (e: EdiEvent): boolean => e.type === 'RESCHEDULE' && e.rsSeq > 0;

export function loanEdi(events: EdiEvent[], lambda: number): number {
  return events
    .filter(isCounted)
    .reduce((sum, e) => sum + e.rsSeq * Math.exp(-lambda * e.daysToNextRefDate), 0);
}

export interface EdiTrailPoint extends EdiEvent {
  contribution: number;
  cumulative: number;
}

/** The cumulative series the supervisor dashboard plots beside the CL-1 column. */
export function loanEdiTrail(events: EdiEvent[], lambda: number): EdiTrailPoint[] {
  let cumulative = 0;
  return events
    .filter(isCounted)
    .slice()
    .sort((a, b) => a.eventDate.localeCompare(b.eventDate))
    .map((e) => {
      const contribution = e.rsSeq * Math.exp(-lambda * e.daysToNextRefDate);
      cumulative += contribution;
      return { ...e, contribution, cumulative };
    });
}

// --------------------------------------------------------------------------
//  Equation (2) — institution level
// --------------------------------------------------------------------------

export function bankEdi(loans: EdiLoan[], lambda: number): number {
  const total = loans.reduce((s, l) => s + l.outstanding, 0);
  if (total === 0) return 0;
  return loans.reduce((s, l) => s + (l.outstanding / total) * loanEdi(l.events, lambda), 0);
}

// --------------------------------------------------------------------------
//  Screening
// --------------------------------------------------------------------------

export interface ScoredLoan {
  commitmentId: string;
  institutionMsp: string;
  outstanding: number;
  currentTier: string;
  score: number;
  rescheduleCount: number;
  rsSequence: number;
  /** Median days-to-reference-date across this loan's reschedulings. */
  medianDaysOut: number | null;
  /**
   * §3.7.1: "Because the regulation caps rescheduling at three occasions, an
   * exposure approaching that limit is flagged independently of the index."
   * This fires whether or not the score is high — it is not a score at all.
   */
  capFlag: boolean;
  trail: EdiTrailPoint[];
}

export function scoreLoan(loan: EdiLoan, params: EdiParameters): ScoredLoan {
  const trail = loanEdiTrail(loan.events, params.lambda);
  const daysOut = trail.map((t) => t.daysToNextRefDate).sort((a, b) => a - b);

  return {
    commitmentId: loan.commitmentId,
    institutionMsp: loan.institutionMsp,
    outstanding: loan.outstanding,
    currentTier: loan.currentTier,
    score: trail.length > 0 ? trail[trail.length - 1]!.cumulative : 0,
    rescheduleCount: trail.length,
    rsSequence: loan.rsSequence,
    medianDaysOut: median(daysOut),
    capFlag: loan.rsSequence >= params.rsCap,
    trail,
  };
}

export interface PortfolioScore {
  institutionMsp: string;
  eBank: number;
  eStar: number;
  alert: boolean;
  loanCount: number;
  totalOutstanding: number;
  /** Ranked most-attention-first. This is a QUEUE, not a verdict. */
  ranked: ScoredLoan[];
  capFlagged: ScoredLoan[];
  disclaimer: string;
}

/**
 * Rank an institution's book for supervisory attention.
 *
 * The output is an ordering, not an accusation. Everything downstream should
 * present it that way — §7.4 #10.
 */
export function scorePortfolio(
  institutionMsp: string,
  loans: EdiLoan[],
  params: EdiParameters,
): PortfolioScore {
  const scored = loans.map((l) => scoreLoan(l, params));
  const eBank = bankEdi(loans, params.lambda);

  return {
    institutionMsp,
    eBank,
    eStar: params.eStar,
    alert: eBank > params.eStar,
    loanCount: loans.length,
    totalOutstanding: loans.reduce((s, l) => s + l.outstanding, 0),
    ranked: scored.slice().sort((a, b) => b.score - a.score),
    capFlagged: scored.filter((s) => s.capFlag),
    disclaimer: DISCLAIMER,
  };
}

// --------------------------------------------------------------------------
//  Calibration — the base rate E* must be set against
// --------------------------------------------------------------------------

export interface BaseRateBucket {
  label: string;
  lowerDays: number;
  upperDays: number;
  count: number;
  share: number;
}

/**
 * The distribution of rescheduling timing across the whole observed population.
 *
 * §3.7.1: "Practitioner testimony describes rescheduling as demand- and
 * capacity-driven rather than calendar-driven, so the timing term is a
 * HYPOTHESIS TO BE TESTED against the historical distribution at calibration,
 * not an assumed pattern."
 *
 * This is what the supervisor dashboard plots when a judge asks "won't this
 * flag every bank at quarter-end?" — the honest answer is that the threshold is
 * set against this curve, and here is the curve.
 */
export function baseRateHistogram(loans: EdiLoan[]): BaseRateBucket[] {
  const edges: Array<[string, number, number]> = [
    ['0–14 days', 0, 14],
    ['15–29 days', 15, 29],
    ['30–44 days', 30, 44],
    ['45–59 days', 45, 59],
    ['60–74 days', 60, 74],
    ['75+ days', 75, Number.MAX_SAFE_INTEGER],
  ];

  const all = loans.flatMap((l) => l.events.filter(isCounted).map((e) => e.daysToNextRefDate));
  const total = all.length;

  return edges.map(([label, lo, hi]) => {
    const count = all.filter((d) => d >= lo && d <= hi).length;
    return { label, lowerDays: lo, upperDays: hi, count, share: total === 0 ? 0 : count / total };
  });
}

/**
 * A percentile of observed loan scores, so E* can be proposed from data rather
 * than picked. Feeds a governance proposal, never applied automatically —
 * changing E* requires Council quorum (§4.6).
 */
export function suggestEStar(loans: EdiLoan[], params: EdiParameters, percentile = 0.95): number {
  const scores = loans.map((l) => loanEdi(l.events, params.lambda)).sort((a, b) => a - b);
  if (scores.length === 0) return params.eStar;
  const idx = Math.min(scores.length - 1, Math.floor(percentile * scores.length));
  return scores[idx]!;
}

// --------------------------------------------------------------------------

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// --------------------------------------------------------------------------
//  Statutory calendar
// --------------------------------------------------------------------------

const REF_MONTH_DAY: ReadonlyArray<readonly [number, number]> = [
  [3, 31],
  [6, 30],
  [9, 30],
  [12, 31],
];

/** Calendar-exact days to the next classification reference date. UTC throughout. */
export function daysToNextReferenceDate(isoDate: string): number {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) throw new Error(`not an ISO date: ${isoDate}`);
  const t = Date.UTC(y, m - 1, d);
  const candidates: number[] = [];
  for (const yr of [y, y + 1]) for (const [mm, dd] of REF_MONTH_DAY) candidates.push(Date.UTC(yr, mm - 1, dd));
  return Math.round((candidates.filter((c) => c >= t).sort((a, b) => a - b)[0]! - t) / 86_400_000);
}

export function nextReferenceDate(isoDate: string): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  const t = Date.UTC(y!, m! - 1, d!);
  const candidates: number[] = [];
  for (const yr of [y!, y! + 1]) for (const [mm, dd] of REF_MONTH_DAY) candidates.push(Date.UTC(yr, mm - 1, dd));
  return new Date(candidates.filter((c) => c >= t).sort((a, b) => a - b)[0]!).toISOString().slice(0, 10);
}
