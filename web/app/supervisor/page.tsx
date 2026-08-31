'use client';

/**
 * VERITY — Bangladesh Bank portal. ACTS 2 AND 5.
 *
 * ── Act 2, the split screen ──────────────────────────────────────────────
 * Four quarters of CL-1 reporting "Unclassified" beside an index climbing
 * 0.698 → 6.055 on the same exposure. Whitepaper §3.7.1 Table 2:
 *
 *   "Every quarterly return in this sequence reports the exposure as
 *    unclassified. The right-hand column is the same loan."
 *
 * ── Act 5, governance ────────────────────────────────────────────────────
 * A bank proposes raising its own alert threshold and is refused at 1 of 3.
 * The Council quorum moves it, and the change is recorded with named approvers.
 *
 * ── The disclaimer is not optional ───────────────────────────────────────
 * §7.4 #10: the EDI is a screening indicator, NOT a finding of misconduct.
 * It is rendered above every score on this page, permanently.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { BoardConfirmation } from '@/components/Board';
import { RefusalPanel } from '@/components/Outcome';
import { BaseRateChart, SupervisoryQueue } from '@/components/Queue';
import { ReconciliationPanel } from '@/components/Reconciliation';
import { RebuildPanel } from '@/components/Rebuild';
import { ReschedulingTimeline } from '@/components/Timeline';
import { useIdentity } from '@/components/Shell';
import {
  api,
  isRefusal,
  type LifecycleEvent,
  type Loan,
  type Outcome,
  type Parameter,
} from '@/lib/api';

const DISCLAIMER =
  'Screening indicator, not a finding of misconduct. Synthetic data. λ and E* are illustrative and ' +
  'Council-set at calibration; thresholds must be set against the measured system-wide base rate, ' +
  'not against zero. (§3.7.1, §7.4 #10)';

interface TrailPoint extends LifecycleEvent {
  contribution: number;
  cumulative: number;
}

/** Equation (1), §3.7.1. λ is read from the ledger, never hard-coded. */
function ediTrail(events: LifecycleEvent[], lambda: number): TrailPoint[] {
  let cumulative = 0;
  return events
    .filter((e) => e.type === 'RESCHEDULE' && e.rsSeq > 0)
    .slice()
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .map((e) => {
      const contribution = e.rsSeq * Math.exp(-lambda * e.daysToNextRefDate);
      cumulative += contribution;
      return { ...e, contribution, cumulative };
    });
}

