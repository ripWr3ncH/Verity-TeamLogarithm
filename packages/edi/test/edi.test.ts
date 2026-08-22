/**
 * VERITY — EDI engine tests.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE WHITEPAPER FIXTURES
 *
 *  Table 2 of §3.7.1 is the centrepiece of Act 2 — the split screen where four
 *  quarters of CL-1 say "Unclassified" beside a score climbing 0.698 -> 6.055.
 *  A forbearance control reaches 0.534, an 11.3x separation.
 *
 *  Those numbers are PUBLISHED. They are in the whitepaper the judges have
 *  already read. If this engine disagrees with them by so much as a rounding
 *  step, the demo contradicts the submission.
 *
 *  These tests are the guard. Do not adjust an expected value to make one pass.
 * ══════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  baseRateHistogram,
  bankEdi,
  daysToNextReferenceDate,
  DISCLAIMER,
  EdiEvent,
  EdiLoan,
  EdiParameters,
  ILLUSTRATIVE,
  loanEdi,
  loanEdiTrail,
  nextReferenceDate,
  scoreLoan,
  scorePortfolio,
  suggestEStar,
} from '../src/index';

const PARAMS: EdiParameters = {
  lambda: ILLUSTRATIVE.lambda,
  eStar: ILLUSTRATIVE.eStar,
  rsCap: ILLUSTRATIVE.rsCap,
};

/** Build a RESCHEDULE event, deriving d_j from the real date the way the ledger does. */
const resched = (eventDate: string, rsSeq: number): EdiEvent => ({
  type: 'RESCHEDULE',
  rsSeq,
  daysToNextRefDate: daysToNextReferenceDate(eventDate),
  eventDate,
  classificationRefDate: nextReferenceDate(eventDate),
});

/** Loan A — §3.7.1 Table 2. Reported Unclassified in every one of these quarters. */
const LOAN_A: EdiLoan = {
  commitmentId: 'BD-4471',
  institutionMsp: 'BankAMSP',
  outstanding: 100_00_00_000, // Tk 100 crore
  currentTier: 'STANDARD',
  rsSequence: 4,
  events: [
    resched('2027-06-18', 1), // 12 days before 30 Jun
    resched('2027-12-20', 2), // 11 days before 31 Dec
    resched('2028-09-15', 3), // 15 days before 30 Sep
    resched('2029-03-08', 4), // 23 days before 31 Mar
  ],
};

/** Loan B — the control. Ordinary forbearance over the same period. */
const LOAN_B: EdiLoan = {
  commitmentId: 'BD-5512',
  institutionMsp: 'BankAMSP',
  outstanding: 100_00_00_000,
  currentTier: 'STANDARD',
  rsSequence: 2,
  events: [
    resched('2027-04-22', 1), // 69 days out
    resched('2027-11-08', 2), // 53 days out
  ],
};

// ==========================================================================
describe('statutory calendar', () => {
  it('reproduces the Table 2 day counts', () => {
    assert.equal(daysToNextReferenceDate('2027-06-18'), 12);
    assert.equal(daysToNextReferenceDate('2027-12-20'), 11);
    assert.equal(daysToNextReferenceDate('2028-09-15'), 15);
    assert.equal(daysToNextReferenceDate('2029-03-08'), 23);
  });

  it('reproduces the control loan day counts', () => {
    assert.equal(daysToNextReferenceDate('2027-04-22'), 69);
    assert.equal(daysToNextReferenceDate('2027-11-08'), 53);
  });

  it('names the reference date each event is measured against', () => {
    assert.equal(nextReferenceDate('2027-06-18'), '2027-06-30');
    assert.equal(nextReferenceDate('2029-03-08'), '2029-03-31');
  });
});

// ==========================================================================
describe('equation (1) — the published Table 2 series', () => {
  const trail = loanEdiTrail(LOAN_A.events, PARAMS.lambda);

  it('reproduces 0.698 -> 2.136 -> 4.048 -> 6.055', () => {
    const expected = [0.698, 2.136, 4.048, 6.055];
    trail.forEach((point, i) => {
      assert.equal(
        Number(point.cumulative.toFixed(3)),
        expected[i],
        `after RS-${point.rsSeq} (${point.daysToNextRefDate} days out)`,
      );
    });
  });

  it('reproduces the control loan at 0.534', () => {
    assert.equal(Number(loanEdi(LOAN_B.events, PARAMS.lambda).toFixed(3)), 0.534);
  });

  it('reproduces the 11.3x separation the quarterly return does not carry', () => {
    const separation = loanEdi(LOAN_A.events, PARAMS.lambda) / loanEdi(LOAN_B.events, PARAMS.lambda);
    assert.equal(Number(separation.toFixed(1)), 11.3);
  });

  it('halves the timing weight every 23.1 days', () => {
    assert.equal(Number((Math.LN2 / PARAMS.lambda).toFixed(1)), 23.1);
  });
});

