/**
 * VERITY — seed generator tests.
 *
 * Two things must hold, and both are demo-critical:
 *
 *  1. DETERMINISM. The same seed produces byte-identical data. A demo that
 *     cannot be run twice will be run once, badly — and the screenshots on the
 *     poster have to match what is on screen.
 *
 *  2. AN HONEST BASE RATE. The ordinary population must reschedule near
 *     quarter-end often enough that the base-rate histogram in Act 2 is
 *     evidence rather than a prop, while the planted cases still separate.
 *     §3.7.1 concedes this openly; the generator has to earn the concession.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  baseRateHistogram,
  daysToNextReferenceDate,
  EdiLoan,
  ILLUSTRATIVE,
  loanEdi,
  scorePortfolio,
} from '../../packages/edi/src/index';
import { generate, TABLE_2_CONTROL, TABLE_2_EVERGREENING } from '../src/generate';
import { Rng } from '../src/rng';

const PARAMS = { lambda: ILLUSTRATIVE.lambda, eStar: ILLUSTRATIVE.eStar, rsCap: ILLUSTRATIVE.rsCap };

/** Convert seed output into the shape the EDI engine consumes. */
const toEdiLoans = (loans: ReturnType<typeof generate>['loans']): EdiLoan[] =>
  loans.map((l) => ({
    commitmentId: l.commitmentId,
    institutionMsp: l.institutionMsp,
    outstanding: l.outstanding,
    currentTier: l.currentTier,
    rsSequence: l.rsSequence,
    events: l.events.map((e) => ({
      type: e.type,
      rsSeq: e.rsSeq,
      daysToNextRefDate: daysToNextReferenceDate(e.eventDate),
      eventDate: e.eventDate,
      classificationRefDate: '',
    })),
  }));

// ==========================================================================
describe('deterministic randomness', () => {
  it('produces the same sequence for the same seed', () => {
    const a = new Rng('verity');
    const b = new Rng('verity');
    for (let i = 0; i < 100; i++) assert.equal(a.next(), b.next());
  });

  it('produces a different sequence for a different seed', () => {
    assert.notEqual(new Rng('a').next(), new Rng('b').next());
  });

  it('respects weighted distributions', () => {
    const rng = new Rng('weights');
    const counts: Record<string, number> = { x: 0, y: 0 };
    for (let i = 0; i < 10_000; i++) counts[rng.weighted({ x: 0.8, y: 0.2 })]!++;
    assert.ok(counts['x']! > 7500 && counts['x']! < 8500, `x drawn ${counts['x']} times`);
  });
});

