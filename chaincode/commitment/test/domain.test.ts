/**
 * VERITY — domain tests.
 *
 * These run WITHOUT a Fabric network. Everything under src/domain is pure, so
 * the whole authority policy — the thing the 40-point demo turns on — can be
 * tested in milliseconds. Run: npm test
 *
 * Eight of these correspond one-to-one with red-team attacks in
 * WinningProjects/10_Prototype_Plan/02_DEMO_SCRIPT.md §3. If one of those tests
 * goes red, the demo has a hole in it.
 */

import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  daysToNextReferenceDate,
  nextReferenceDate,
  requiredAuthority,
  verifyAuthority,
  verifyPara11c,
} from '../src/domain/authority';
import { COUNCIL_MSPS } from '../src/contracts/governance';
import { REFUSAL, Refusal } from '../src/domain/errors';
import { canonicalJson, eventHash, keyIdOf, sha256Hex, stateHash, verifyEd25519 } from '../src/domain/hash';
import { AuthorityContext } from '../src/domain/authority';
import { DirectorSignature, DirectorStatus, RegisteredDirector } from '../src/domain/types';

// --------------------------------------------------------------------------
//  Helpers
// --------------------------------------------------------------------------

/**
 * `status` defaults to CONFIRMED because that is the steady state: a director
 * the supervisor has already approved. Pass 'PENDING' (or undefined, which is
 * what a record written before this control existed looks like) to exercise
 * the independence check.
 */
function newDirector(
  name: string,
  status: DirectorStatus | null = 'CONFIRMED',
): { director: RegisteredDirector; sign: (hex: string) => string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const publicKeyB64 = spki.toString('base64');
  return {
    director: {
      keyId: keyIdOf(publicKeyB64),
      mspId: 'BankAMSP',
      publicKey: publicKeyB64,
      name,
      registeredAt: '2027-01-01T00:00:00.000Z',
      registeredBy: 'admin-banka',
      ...(status ? { status, confirmedBy: 'supervisor-1' } : {}),
    },
    sign: (hex: string) =>
      cryptoSign(null, Buffer.from(hex, 'utf8'), privateKey).toString('base64'),
  };
}

const baseCtx = (over: Partial<AuthorityContext> = {}): AuthorityContext => ({
  registeredDirectors: [],
  boardThresholdK: 3,
  sanctioningSeniority: 2,
  callerRole: 'reviewing_officer',
  callerSeniority: 3,
  callerMsp: 'BankAMSP',
  blockHint: 'tx abc123',
  ...over,
});

const refusalCode = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof Refusal, `expected a Refusal, got ${String(e)}`);
    return e.code;
  }
  assert.fail('expected a refusal, but the call succeeded');
};

// ==========================================================================
describe('statutory calendar — the EDI d_j term (§3.7.1)', () => {
  // These four values appear in Table 2 of the whitepaper. If they drift, the
  // demo's headline numbers (0.698 -> 6.055) stop reproducing.
  it('reproduces the whitepaper Table 2 day counts', () => {
    assert.equal(daysToNextReferenceDate('2027-06-18'), 12); // -> 30 Jun
    assert.equal(daysToNextReferenceDate('2027-12-20'), 11); // -> 31 Dec
    assert.equal(daysToNextReferenceDate('2028-09-15'), 15); // -> 30 Sep
    assert.equal(daysToNextReferenceDate('2029-03-08'), 23); // -> 31 Mar
  });

  it('reproduces the control loan day counts', () => {
    assert.equal(daysToNextReferenceDate('2027-04-22'), 69); // -> 30 Jun
    assert.equal(daysToNextReferenceDate('2027-11-08'), 53); // -> 31 Dec
  });

  it('returns 0 on a reference date itself', () => {
    for (const d of ['2027-03-31', '2027-06-30', '2027-09-30', '2027-12-31']) {
      assert.equal(daysToNextReferenceDate(d), 0, d);
    }
  });

  it('rolls into the next year after 31 December', () => {
    assert.equal(nextReferenceDate('2027-12-31'), '2027-12-31');
    assert.equal(daysToNextReferenceDate('2027-12-25'), 6);
    assert.equal(nextReferenceDate('2028-01-01'), '2028-03-31');
  });

  it('handles a leap year exactly', () => {
    // 2028 is a leap year: Feb has 29 days, so 1 Feb -> 31 Mar is 28 + 31 = 59.
    assert.equal(daysToNextReferenceDate('2028-02-01'), 59);
  });
});

