'use client';

/**
 * VERITY — bank officer portal. ACT 1.
 *
 * The highest-scoring ninety seconds of the prototype live on this screen.
 *
 *   1. Officer Rahim opens an exposure. Prior tier and prior-state hash are
 *      READ-ONLY — they come from committed history, and he cannot type them.
 *   2. He submits a reschedule with his signature alone.
 *   3. The chaincode refuses him BY NAME, citing the circular.
 *   4. Directors sign. It commits, and the receipt shows Bangladesh Bank's
 *      peer among the endorsers.
 *
 * Whitepaper §3.7.1: "An approval level that exists only on paper becomes a
 * condition the code checks, instead of a box the bank fills in itself."
 */

import { useCallback, useEffect, useState } from 'react';

import { RefusalPanel, ReceiptPanel } from '@/components/Outcome';
import { BoardRoster, isUsable, useBoard } from '@/components/Board';
import { useIdentity } from '@/components/Shell';
import {
  api,
  daysToNextReferenceDate,
  eventHash,
  isRefusal,
  nextReferenceDate,
  type Loan,
  type LifecycleEvent,
  type Outcome,
  type Receipt,
} from '@/lib/api';

const ZERO_HASH = '0'.repeat(64);

const EVENT_TYPES = [
  'RESCHEDULE',
  'RESTRUCTURE',
  'RECLASSIFY_UP',
  'RECLASSIFY_DOWN',
  'WRITE_OFF',
  'RECOVERY',
  'COLLATERAL_REVALUATION',
  'ASSET_PLEDGE',
  'LC_DEVOLVEMENT',
] as const;

const TIERS = ['STANDARD', 'SMA', 'SUB_STANDARD', 'DOUBTFUL', 'BAD_LOSS'] as const;

// The board is read from the ledger rather than hardcoded, because its
// CONFIRMATION STATE is the point — see components/Board.tsx.