// ==========================================================================
describe('what the index counts, and what it does not', () => {
  it('counts rescheduling events only', () => {
    // §3.7.1: "computed over rescheduling events only, where the RS sequence
    // number is defined. Qualitative upgrades are watched through the
    // authority-evidence trail."
    const noise: EdiEvent[] = [
      { type: 'RECLASSIFY_UP', rsSeq: 0, daysToNextRefDate: 3, eventDate: '2027-06-27', classificationRefDate: '2027-06-30' },
      { type: 'COLLATERAL_REVALUATION', rsSeq: 0, daysToNextRefDate: 1, eventDate: '2027-06-29', classificationRefDate: '2027-06-30' },
      { type: 'WRITE_OFF', rsSeq: 0, daysToNextRefDate: 2, eventDate: '2027-06-28', classificationRefDate: '2027-06-30' },
    ];
    assert.equal(loanEdi(noise, PARAMS.lambda), 0);
  });

  it('scores an untouched exposure at zero', () => {
    assert.equal(loanEdi([], PARAMS.lambda), 0);
  });

  it('orders the trail by date regardless of input order', () => {
    const shuffled = [LOAN_A.events[2]!, LOAN_A.events[0]!, LOAN_A.events[3]!, LOAN_A.events[1]!];
    const trail = loanEdiTrail(shuffled, PARAMS.lambda);
    assert.deepEqual(trail.map((t) => t.rsSeq), [1, 2, 3, 4]);
    assert.equal(Number(trail[3]!.cumulative.toFixed(3)), 6.055);
  });
});

// ==========================================================================
describe('the adaptive bank (§3.7.1)', () => {
  // "A bank that knows λ can move reschedulings away from quarter-end and
  //  collapse the timing term. Three things limit the gain."
  const evasive: EdiEvent[] = [
    resched('2027-05-02', 1), // 59 days out
    resched('2027-10-05', 2), // 87 days out
    resched('2028-07-14', 3), // 78 days out
    resched('2029-01-20', 4), // 70 days out
  ];

  it('the index does get weaker under evasion — we say so rather than hide it', () => {
    assert.ok(loanEdi(evasive, PARAMS.lambda) < loanEdi(LOAN_A.events, PARAMS.lambda));
  });

  it('but repetition still accumulates, because r_j does not depend on timing', () => {
    const once = [resched('2027-05-02', 1)];
    assert.ok(loanEdi(evasive, PARAMS.lambda) > loanEdi(once, PARAMS.lambda) * 3);
  });

  it('and the three-occasion cap flags independently of the score', () => {
    const scored = scoreLoan({ ...LOAN_A, events: evasive, rsSequence: 4 }, PARAMS);
    assert.equal(scored.capFlag, true, 'RS-4 must flag whatever the index says');
    // The cap flag is not derived from the score at all.
    const quiet = scoreLoan({ ...LOAN_B, events: [], rsSequence: 3 }, PARAMS);
    assert.equal(quiet.score, 0);
    assert.equal(quiet.capFlag, true);
  });
});

// ==========================================================================
describe('equation (2) — institution level', () => {
  it('weights by outstanding balance', () => {
    const loans: EdiLoan[] = [
      { ...LOAN_A, outstanding: 100 },
      { ...LOAN_B, commitmentId: 'x', outstanding: 900 },
    ];
    const expected =
      (100 / 1000) * loanEdi(LOAN_A.events, PARAMS.lambda) +
      (900 / 1000) * loanEdi(LOAN_B.events, PARAMS.lambda);
    assert.equal(bankEdi(loans, PARAMS.lambda).toFixed(6), expected.toFixed(6));
  });

  it('weights sum to one, so a large clean book dilutes a small dirty one', () => {
    const concentrated = bankEdi([{ ...LOAN_A, outstanding: 1000 }], PARAMS.lambda);
    const diluted = bankEdi(
      [
        { ...LOAN_A, outstanding: 100 },
        { ...LOAN_B, commitmentId: 'clean', outstanding: 900, events: [] },
      ],
      PARAMS.lambda,
    );
    assert.ok(diluted < concentrated);
    assert.equal(Number(diluted.toFixed(4)), Number((concentrated * 0.1).toFixed(4)));
  });

  it('returns zero for an empty book rather than dividing by zero', () => {
    assert.equal(bankEdi([], PARAMS.lambda), 0);
    assert.equal(bankEdi([{ ...LOAN_A, outstanding: 0 }], PARAMS.lambda), 0);
  });

  it('alerts a portfolio above E* and not one below', () => {
    const dirty = scorePortfolio('BankAMSP', [{ ...LOAN_A, outstanding: 1000 }], PARAMS);
    assert.equal(dirty.alert, true);

    const clean = scorePortfolio('BankBMSP', [{ ...LOAN_B, outstanding: 1000 }], PARAMS);
    assert.equal(clean.alert, true, 'E=0.534 is just above E*=0.50 — the control is not innocent, only ordinary');

    const quiet = scorePortfolio('BankBMSP', [{ ...LOAN_B, outstanding: 1000, events: [] }], PARAMS);
    assert.equal(quiet.alert, false);
  });
});

