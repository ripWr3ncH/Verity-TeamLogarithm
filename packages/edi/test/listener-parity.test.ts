/**
 * VERITY — the third cross-implementation pin.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  Equation (1) exists twice: here in packages/edi (authoritative, with the
 *  whitepaper fixtures) and in services/listener/src/edi.ts, which ships inside
 *  the listener container from its own compiled bundle.
 *
 *  The Merkle and Paillier duplications already have golden vectors. This one
 *  did not, and the failure mode is nastier than either: the listener would
 *  quietly write DIFFERENT SCORES into the read model than the ones the
 *  whitepaper publishes, and the supervisor dashboard — which reads the
 *  projection, not this package — would show them. The numbers on stage would
 *  disagree with the numbers in the submitted paper, and nothing would error.
 *
 *  This suite imports the listener's copy directly and asserts both agree.
 * ══════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  daysToNextReferenceDate as canonicalDays,
  EdiEvent,
  ILLUSTRATIVE,
  loanEdi as canonicalEdi,
} from '../src/index';
import {
  daysToNextReferenceDate as listenerDays,
  ILLUSTRATIVE as LISTENER_ILLUSTRATIVE,
  loanEdi as listenerEdi,
} from '../../../services/listener/src/edi';

const LAMBDA = ILLUSTRATIVE.lambda;

const resched = (eventDate: string, rsSeq: number): EdiEvent => ({
  type: 'RESCHEDULE',
  rsSeq,
  daysToNextRefDate: canonicalDays(eventDate),
  eventDate,
  classificationRefDate: '',
});

/** §3.7.1 Table 2 and its control. */
const LOAN_A = [
  resched('2027-06-18', 1),
  resched('2027-12-20', 2),
  resched('2028-09-15', 3),
  resched('2029-03-08', 4),
];
const LOAN_B = [resched('2027-04-22', 1), resched('2027-11-08', 2)];

describe('listener parity — equation (1) agrees across both implementations', () => {
  it('agrees on the published Table 2 score', () => {
    assert.equal(listenerEdi(LOAN_A, LAMBDA).toFixed(6), canonicalEdi(LOAN_A, LAMBDA).toFixed(6));
    assert.equal(Number(listenerEdi(LOAN_A, LAMBDA).toFixed(3)), 6.055);
  });

  it('agrees on the control score', () => {
    assert.equal(listenerEdi(LOAN_B, LAMBDA).toFixed(6), canonicalEdi(LOAN_B, LAMBDA).toFixed(6));
    assert.equal(Number(listenerEdi(LOAN_B, LAMBDA).toFixed(3)), 0.534);
  });

  it('agrees on the statutory calendar', () => {
    for (const d of [
      '2027-06-18', '2027-12-20', '2028-09-15', '2029-03-08',
      '2027-04-22', '2027-11-08', '2028-02-29', '2027-12-31', '2028-01-01',
    ]) {
      assert.equal(listenerDays(d), canonicalDays(d), d);
    }
  });

  it('agrees on which events count', () => {
    // Only RESCHEDULE with a defined RS sequence. If one side started counting
    // qualitative upgrades, every score in the read model would inflate.
    const mixed: EdiEvent[] = [
      ...LOAN_A,
      { type: 'RECLASSIFY_UP', rsSeq: 0, daysToNextRefDate: 2, eventDate: '2027-06-28', classificationRefDate: '' },
      { type: 'WRITE_OFF', rsSeq: 0, daysToNextRefDate: 1, eventDate: '2027-06-29', classificationRefDate: '' },
    ];
    assert.equal(listenerEdi(mixed, LAMBDA).toFixed(6), canonicalEdi(mixed, LAMBDA).toFixed(6));
    assert.equal(listenerEdi(mixed, LAMBDA).toFixed(6), canonicalEdi(LOAN_A, LAMBDA).toFixed(6));
  });

  it('agrees on an empty trail', () => {
    assert.equal(listenerEdi([], LAMBDA), canonicalEdi([], LAMBDA));
  });

  it('agrees across a range of lambda values, not just the illustrative one', () => {
    // lambda is Council-set, so parity must hold wherever the Council puts it.
    for (const lambda of [0.005, 0.01, 0.03, 0.05, 0.1, 0.25]) {
      assert.equal(
        listenerEdi(LOAN_A, lambda).toFixed(9),
        canonicalEdi(LOAN_A, lambda).toFixed(9),
        `lambda=${lambda}`,
      );
    }
  });

  it('agrees on the illustrative defaults', () => {
    assert.equal(LISTENER_ILLUSTRATIVE.lambda, ILLUSTRATIVE.lambda);
    assert.equal(LISTENER_ILLUSTRATIVE.eStar, ILLUSTRATIVE.eStar);
    assert.equal(LISTENER_ILLUSTRATIVE.rsCap, ILLUSTRATIVE.rsCap);
  });
});