// ==========================================================================
describe('the whole dataset is reproducible', () => {
  it('is byte-identical across runs with the same seed', () => {
    const a = generate({ seed: 'demo', loansPerBank: 60, depositorsPerBank: 40 });
    const b = generate({ seed: 'demo', loansPerBank: 60, depositorsPerBank: 40 });
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  it('differs with a different seed', () => {
    const a = generate({ seed: 'one', loansPerBank: 60, depositorsPerBank: 40 });
    const b = generate({ seed: 'two', loansPerBank: 60, depositorsPerBank: 40 });
    assert.notEqual(JSON.stringify(a), JSON.stringify(b));
  });

  it('labels itself synthetic in the payload', () => {
    // So no screenshot, export or API response can be mistaken for real data.
    assert.equal(generate({ loansPerBank: 10, depositorsPerBank: 10 }).synthetic, true);
  });
});

// ==========================================================================
describe('the whitepaper fixtures are present and exact', () => {
  const data = generate({ loansPerBank: 80, depositorsPerBank: 40 });

  it('includes the Table 2 evergreening exposure, unaltered', () => {
    const loan = data.loans.find((l) => l.commitmentId === 'BD-4471');
    assert.ok(loan, 'BD-4471 must be in every generated dataset');
    assert.deepEqual(loan, TABLE_2_EVERGREENING);
  });

  it('includes the control, unaltered', () => {
    const loan = data.loans.find((l) => l.commitmentId === 'BD-5512');
    assert.ok(loan);
    assert.deepEqual(loan, TABLE_2_CONTROL);
  });

  it('scores them at the published values', () => {
    const [ever, control] = [TABLE_2_EVERGREENING, TABLE_2_CONTROL].map((l) =>
      loanEdi(
        l.events.map((e) => ({
          type: e.type,
          rsSeq: e.rsSeq,
          daysToNextRefDate: daysToNextReferenceDate(e.eventDate),
          eventDate: e.eventDate,
          classificationRefDate: '',
        })),
        PARAMS.lambda,
      ),
    );
    assert.equal(Number(ever!.toFixed(3)), 6.055);
    assert.equal(Number(control!.toFixed(3)), 0.534);
    assert.equal(Number((ever! / control!).toFixed(1)), 11.3);
  });
});

// ==========================================================================
describe('the base rate is honest', () => {
  const data = generate({ seed: 'base-rate', loansPerBank: 400, depositorsPerBank: 50 });
  const ordinary = toEdiLoans(data.loans.filter((l) => !l.narrative));

  it('leaves most exposures untouched', () => {
    const withNone = ordinary.filter((l) => l.rsSequence === 0).length;
    const share = withNone / ordinary.length;
    assert.ok(share > 0.6 && share < 0.8, `${(share * 100).toFixed(1)}% never rescheduled`);
  });

  it('ORDINARY loans do cluster near period-end — the concession §3.7.1 makes', () => {
    // If nothing but the planted cases ever rescheduled near a reference date,
    // the histogram in Act 2 would prove nothing.
    const hist = baseRateHistogram(ordinary);
    const nearQuarterEnd = hist[0]!.share + hist[1]!.share;
    assert.ok(
      nearQuarterEnd > 0.1,
      `only ${(nearQuarterEnd * 100).toFixed(1)}% of ordinary reschedulings fall within 30 days — ` +
        'too clean to be credible',
    );
    assert.ok(
      nearQuarterEnd < 0.5,
      `${(nearQuarterEnd * 100).toFixed(1)}% within 30 days — that is not a base rate, that is the signal`,
    );
  });

  it('and the planted cases still separate from that population', () => {
    const scores = ordinary.map((l) => loanEdi(l.events, PARAMS.lambda)).sort((a, b) => b - a);
    const p95 = scores[Math.floor(scores.length * 0.05)]!;
    const evergreening = loanEdi(
      TABLE_2_EVERGREENING.events.map((e) => ({
        type: e.type,
        rsSeq: e.rsSeq,
        daysToNextRefDate: daysToNextReferenceDate(e.eventDate),
        eventDate: e.eventDate,
        classificationRefDate: '',
      })),
      PARAMS.lambda,
    );
    assert.ok(
      evergreening > p95 * 2,
      `Table 2 loan scores ${evergreening.toFixed(3)} against a 95th percentile of ${p95.toFixed(3)}`,
    );
  });

  it('ranks the planted evergreening cases at the top of the supervisor queue', () => {
    const bankA = toEdiLoans(data.loans.filter((l) => l.institutionMsp === 'BankAMSP'));
    const portfolio = scorePortfolio('BankAMSP', bankA, PARAMS);
    const topTen = portfolio.ranked.slice(0, 10).map((r) => r.commitmentId);
    assert.ok(topTen.includes('BD-4471'), `BD-4471 missing from the top ten: ${topTen.join(', ')}`);
  });

  it('respects the statutory cap — nothing reaches RS-5', () => {
    for (const loan of data.loans) {
      assert.ok(loan.rsSequence <= 4, `${loan.commitmentId} reached RS-${loan.rsSequence}`);
    }
  });
});

// ==========================================================================
describe('Module II — the nominee structure', () => {
  const data = generate({ seed: 'groups', loansPerBank: 40, depositorsPerBank: 20 });

  it('carries G-0447 with the whitepaper exposures', () => {
    const group = data.groups.find((g) => g.groupToken === 'G-0447');
    assert.ok(group);
    assert.deepEqual(group.exposureByBank, { BankAMSP: 520, BankBMSP: 430, BankCMSP: 290 });
    assert.equal(group.breachesSystemLimit, true);
  });

  it('sums to the 1,240 crore the ceremony decrypts', () => {
    const group = data.groups.find((g) => g.groupToken === 'G-0447')!;
    assert.equal(Object.values(group.exposureByBank).reduce((s, v) => s + v, 0), 1240);
  });

  it('keeps every single-bank position below a 25% limit on Tk 2,500 crore capital', () => {
    // §1.1: "A group borrowing through nominees across many banks may sit below
    // all of them." Each leg must be individually unremarkable.
    const group = data.groups.find((g) => g.groupToken === 'G-0447')!;
    for (const [bank, exposure] of Object.entries(group.exposureByBank)) {
      assert.ok(exposure < 625, `${bank} at ${exposure} crore would breach its own limit`);
    }
  });
});

// ==========================================================================
describe('Module III — the depositor population', () => {
  const data = generate({ seed: 'depositors', loansPerBank: 20, depositorsPerBank: 500 });

  it('protects about 93% of accounts, per the Deposit Protection Act 2026', () => {
    const share = data.depositors.filter((d) => d.priorityClass === 'PROTECTED').length / data.depositors.length;
    assert.ok(share > 0.88 && share < 0.97, `${(share * 100).toFixed(1)}% protected`);
  });

  it('but leaves most deposit VALUE above the Tk 2 lakh ceiling', () => {
    // §3.7.4: "What it leaves open is the balances above Tk 2 lakh, where most
    // deposit value sits." The demo's point depends on this being true here too.
    const total = data.depositors.reduce((s, d) => s + BigInt(d.balancePoisha), 0n);
    const unprotected = data.depositors
      .filter((d) => d.priorityClass !== 'PROTECTED')
      .reduce((s, d) => s + BigInt(d.balancePoisha), 0n);
    const share = Number((unprotected * 100n) / total);
    assert.ok(share > 50, `only ${share}% of deposit value sits above the ceiling`);
  });

  it('holds balances as integer poisha strings, never floats', () => {
    for (const d of data.depositors.slice(0, 50)) {
      assert.match(d.balancePoisha, /^\d+$/);
    }
  });
});
