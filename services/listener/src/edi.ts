/**
 * VERITY — the EDI subset the listener needs.
 *
 * DUPLICATION NOTICE: mirrors packages/edi. The listener runs as its own
 * container from a compiled bundle, and keeping it self-contained avoids a
 * cross-package build step in the demo path. The authoritative implementation —
 * and the tests that pin it to the whitepaper's published numbers — is
 * packages/edi. If you change equation (1), change it there first.
 */

export const ILLUSTRATIVE = { lambda: 0.03, eStar: 0.5, rsCap: 3 } as const;

export interface EdiEvent {
  type: string;
  rsSeq: number;
  daysToNextRefDate: number;
  eventDate: string;
  classificationRefDate: string;
}

/** Equation (1): E_i = sum over reschedulings of r_j * exp(-lambda * d_j). */
export function loanEdi(events: EdiEvent[], lambda: number): number {
  return events
    .filter((e) => e.type === 'RESCHEDULE' && e.rsSeq > 0)
    .reduce((sum, e) => sum + e.rsSeq * Math.exp(-lambda * e.daysToNextRefDate), 0);
}

const REF_MONTH_DAY: ReadonlyArray<readonly [number, number]> = [
  [3, 31],
  [6, 30],
  [9, 30],
  [12, 31],
];

export function daysToNextReferenceDate(isoDate: string): number {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return 0;
  const t = Date.UTC(y, m - 1, d);
  const candidates: number[] = [];
  for (const yr of [y, y + 1]) for (const [mm, dd] of REF_MONTH_DAY) candidates.push(Date.UTC(yr, mm - 1, dd));
  return Math.round((candidates.filter((c) => c >= t).sort((a, b) => a - b)[0]! - t) / 86_400_000);
}