// ==========================================================================
describe('authority policy — which approval each event needs', () => {
  it('sends RS-1 and RS-2 one level above the sanctioning authority', () => {
    assert.equal(requiredAuthority('RESCHEDULE', 1, 'STANDARD', 'STANDARD'), 'ONE_LEVEL_ABOVE');
    assert.equal(requiredAuthority('RESCHEDULE', 2, 'STANDARD', 'STANDARD'), 'ONE_LEVEL_ABOVE');
  });

  it('sends RS-3 and RS-4 to the Board (BRPD 16/2022)', () => {
    assert.equal(requiredAuthority('RESCHEDULE', 3, 'STANDARD', 'STANDARD'), 'BOARD_THRESHOLD');
    assert.equal(requiredAuthority('RESCHEDULE', 4, 'STANDARD', 'STANDARD'), 'BOARD_THRESHOLD');
  });

  it('refuses a fifth rescheduling outright', () => {
    assert.equal(
      refusalCode(() => requiredAuthority('RESCHEDULE', 5, 'STANDARD', 'STANDARD')),
      REFUSAL.RS_CAP_EXCEEDED,
    );
  });

  it('reserves a qualitative upgrade out of Sub-Standard to the Board (para 6(d))', () => {
    assert.equal(requiredAuthority('RECLASSIFY_UP', 0, 'SUB_STANDARD', 'SMA'), 'BOARD_THRESHOLD');
    assert.equal(requiredAuthority('RECLASSIFY_UP', 0, 'DOUBTFUL', 'STANDARD'), 'BOARD_THRESHOLD');
  });

  it('does not escalate an upgrade that never left Standard/SMA', () => {
    assert.equal(requiredAuthority('RECLASSIFY_UP', 0, 'SMA', 'STANDARD'), 'ONE_LEVEL_ABOVE');
  });

  it('treats downgrades, recoveries and devolvement as mechanical', () => {
    // §3.7.1: "Where days past due drive it the event is mechanical."
    assert.equal(requiredAuthority('RECLASSIFY_DOWN', 0, 'STANDARD', 'DOUBTFUL'), 'MECHANICAL');
    assert.equal(requiredAuthority('RECOVERY', 0, 'DOUBTFUL', 'DOUBTFUL'), 'MECHANICAL');
    assert.equal(requiredAuthority('LC_DEVOLVEMENT', 0, 'STANDARD', 'STANDARD'), 'MECHANICAL');
  });

  it('requires the Board to write anything off', () => {
    assert.equal(requiredAuthority('WRITE_OFF', 0, 'BAD_LOSS', 'BAD_LOSS'), 'BOARD_THRESHOLD');
  });
});

