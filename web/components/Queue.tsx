'use client';

/**
 * VERITY — the supervisory queue and the base-rate histogram. ACT 2.
 *
 * ── The queue ────────────────────────────────────────────────────────────
 * 820 exposures ranked for ATTENTION. It is an ordering, not an accusation,
 * and the disclaimer arrives with the payload so this view cannot render the
 * numbers without it (§7.4 #10).
 *
 * Rows come from the read model — a projection rebuilt from block 0. Clicking
 * one goes to the LEDGER, costs a block, and is logged. The list is a cache;
 * the record is the chain.
 *
 * ── The histogram ────────────────────────────────────────────────────────
 * This is the answer to the most dangerous question in the demo: "won't this
 * flag every bank at quarter-end?"
 *
 * §3.7.1 concedes the point rather than dodging it — rescheduling DOES cluster
 * near period-ends for legitimate operational reasons, so E* must be set
 * against the measured distribution rather than against zero. Showing the curve
 * turns that concession from a liability into the reason to believe the
 * threshold.
 */

import { useEffect, useState } from 'react';

import { api, type BaseRate, type Queue, type QueueRow } from '@/lib/api';

export function SupervisoryQueue({
  identity,
  eStar,
  onOpen,
  selected,
}: {
  identity: string | undefined;
  eStar: number;
  onOpen: (commitmentId: string) => void;
  selected?: string;
}): React.ReactNode {
  const [data, setData] = useState<Queue>();
  const [capOnly, setCapOnly] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!identity) return;
    let cancelled = false;
    api
      .queue(identity, { capOnly, limit: 40 })
      .then((q) => !cancelled && setData(q))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [identity, capOnly]);

  return (
    <div className="card">
      <h3>Ranked for supervisory attention</h3>

      <div className="row" style={{ marginBottom: '.9rem' }}>
        <span className="pill quiet">{data ? `${data.total} exposures` : '…'}</span>
        <button
          className={capOnly ? 'mint small' : 'quiet small'}
          onClick={() => setCapOnly((v) => !v)}
        >
          {capOnly ? 'Showing cap-flagged only' : 'At the statutory cap'}
        </button>
        <span className="spacer" />
        <span className="hint" style={{ margin: 0 }}>
          from the read model · click a row to open it on the ledger
        </span>
      </div>

      {error && <p className="err">{error}</p>}
      {!data && !error && <p className="empty">Loading the book…</p>}

      {data && (
        <>
          <div className="scroller" style={{ maxHeight: '26rem', overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Exposure</th>
                  <th>Institution</th>
                  <th>Band</th>
                  <th>RS</th>
                  <th className="num">E</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r: QueueRow) => (
                  <tr
                    key={r.commitmentId}
                    onClick={() => onOpen(r.commitmentId)}
                    style={{ cursor: 'pointer' }}
                    data-selected={r.commitmentId === selected}
                  >
                    <td className="mono">{r.commitmentId}</td>
                    <td style={{ fontSize: '.8rem' }}>{r.institutionMsp.replace('MSP', '')}</td>
                    <td style={{ fontSize: '.78rem', color: 'var(--ink-2)' }}>{r.outstandingBand}</td>
                    <td className="mono">{r.rsSequence > 0 ? `RS-${r.rsSequence}` : '—'}</td>
                    <td className="num">
                      <strong style={{ color: r.ediScore > eStar ? 'var(--coral)' : 'var(--ink)' }}>
                        {r.ediScore.toFixed(3)}
                      </strong>
                    </td>
                    <td>{r.capFlag && <span className="pill coral">CAP</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint">{data.disclaimer}</p>
        </>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------

export function BaseRateChart({ identity }: { identity: string | undefined }): React.ReactNode {
  const [data, setData] = useState<BaseRate>();

  useEffect(() => {
    if (!identity) return;
    let cancelled = false;
    api.baseRate(identity).then((d) => !cancelled && setData(d)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [identity]);

  if (!data) return null;
  const max = Math.max(...data.buckets.map((b) => b.count), 1);
  const nearShare = data.totalReschedulings
    ? (100 * data.withinThirtyDays) / data.totalReschedulings
    : 0;

  return (
    <div className="card">
      <h3>Base rate — when reschedulings actually happen</h3>

      <div style={{ display: 'grid', gap: '.45rem' }}>
        {data.buckets.map((b) => (
          <div key={b.label} style={{ display: 'grid', gridTemplateColumns: '5.6rem 1fr 3.4rem', gap: '.6rem', alignItems: 'center' }}>
            <span className="mono" style={{ fontSize: '.72rem', color: 'var(--ink-2)' }}>{b.label}</span>
            <div style={{ background: 'var(--surface-2)', borderRadius: 'var(--r-pill)', height: '14px', overflow: 'hidden' }}>
              <div
                style={{
                  width: `${(b.count / max) * 100}%`,
                  height: '100%',
                  // The first two buckets are the ones a sceptic points at.
                  background: b.label.startsWith('0') || b.label.startsWith('15')
                    ? 'var(--amber)'
                    : 'var(--mint-2)',
                  borderRadius: 'var(--r-pill)',
                }}
              />
            </div>
            <span className="mono num" style={{ fontSize: '.74rem', textAlign: 'right' }}>
              {(b.share * 100).toFixed(1)}%
            </span>
          </div>
        ))}
      </div>

      <hr className="divider" />

      <p style={{ fontSize: '.86rem', margin: 0, color: 'var(--ink-2)' }}>
        <strong style={{ color: 'var(--ink)' }}>{nearShare.toFixed(1)}%</strong> of all{' '}
        {data.totalReschedulings} reschedulings on this ledger fall within 30 days of a statutory
        reference date. Ordinary forbearance clusters near period-end too, for real operational reasons.
      </p>
      <p className="hint">
        Which is why E* is set against <em>this</em> distribution and not against zero. The 95th
        percentile of observed scores is <strong>{data.suggestedEStar.toFixed(3)}</strong>; E* is
        currently <strong>{data.currentEStar}</strong>. Moving it needs a Council quorum.
      </p>
    </div>
  );
}