export default function SupervisorPortal(): React.ReactNode {
  const { current } = useIdentity();
  const identity = current?.id;

  const [params, setParams] = useState<Parameter[]>([]);
  const [loanId, setLoanId] = useState('');
  const [loan, setLoan] = useState<Loan>();
  const [trail, setTrail] = useState<LifecycleEvent[]>([]);
  const [accessLog, setAccessLog] = useState<Array<{ timestamp: string; actorMsp: string; resource: string; action: string }>>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const detailRef = useRef<HTMLDivElement>(null);

  const [proposalId, setProposalId] = useState('');
  const [proposedEStar, setProposedEStar] = useState('1.117');
  const [govOutcome, setGovOutcome] = useState<Outcome<unknown>>();

  const lambda = params.find((p) => p.name === 'lambda')?.value ?? 0.03;
  const eStar = params.find((p) => p.name === 'eStar')?.value ?? 0.5;

  const refresh = useCallback(async () => {
    if (!identity) return;
    try {
      setParams(await api.parameters(identity));
      setAccessLog(await api.accessLog(identity).catch(() => []));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [identity]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * The supervisory read is a SUBMIT transaction, because it writes an access
   * log entry. §4.7: "supervisory queries leave a permanent trace." Opening an
   * exposure here costs a block, on purpose — oversight is watched too.
   */
  const supervise = async (id: string): Promise<void> => {
    if (!identity || !id) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.supervise(identity, id);
      if (isRefusal(result)) {
        setError(result.message);
      } else {
        setLoan(result.result.loan);
        setTrail(result.result.events);
        // Bring the detail into view.
        //
        // The panel renders below the reconciliation table, so clicking a row
        // near the top of a long page appeared to do nothing at all. On stage
        // that means clicking again — and every supervisory read is a SUBMIT
        // transaction that costs a block, so a silent click is not free.
        requestAnimationFrame(() => {
          detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        await refresh();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const points = ediTrail(trail, lambda);
  const score = points.length > 0 ? points[points.length - 1]!.cumulative : 0;

  const runGovernance = async (step: 'propose' | 'approve' | 'activate'): Promise<void> => {
    if (!identity) return;
    setBusy(true);
    setGovOutcome(undefined);
    try {
      const id = proposalId || `gov-${Date.now().toString(36)}`;
      if (!proposalId) setProposalId(id);

      const result =
        step === 'propose'
          ? await api.propose(identity, {
              proposalId: id,
              parameter: 'eStar',
              proposedValue: Number(proposedEStar),
              rationale: '95th percentile of the measured base rate',
            })
          : step === 'approve'
            ? await api.approve(identity, id)
            : await api.activate(identity, id);

      setGovOutcome(result);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>Bangladesh Bank</h1>
      <p className="sub">
        The Evergreening Detection Index measures rescheduling against the statutory quarterly calendar —
        the timing and repetition the CL-1 return does not carry.
      </p>

      <div className="disclaimer">{DISCLAIMER}</div>

      {/* ---------- Council parameters ---------- */}
      <div className="card">
        <h3>Council-set parameters</h3>
        <div className="row">
          {params.length === 0 && <span className="empty">Not loaded.</span>}
          {params.map((p) => (
            <span key={p.name} className="cert">
              {p.name} = <b>{p.value}</b>
              {p.proposalId !== 'GENESIS' && (
                <span style={{ color: 'var(--ink-3)' }}> · {p.proposalId}</span>
              )}
            </span>
          ))}
        </div>
        <p className="hint">
          §4.6 — no participant can tune the system to its own advantage. Changing one needs a Council quorum.
        </p>
      </div>

      {/* ---------- Act 0: what the return leaves out ---------- */}
      <h2>The quarterly return, and what it omits</h2>
      <ReconciliationPanel identity={identity} onOpen={(id) => { setLoanId(id); void supervise(id); }} />

      {/* ---------- Act 2 ---------- */}
      <h2>The book</h2>
      <div className="grid-side">
        <SupervisoryQueue identity={identity} eStar={eStar} onOpen={(id) => { setLoanId(id); void supervise(id); }} selected={loan?.commitmentId} />
        <BaseRateChart identity={identity} />
      </div>

      <h2>Open an exposure</h2>
      <div className="card">
        <div className="row">
          <input
            value={loanId}
            onChange={(e) => setLoanId(e.target.value.trim())}
            placeholder="commitment id, e.g. BD-4471"
            onKeyDown={(e) => e.key === 'Enter' && void supervise(loanId)}
            style={{ maxWidth: '22rem' }}
          />
          <button onClick={() => void supervise(loanId)} disabled={busy || !identity || !loanId}>
            {busy ? 'Reading…' : 'Open — this read is logged'}
          </button>
          <span className="hint" style={{ margin: 0 }}>
            a supervisory read is a submit transaction; it leaves a permanent trace (§4.7)
          </span>
        </div>
        {error && <p className="err">{error}</p>}
      </div>

      {loan && (
        <div ref={detailRef}>
          <h2>
            {loan.commitmentId} · {loan.institutionMsp}
          </h2>

          {/* Lead with the numbers. A supervisor scanning a queue needs the
              score, the count and the cap flag before any table. */}
          <div className="grid-3" style={{ marginBottom: '1.1rem' }}>
            <div className="card">
              <div className={score > eStar ? 'stat alert' : 'stat good'}>
                <span className="value">{score.toFixed(3)}</span>
                <span className="label">
                  E{score > eStar ? ` — above E* ${eStar}` : ` — at or below E* ${eStar}`}
                </span>
              </div>
            </div>
            <div className="card">
              <div className="stat">
                <span className="value">{points.length}</span>
                <span className="label">reschedulings on record</span>
              </div>
            </div>
            <div className="card">
              <div className={loan.rsSequence >= 3 ? 'stat alert' : 'stat'}>
                <span className="value">RS-{loan.rsSequence}</span>
                <span className="label">
                  {loan.rsSequence >= 3 ? 'at or past the statutory cap' : 'within the three-occasion cap'}
                </span>
              </div>
              {loan.rsSequence >= 3 && (
                <p className="hint">
                  Flagged independently of the index — §3.7.1 caps rescheduling at three occasions.
                </p>
              )}
            </div>
          </div>

          <div className="grid-2">
            <div className="card">
              <h3>What the CL-1 return records</h3>
              <div className="scroller">
                <table>
                  <thead>
                    <tr>
                      <th>Reference date</th>
                      <th>Reported</th>
                    </tr>
                  </thead>
                  <tbody>
                    {points.length === 0 && (
                      <tr>
                        <td colSpan={2} className="empty">
                          No rescheduling events.
                        </td>
                      </tr>
                    )}
                    {points.map((p) => (
                      <tr key={p.seq}>
                        <td className="mono">{p.classificationRefDate}</td>
                        <td>
                          <span className="pill quiet">{p.tierAfter}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="hint">
                Every row above is what the quarterly return carried. Nothing in it is false.
              </p>
            </div>

            <div className="card accent">
              <h3>What the ledger recorded</h3>
              <div className="scroller">
                <table>
                  <thead>
                    <tr>
                      <th>Event</th>
                      <th>RS</th>
                      <th className="num">Days out</th>
                      <th className="num">E</th>
                    </tr>
                  </thead>
                  <tbody>
                    {points.map((p) => (
                      <tr key={p.seq}>
                        <td className="mono">{p.timestamp.slice(0, 10)}</td>
                        <td className="mono">RS-{p.rsSeq}</td>
                        <td className="num mono">
                          <strong>{p.daysToNextRefDate}</strong>
                        </td>
                        <td className="num mono">
                          <strong>{p.cumulative.toFixed(3)}</strong>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="hint">
                Same exposure. λ = {lambda} per day, so the weight halves every{' '}
                {(Math.LN2 / lambda).toFixed(1)} days.
              </p>
            </div>
          </div>

          {/* The same reschedulings the table above lists, drawn against the
              statutory calendar. Placed immediately after the comparison so the
              numbers and the picture read as one argument. */}
          <ReschedulingTimeline events={trail} />

          {/* ---------- authority trail ---------- */}
          <div className="card" style={{ marginTop: '1rem' }}>
            <h3>Authority evidence on each event</h3>
            <div className="scroller">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Type</th>
                    <th>Authority</th>
                    <th>Assigning</th>
                    <th>Reviewing</th>
                    <th>Transaction</th>
                  </tr>
                </thead>
                <tbody>
                  {trail.map((e) => (
                    <tr key={e.seq}>
                      <td className="mono">{e.seq}</td>
                      <td style={{ fontSize: '.82rem' }}>{e.type}</td>
                      <td>
                        <span className="pill quiet">{e.authorityEvidence?.kind ?? 'MECHANICAL'}</span>
                        {(e.authorityEvidence?.directorSignatures?.length ?? 0) > 0 && (
                          <span className="pill mint" style={{ marginLeft: '.25rem' }}>
                            {e.authorityEvidence!.directorSignatures!.length} directors
                          </span>
                        )}
                      </td>
                      <td className="mono">{e.signatures?.assigning?.officerId?.slice(0, 24) ?? '—'}</td>
                      <td className="mono">{e.signatures?.reviewing?.officerId?.slice(0, 24) ?? '—'}</td>
                      <td className="mono">{e.txId.slice(0, 12)}…</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ---------- Act 5 ---------- */}
      <h2>Council governance</h2>
      <div className="grid-side">
        <div className="card">
          <h3>Propose a change to E*</h3>
          <p style={{ fontSize: '.87rem', color: 'var(--ink-2)', marginTop: 0 }}>
            The measured 95th percentile of this population is <strong>1.117</strong>, against an
            illustrative E* of 0.50. §3.7.1 is explicit that the threshold must be set against the base rate
            rather than against zero — so this is the calibration the paper argues for, proposed live.
          </p>

          <label htmlFor="estar">Proposed E*</label>
          <input id="estar" value={proposedEStar} onChange={(e) => setProposedEStar(e.target.value)} />

          <label htmlFor="pid">Proposal id</label>
          <input id="pid" value={proposalId} onChange={(e) => setProposalId(e.target.value.trim())} placeholder="auto" />

          <div className="row" style={{ marginTop: '.9rem' }}>
            <button onClick={() => void runGovernance('propose')} disabled={busy || !identity}>
              Propose
            </button>
            <button className="mint" onClick={() => void runGovernance('approve')} disabled={busy || !proposalId}>
              Approve as {current?.mspId}
            </button>
            <button className="ghost" onClick={() => void runGovernance('activate')} disabled={busy || !proposalId}>
              Activate
            </button>
          </div>
          <p className="hint">
            Activation before a quorum of distinct Council organisations is refused, by name and count.
          </p>

          {govOutcome && isRefusal(govOutcome) && <RefusalPanel refusal={govOutcome} />}
          {govOutcome && !isRefusal(govOutcome) && (
            <div className="outcome committed">
              <span className="code">✓ RECORDED</span>
              <pre style={{ margin: 0, fontSize: '.76rem', whiteSpace: 'pre-wrap' }}>
                {JSON.stringify(govOutcome.result, null, 1)}
              </pre>
            </div>
          )}
        </div>

        <div>
        <BoardConfirmation identity={identity} />

        <RebuildPanel identity={identity} />
        <div className="card" style={{ marginTop: '1rem' }}>
          <h3>Supervisory access log (§4.7)</h3>
          {accessLog.length === 0 && <p className="empty">No reads recorded yet.</p>}
          {accessLog.length > 0 && (
            <div className="scroller">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Who</th>
                    <th>Read</th>
                  </tr>
                </thead>
                <tbody>
                  {accessLog.slice(0, 12).map((a, i) => (
                    <tr key={i}>
                      <td className="mono">{a.timestamp.slice(11, 19)}</td>
                      <td className="mono">{a.actorMsp.replace('MSP', '')}</td>
                      <td className="mono">{a.resource}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="hint">Oversight is watched too. Your own reads appear here.</p>
        </div>
        </div>
      </div>
    </>
  );
}