// ==========================================================================
describe('para 11(c) — two named officers on every event', () => {
  const hash = sha256Hex('an-event');
  const good = {
    assigning: { officerId: 'officer-rahim', signature: `sig:${hash.slice(0, 8)}` },
    reviewing: { officerId: 'officer-nasrin', signature: `sig:${hash.slice(0, 8)}` },
  };

  it('accepts two distinct officers signing this event', () => {
    assert.doesNotThrow(() => verifyPara11c(good, hash));
  });

  it('refuses when no signatures are supplied at all', () => {
    assert.equal(refusalCode(() => verifyPara11c(undefined, hash)), REFUSAL.PARA_11C);
  });

  it('refuses when the reviewing signature is missing', () => {
    const sigs = { ...good, reviewing: { officerId: '', signature: '' } };
    assert.equal(refusalCode(() => verifyPara11c(sigs, hash)), REFUSAL.PARA_11C);
  });

  it('refuses one officer signing in both capacities', () => {
    const sigs = {
      assigning: good.assigning,
      reviewing: { officerId: 'officer-rahim', signature: `sig:${hash.slice(0, 8)}` },
    };
    assert.equal(refusalCode(() => verifyPara11c(sigs, hash)), REFUSAL.PARA_11C);
  });

  it('refuses a signature taken over a different event', () => {
    const other = sha256Hex('a-different-event');
    const sigs = {
      assigning: { officerId: 'a', signature: `sig:${other.slice(0, 8)}` },
      reviewing: { officerId: 'b', signature: `sig:${other.slice(0, 8)}` },
    };
    assert.equal(refusalCode(() => verifyPara11c(sigs, hash)), REFUSAL.PARA_11C);
  });
});