export default function BankPortal(): React.ReactNode {
  const { current } = useIdentity();
  const identity = current?.id;

  const [loanId, setLoanId] = useState('');
  const [loan, setLoan] = useState<Loan>();
  const [trail, setTrail] = useState<LifecycleEvent[]>([]);
  const [lookupError, setLookupError] = useState<string>();

  const [eventType, setEventType] = useState<string>('RESCHEDULE');
  const [tierAfter, setTierAfter] = useState<string>('STANDARD');
  const [eventDate, setEventDate] = useState('2027-06-18');
  const [signers, setSigners] = useState<string[]>([]);

  const { board } = useBoard(current?.mspId, identity);
  const seatable = board.filter((d) => !d.revokedAt);

  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome<unknown>>();
  const [receipt, setReceipt] = useState<Receipt>();

  const loadLoan = useCallback(
    async (id: string) => {
      if (!identity || !id) return;
      setLookupError(undefined);
      try {
        const [l, t] = await Promise.all([
          api.getLoan(identity, id),
          api.getTrail(identity, id).catch(() => [] as LifecycleEvent[]),
        ]);
        setLoan(l);
        setTrail(t);
        setTierAfter(l.currentTier);
      } catch (e) {
        setLoan(undefined);
        setTrail([]);
        setLookupError((e as Error).message);
      }
    },
    [identity],
  );

  useEffect(() => {
    if (loan && identity) void loadLoan(loan.commitmentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);

  // The RS sequence this submission WOULD be, which decides the approval level.
  const nextRs = loan && eventType === 'RESCHEDULE' ? loan.rsSequence + 1 : loan?.rsSequence ?? 0;
  const boardRequired = eventType === 'RESCHEDULE' ? nextRs >= 3 : eventType === 'WRITE_OFF';
  const daysOut = daysToNextReferenceDate(eventDate);

  const submit = async (): Promise<void> => {
    if (!identity || !loan) return;
    setBusy(true);
    setOutcome(undefined);
    setReceipt(undefined);

    try {
      // The prototype binding for para 11(c): the officer signature embeds the
      // event-hash prefix, so a signature cannot be replayed onto another event.
      //
      // This hash MUST be computed exactly as the chaincode computes it —
      // canonical JSON, sorted keys, the same ten fields. Anything else is
      // refused with PARA_11C, and the refusal would be our bug rather than a
      // rule firing. See the header of eventHash() in lib/api.ts.
      //
      // Phase 3 of the plan replaces the stamp with ed25519 under a SoftHSM
      // key — do NOT call these cryptographic signatures in the demo.
      const evHash = await eventHash({
        commitmentId: loan.commitmentId,
        seq: loan.eventCount,
        type: eventType,
        classificationRefDate: nextReferenceDate(eventDate),
        daysToNextRefDate: daysOut,
        rsSeq: nextRs,
        tierBefore: loan.currentTier,
        tierAfter,
        prevStateHash: loan.prevStateHash,
        payloadHash: ZERO_HASH,
      });
      const stamp = `sig:${evHash.slice(0, 8)}`;

      const body = {
        commitmentId: loan.commitmentId,
        eventType,
        tierAfter,
        eventDate,
        prevStateHash: loan.prevStateHash,
        payloadHash: ZERO_HASH,
        signatures: {
          assigning: { officerId: 'officer-rahim', signature: stamp },
          reviewing: { officerId: 'officer-nasrin', signature: stamp },
        },
        authorityEvidence: boardRequired
          ? {
              kind: 'BOARD_THRESHOLD',
              // Real ed25519 signatures over this event hash, from the
              // directors actually ticked. Chaincode verifies each against the
              // registered set and counts DISTINCT valid signers — so ticking
              // two of three is refused with "supplied 2 of 3", not accepted.
              ...(await api.boardSign(identity, evHash, signers)),
            }
          : { kind: 'ONE_LEVEL_ABOVE' },
        note: '',
      };

      const result = await api.appendEvent(identity, body);
      setOutcome(result);
      if (!isRefusal(result)) {
        setReceipt(result.receipt);
        await loadLoan(loan.commitmentId);
      }
    } catch (e) {
      setLookupError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>Bank officer</h1>
      <p className="sub">
        Every classification event carries the two signatures BRPD 15/2024 para 11(c) already requires, and
        the approval evidence the regulation already demands. The difference is that here they are checked.
      </p>

      <div className="grid-side">
        <div>
          {/* ---------- lookup ---------- */}
          <div className="card">
            <h3>Open an exposure</h3>
            <div className="row">
              <input
                value={loanId}
                onChange={(e) => setLoanId(e.target.value.trim())}
                placeholder="commitment id, e.g. BD-4471"
                onKeyDown={(e) => e.key === 'Enter' && void loadLoan(loanId)}
                style={{ maxWidth: '22rem' }}
              />
              <button onClick={() => void loadLoan(loanId)} disabled={!identity || !loanId}>
                Open
              </button>
            </div>
            {lookupError && <p className="err">{lookupError}</p>}
          </div>

          {/* ---------- the form ---------- */}
          {loan && (
            <div className="card" style={{ marginTop: '1rem' }}>
              <h3>Append a lifecycle event</h3>

              <div className="grid-2">
                <div>
                  <label htmlFor="type">Event type</label>
                  <select
                    id="type"
                    className="field"
                    value={eventType}
                    onChange={(e) => setEventType(e.target.value)}
                  >
                    {EVENT_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>

                  <label htmlFor="date">Event date</label>
                  <input id="date" type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} />
                  <p className="hint">
                    {daysOut} days before the next statutory classification date. This is d
                    <sub>j</sub> in the index.
                  </p>

                  <label htmlFor="tier">Classification after</label>
                  <select id="tier" className="field" value={tierAfter} onChange={(e) => setTierAfter(e.target.value)}>
                    {TIERS.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label>Prior classification</label>
                  <input readOnly value={loan.currentTier} />

                  <label>Prior-state hash — from committed history</label>
                  <input readOnly value={loan.prevStateHash} />
                  <p className="hint">Read-only. The officer cannot type this; it comes from the ledger.</p>

                  <label>Rescheduling sequence this would be</label>
                  <input readOnly value={eventType === 'RESCHEDULE' ? `RS-${nextRs}` : '—'} />
                </div>
              </div>

              {/* ---------- authority ---------- */}
              <div
                style={{
                  marginTop: '1rem',
                  paddingTop: '.9rem',
                  borderTop: '1px solid var(--rule-soft)',
                }}
              >
                <h3 style={{ marginBottom: '.4rem' }}>Approval authority</h3>

                {boardRequired ? (
                  <>
                    <p style={{ fontSize: '.87rem', margin: '0 0 .5rem' }}>
                      <span className="pill amber">BOARD REQUIRED</span>{' '}
                      {eventType === 'RESCHEDULE'
                        ? `RS-${nextRs} is a third or fourth rescheduling — BRPD 16/2022 reserves it to the Board.`
                        : 'A write-off is reserved to the Board.'}{' '}
                      Three of the registered directors must sign.
                    </p>
                    <div className="row">
                      {seatable.map((d) => (
                        <label
                          key={d.keyId}
                          className="check"
                          title={
                            isUsable(d)
                              ? `confirmed by ${d.confirmedBy ?? 'the supervisor'}`
                              : 'registered by this bank, not yet confirmed by Bangladesh Bank'
                          }
                        >
                          <input
                            type="checkbox"
                            checked={signers.includes(d.name)}
                            onChange={(e) =>
                              setSigners((prev) =>
                                e.target.checked
                                  ? [...prev, d.name]
                                  : prev.filter((x) => x !== d.name),
                              )
                            }
                          />
                          {d.name}
                          {/* Deliberately still tickable when unconfirmed: the
                              refusal is the demo. A disabled checkbox would hide
                              the control instead of showing it working. */}
                          {!isUsable(d) && <span className="pill amber">unconfirmed</span>}
                        </label>
                      ))}
                      <span className="spacer" />
                      <span className="pill quiet">
                        {signers.filter((n) => seatable.some((d) => d.name === n && isUsable(d)))
                          .length}{' '}
                        of 3 confirmed signers
                      </span>
                    </div>
                  </>
                ) : (
                  <p style={{ fontSize: '.87rem', margin: 0 }}>
                    <span className="pill quiet">ONE LEVEL ABOVE</span> The approving officer must be
                    strictly senior to the sanctioning officer recorded at origination (seniority{' '}
                    {loan.sanctioningSeniority}). You are acting at seniority {current?.seniority}.
                  </p>
                )}
              </div>

              <div className="row" style={{ marginTop: '1rem' }}>
                <button onClick={() => void submit()} disabled={busy || !identity}>
                  {busy ? 'Submitting…' : 'Submit to the ledger'}
                </button>
                <span className="hint" style={{ margin: 0 }}>
                  requires endorsement from this bank&rsquo;s peer <em>and</em> Bangladesh Bank&rsquo;s
                </span>
              </div>

              {outcome && isRefusal(outcome) && <RefusalPanel refusal={outcome} />}
              {receipt && <ReceiptPanel receipt={receipt} result={(outcome as { result?: unknown })?.result} />}
            </div>
          )}
        </div>

        <BoardRoster mspId={current?.mspId} identity={identity} />

        {/* ---------- trail ---------- */}
        <div className="card">
          <h3>Committed history</h3>
          {!loan && <p className="empty">Open an exposure to see its trail.</p>}
          {loan && trail.length === 0 && <p className="empty">No events yet.</p>}
          {trail.length > 0 && (
            <div className="scroller">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Type</th>
                    <th>RS</th>
                    <th className="num">Days out</th>
                  </tr>
                </thead>
                <tbody>
                  {trail.map((e) => (
                    <tr key={e.seq}>
                      <td className="mono">{e.seq}</td>
                      <td style={{ fontSize: '.8rem' }}>{e.type}</td>
                      <td className="mono">{e.rsSeq > 0 ? `RS-${e.rsSeq}` : '—'}</td>
                      <td className="num mono">{e.type === 'RESCHEDULE' ? e.daysToNextRefDate : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