// ==========================================================================
describe('screening output is a queue, not a verdict', () => {
  const portfolio = scorePortfolio(
    'BankAMSP',
    [
      { ...LOAN_A, outstanding: 100 },
      { ...LOAN_B, outstanding: 100 },
      { ...LOAN_B, commitmentId: 'BD-9001', outstanding: 100, rsSequence: 0, events: [] },
    ],
    PARAMS,
  );

  it('ranks most-attention-first', () => {
    assert.deepEqual(portfolio.ranked.map((r) => r.commitmentId), ['BD-4471', 'BD-5512', 'BD-9001']);
  });

  it('carries the disclaimer in the payload, so no UI can forget it', () => {
    assert.equal(portfolio.disclaimer, DISCLAIMER);
    assert.match(portfolio.disclaimer, /not a finding of misconduct/);
    assert.match(portfolio.disclaimer, /measured system-wide base rate/);
  });

  it('reports median timing, so a reviewer sees WHY a score is high', () => {
    const a = portfolio.ranked[0]!;
    assert.equal(a.medianDaysOut, 13.5); // median of 12, 11, 15, 23
    assert.equal(a.rescheduleCount, 4);
  });

  it('lists cap-flagged exposures separately from the ranking', () => {
    assert.deepEqual(portfolio.capFlagged.map((c) => c.commitmentId), ['BD-4471']);
  });
});

// ==========================================================================
describe('calibration against the base rate (§3.7.1)', () => {
  // The honest answer to "won't this flag every bank at quarter-end?"
  const population: EdiLoan[] = [
    { ...LOAN_A, commitmentId: 'a' },
    { ...LOAN_B, commitmentId: 'b' },
    { ...LOAN_B, commitmentId: 'c', events: [resched('2027-05-15', 1)] }, // 46 days
    { ...LOAN_B, commitmentId: 'd', events: [resched('2027-08-01', 1)] }, // 60 days
    { ...LOAN_B, commitmentId: 'e', events: [resched('2027-02-10', 1)] }, // 49 days
  ];

  it('bins rescheduling timing across the whole population', () => {
    const hist = baseRateHistogram(population);
    assert.equal(hist.length, 6);
    assert.equal(hist.reduce((s, b) => s + b.count, 0), 9); // 4 + 2 + 1 + 1 + 1
    assert.equal(Number(hist.reduce((s, b) => s + b.share, 0).toFixed(6)), 1);
  });

  it('shows the evergreening loan clustered in the first month', () => {
    // Loan A's reschedulings sit 12, 11, 15 and 23 days out, so two fall in
    // 0-14 and two in 15-29. Every one of them is inside a month of a statutory
    // reference date, and nothing lands beyond 30 days.
    const hist = baseRateHistogram([{ ...LOAN_A, commitmentId: 'a' }]);
    assert.equal(hist[0]!.count, 2); // 12, 11
    assert.equal(hist[1]!.count, 2); // 15, 23
    assert.equal(hist.slice(2).reduce((s, b) => s + b.count, 0), 0);

    // The control loan, by contrast, sits entirely beyond 45 days.
    const control = baseRateHistogram([{ ...LOAN_B, commitmentId: 'b' }]);
    assert.equal(control[0]!.count + control[1]!.count, 0);
    assert.equal(control[3]!.count, 1); // 53 days
    assert.equal(control[4]!.count, 1); // 69 days
  });

  it('proposes E* from observed scores rather than from zero', () => {
    const suggested = suggestEStar(population, PARAMS, 0.95);
    assert.ok(suggested > 0, 'must be set against the measured base rate, not against zero');
    assert.ok(suggested <= loanEdi(LOAN_A.events, PARAMS.lambda));
  });

  it('falls back to the current E* on an empty population', () => {
    assert.equal(suggestEStar([], PARAMS), PARAMS.eStar);
  });
});