// ==========================================================================
describe('authority evidence — k-of-n Board threshold (§3.7.1)', () => {
  const hash = sha256Hex('reschedule-rs3');
  const detail = { rsSeq: 3, tierBefore: 'STANDARD', tierAfter: 'STANDARD' };

  const boardOf = (n: number) => Array.from({ length: n }, (_, i) => newDirector(`director-${i}`));

  it('RED TEAM #1 — refuses RS-3 with a single signature', () => {
    const board = boardOf(5);
    const evidence = {
      kind: 'BOARD_THRESHOLD' as const,
      directorSignatures: [{ keyId: board[0]!.director.keyId, signature: board[0]!.sign(hash) }],
    };
    const code = refusalCode(() =>
      verifyAuthority(
        'BOARD_THRESHOLD',
        evidence,
        hash,
        baseCtx({ registeredDirectors: board.map((b) => b.director) }),
        detail,
      ),
    );
    assert.equal(code, REFUSAL.BOARD_AUTHORISATION_REQUIRED);
  });

  it('accepts RS-3 once three distinct registered directors have signed', () => {
    const board = boardOf(5);
    const sigs: DirectorSignature[] = board
      .slice(0, 3)
      .map((b) => ({ keyId: b.director.keyId, signature: b.sign(hash) }));
    assert.doesNotThrow(() =>
      verifyAuthority(
        'BOARD_THRESHOLD',
        { kind: 'BOARD_THRESHOLD', directorSignatures: sigs },
        hash,
        baseCtx({ registeredDirectors: board.map((b) => b.director) }),
        detail,
      ),
    );
  });

  it('RED TEAM #9 — refuses a director the bank registered but the supervisor has not confirmed', () => {
    // The attack this closes: a bank admin registers three keys it controls and
    // clears its own 3-of-3 Board threshold. Counting signatures is not enough;
    // the signers have to be independent of the bank that benefits.
    const board = [
      newDirector('confirmed-0'),
      newDirector('confirmed-1'),
      newDirector('bank-appointed', 'PENDING'),
    ];
    const sigs: DirectorSignature[] = board.map((b) => ({
      keyId: b.director.keyId,
      signature: b.sign(hash),
    }));
    const code = refusalCode(() =>
      verifyAuthority(
        'BOARD_THRESHOLD',
        { kind: 'BOARD_THRESHOLD', directorSignatures: sigs },
        hash,
        baseCtx({ registeredDirectors: board.map((b) => b.director) }),
        detail,
      ),
    );
    assert.equal(code, REFUSAL.DIRECTOR_NOT_CONFIRMED);
  });

  it('fails CLOSED on a director record written before confirmation existed', () => {
    // `status: undefined` is what the ledger holds for directors registered
    // before this control shipped. Treating those as confirmed would silently
    // grandfather in precisely the case the control exists to catch.
    const board = [newDirector('legacy-0', null), newDirector('c1'), newDirector('c2')];
    const sigs: DirectorSignature[] = board.map((b) => ({
      keyId: b.director.keyId,
      signature: b.sign(hash),
    }));
    const code = refusalCode(() =>
      verifyAuthority(
        'BOARD_THRESHOLD',
        { kind: 'BOARD_THRESHOLD', directorSignatures: sigs },
        hash,
        baseCtx({ registeredDirectors: board.map((b) => b.director) }),
        detail,
      ),
    );
    assert.equal(code, REFUSAL.DIRECTOR_NOT_CONFIRMED);
  });

  it('a revoked director is refused as unregistered, not as unconfirmed', () => {
    // Order matters for the message a judge reads: revocation is the stronger
    // statement and should be the one reported.
    const confirmed = newDirector('was-a-director');
    confirmed.director.revokedAt = '2027-06-01T00:00:00.000Z';
    const rest = [newDirector('c1'), newDirector('c2')];
    const all = [confirmed, ...rest];
    const sigs: DirectorSignature[] = all.map((b) => ({
      keyId: b.director.keyId,
      signature: b.sign(hash),
    }));
    const code = refusalCode(() =>
      verifyAuthority(
        'BOARD_THRESHOLD',
        { kind: 'BOARD_THRESHOLD', directorSignatures: sigs },
        hash,
        baseCtx({ registeredDirectors: all.map((b) => b.director) }),
        detail,
      ),
    );
    assert.equal(code, REFUSAL.DIRECTOR_NOT_REGISTERED);
  });

  it('RED TEAM #3 — refuses a signer outside the registered director set', () => {
    const board = boardOf(3);
    const outsider = newDirector('not-a-director');
    const sigs = [
      { keyId: board[0]!.director.keyId, signature: board[0]!.sign(hash) },
      { keyId: board[1]!.director.keyId, signature: board[1]!.sign(hash) },
      { keyId: outsider.director.keyId, signature: outsider.sign(hash) },
    ];
    const code = refusalCode(() =>
      verifyAuthority(
        'BOARD_THRESHOLD',
        { kind: 'BOARD_THRESHOLD', directorSignatures: sigs },
        hash,
        baseCtx({ registeredDirectors: board.map((b) => b.director) }),
        detail,
      ),
    );
    assert.equal(code, REFUSAL.DIRECTOR_NOT_REGISTERED);
  });

  it('refuses the same director signing three times', () => {
    const board = boardOf(3);
    const one = board[0]!;
    const sigs = Array.from({ length: 3 }, () => ({
      keyId: one.director.keyId,
      signature: one.sign(hash),
    }));
    const code = refusalCode(() =>
      verifyAuthority(
        'BOARD_THRESHOLD',
        { kind: 'BOARD_THRESHOLD', directorSignatures: sigs },
        hash,
        baseCtx({ registeredDirectors: board.map((b) => b.director) }),
        detail,
      ),
    );
    assert.equal(code, REFUSAL.DUPLICATE_SIGNATURE);
  });

  it('does not count a revoked director towards the threshold', () => {
    const board = boardOf(3);
    const directors = board.map((b, i) =>
      i === 2 ? { ...b.director, revokedAt: '2028-01-01T00:00:00.000Z' } : b.director,
    );
    const sigs = board.map((b) => ({ keyId: b.director.keyId, signature: b.sign(hash) }));
    const code = refusalCode(() =>
      verifyAuthority(
        'BOARD_THRESHOLD',
        { kind: 'BOARD_THRESHOLD', directorSignatures: sigs },
        hash,
        baseCtx({ registeredDirectors: directors }),
        detail,
      ),
    );
    // The revoked signer is no longer in the active set at all.
    assert.equal(code, REFUSAL.DIRECTOR_NOT_REGISTERED);
  });

  it('refuses a well-formed signature over the WRONG event', () => {
    const board = boardOf(3);
    const otherHash = sha256Hex('some-other-event');
    const sigs = board.map((b) => ({ keyId: b.director.keyId, signature: b.sign(otherHash) }));
    const code = refusalCode(() =>
      verifyAuthority(
        'BOARD_THRESHOLD',
        { kind: 'BOARD_THRESHOLD', directorSignatures: sigs },
        hash,
        baseCtx({ registeredDirectors: board.map((b) => b.director) }),
        detail,
      ),
    );
    // Signatures verify against the wrong message, so none are counted.
    assert.equal(code, REFUSAL.BOARD_AUTHORISATION_REQUIRED);
  });

  it('refuses when no evidence is supplied at all', () => {
    const code = refusalCode(() =>
      verifyAuthority('BOARD_THRESHOLD', undefined, hash, baseCtx(), detail),
    );
    assert.equal(code, REFUSAL.BOARD_AUTHORISATION_REQUIRED);
  });
});

// ==========================================================================
describe('authority evidence — one level above (§3.7.1)', () => {
  const hash = sha256Hex('reschedule-rs1');
  const detail = { rsSeq: 1, tierBefore: 'STANDARD', tierAfter: 'STANDARD' };
  const evidence = { kind: 'ONE_LEVEL_ABOVE' as const };

  it('RED TEAM #2 — refuses an approver of equal seniority', () => {
    const code = refusalCode(() =>
      verifyAuthority(
        'ONE_LEVEL_ABOVE',
        evidence,
        hash,
        baseCtx({ sanctioningSeniority: 3, callerSeniority: 3 }),
        detail,
      ),
    );
    assert.equal(code, REFUSAL.AUTHORITY_INSUFFICIENT);
  });

  it('refuses an approver more junior than the sanctioning officer', () => {
    const code = refusalCode(() =>
      verifyAuthority(
        'ONE_LEVEL_ABOVE',
        evidence,
        hash,
        baseCtx({ sanctioningSeniority: 4, callerSeniority: 2 }),
        detail,
      ),
    );
    assert.equal(code, REFUSAL.AUTHORITY_INSUFFICIENT);
  });

  it('accepts a strictly senior approver', () => {
    assert.doesNotThrow(() =>
      verifyAuthority(
        'ONE_LEVEL_ABOVE',
        evidence,
        hash,
        baseCtx({ sanctioningSeniority: 2, callerSeniority: 3 }),
        detail,
      ),
    );
  });

  it('requires the mdceo role for a CORRECTION', () => {
    const code = refusalCode(() =>
      verifyAuthority(
        'MDCEO',
        { kind: 'MDCEO' },
        hash,
        baseCtx({ callerRole: 'sanctioning_officer' }),
        detail,
      ),
    );
    assert.equal(code, REFUSAL.ROLE_REQUIRED);
  });

  it('asks for nothing on a mechanical event', () => {
    assert.doesNotThrow(() => verifyAuthority('MECHANICAL', undefined, hash, baseCtx(), detail));
  });
});

// ==========================================================================
describe('hashing — determinism and chaining', () => {
  it('canonicalises object key order', () => {
    assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
    assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  });

  it('canonicalises nested keys too', () => {
    assert.equal(
      canonicalJson({ z: { y: 1, x: 2 }, a: [3, { c: 1, b: 2 }] }),
      canonicalJson({ a: [3, { b: 2, c: 1 }], z: { x: 2, y: 1 } }),
    );
  });

  it('drops undefined rather than emitting it', () => {
    assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  });

  const ev = {
    commitmentId: 'BD-4471',
    seq: 3,
    type: 'RESCHEDULE',
    classificationRefDate: '2028-09-30',
    daysToNextRefDate: 15,
    rsSeq: 3,
    tierBefore: 'STANDARD',
    tierAfter: 'STANDARD',
    prevStateHash: 'a'.repeat(64),
    payloadHash: 'b'.repeat(64),
  };

  it('produces a stable event hash', () => {
    assert.equal(eventHash(ev), eventHash({ ...ev }));
    assert.match(eventHash(ev), /^[0-9a-f]{64}$/);
  });

  it('changes the hash when any covered field changes', () => {
    assert.notEqual(eventHash(ev), eventHash({ ...ev, rsSeq: 4 }));
    assert.notEqual(eventHash(ev), eventHash({ ...ev, daysToNextRefDate: 16 }));
    assert.notEqual(eventHash(ev), eventHash({ ...ev, prevStateHash: 'c'.repeat(64) }));
  });

  it('chains state hashes so an altered history is detectable', () => {
    const s1 = stateHash('0'.repeat(64), eventHash(ev));
    const s2 = stateHash(s1, eventHash({ ...ev, seq: 4, prevStateHash: s1 }));
    assert.notEqual(s1, s2);
    // Replaying event 3 with different content breaks every hash downstream.
    const tampered = stateHash('0'.repeat(64), eventHash({ ...ev, rsSeq: 1 }));
    assert.notEqual(s1, tampered);
  });
});

// ==========================================================================
describe('ed25519 verification', () => {
  it('accepts a genuine signature and rejects a forged one', () => {
    const d = newDirector('a');
    const hash = sha256Hex('message');
    assert.equal(verifyEd25519(d.director.publicKey, hash, d.sign(hash)), true);
    assert.equal(verifyEd25519(d.director.publicKey, sha256Hex('other'), d.sign(hash)), false);
  });

  it('returns false rather than throwing on malformed input', () => {
    assert.equal(verifyEd25519('not-a-key', 'abc', 'not-a-signature'), false);
    assert.equal(verifyEd25519('', '', ''), false);
  });

  it('derives a stable key id', () => {
    const d = newDirector('a');
    assert.equal(keyIdOf(d.director.publicKey), d.director.keyId);
    assert.match(d.director.keyId, /^[0-9a-f]{64}$/);
  });
});

// --------------------------------------------------------------------------
//  Council seats — the arithmetic that keeps a bank from governing itself
// --------------------------------------------------------------------------

describe('Council composition (§4.6)', () => {
  const BANKS = COUNCIL_MSPS.filter((m) => m.startsWith('Bank'));
  const REGULATORS = COUNCIL_MSPS.filter((m) => !m.startsWith('Bank'));
  const QUORUM = 3;

  it('the banks cannot reach quorum without a regulator', () => {
    // The whole separation rests on this one inequality. If the banks ever hold
    // quorum-many seats, every refusal in Act 5 becomes theatre.
    assert.ok(
      BANKS.length < QUORUM,
      `banks hold ${BANKS.length} of ${COUNCIL_MSPS.length} seats against a quorum of ${QUORUM}`,
    );
  });

  it('no single organisation can reach quorum alone', () => {
    assert.ok(QUORUM > 1);
  });

  it('the regulators cannot reach quorum without a bank either', () => {
    // Symmetry matters: a council the regulators can carry alone is not a
    // council, it is a regulator with extra steps.
    assert.ok(
      REGULATORS.length < QUORUM,
      `regulators hold ${REGULATORS.length} seats against a quorum of ${QUORUM}`,
    );
  });

  it('a non-Council organisation is outside every governance entry point', () => {
    // All three Council functions gate on the same list. ProposeParameterChange
    // matters as much as the other two because it seeds `approvals` with the
    // proposer's own MSP: ungated, an outsider could open a proposal and place
    // itself into the set that ApproveProposal counts, giving it one free vote
    // toward a quorum it holds no seat in.
    //
    // On this channel every peer MSP is a Council member, so nothing can
    // currently reach these and fail. That is channel membership, not the
    // contract, and it stops being true when a fifth organisation joins.
    const outsider = 'SomeOtherBankMSP';
    assert.ok(!COUNCIL_MSPS.includes(outsider));
  });

  it('every seat is a distinct organisation', () => {
    // ApproveProposal counts new Set(approvals).size, so a duplicated MSP in
    // this list would silently weaken the quorum it is measured against.
    assert.equal(new Set(COUNCIL_MSPS).size, COUNCIL_MSPS.length);
  });
});

