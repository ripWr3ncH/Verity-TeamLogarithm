'use client';

/**
 * VERITY — CL-1 reconciliation and the read-only adapter. ACT 0.
 *
 * ── The omission check ───────────────────────────────────────────────────
 * §3.7.1: "Omission is prevented by reconciliation. Committed aggregates must
 * reconcile to the CL-1 already submitted. A loan absent from the tree but
 * present in CL-1, or absent from both while sitting on the balance sheet, is
 * an unrecorded asset."
 *
 * This is the hook the demo opens on. Every row the bank filed is accurate.
 * The return is still incomplete, and nothing inside the return reveals that —
 * only the comparison does.
 *
 * ── The adapter ──────────────────────────────────────────────────────────
 * §4.3 says Verity sits outside the CBS write path. The panel proves it by
 * attempting a write and showing PostgreSQL refuse — the API connects as a
 * role that holds SELECT and nothing else.
 */

import { useEffect, useState } from 'react';

import { API_BASE } from '@/lib/api';

interface Finding {
  finding: string;
  commitmentId: string;
  institutionMsp: string;
  ledgerValue?: string;
  filedValue?: string;
  ediScore?: number;
  rsSequence?: number;
}

interface Recon {
  referenceDate: string;
  filedCount: number;
  ledgerCount: number;
  matched: number;
  findings: Finding[];
  note: string;
}

interface Adapter {
  role: string;
  canRead: boolean;
  rowsVisible: number;
  canWrite: boolean;
  refusal?: string;
}

const get = async <T,>(path: string, identity: string): Promise<T> => {
  const r = await fetch(`${API_BASE}${path}`, {
    headers: { 'X-Verity-Identity': identity },
    cache: 'no-store',
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
};

export function ReconciliationPanel({
  identity,
  referenceDate = '2029-03-31',
  onOpen,
}: {
  identity: string | undefined;
  referenceDate?: string;
  onOpen: (id: string) => void;
}): React.ReactNode {
  const [recon, setRecon] = useState<Recon>();
  const [adapter, setAdapter] = useState<Adapter>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!identity) return;
    get<Adapter>('/cbs/adapter', identity).then(setAdapter).catch(() => {});
  }, [identity]);

  const run = async (): Promise<void> => {
    if (!identity) return;
    setBusy(true);
    setError(undefined);
    try {
      setRecon(await get<Recon>(`/reconciliation/${referenceDate}`, identity));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const omissions = recon?.findings.filter((f) => f.finding === 'ON_LEDGER_NOT_IN_CL1') ?? [];

  return (
    <div className="grid-side">
      <div className="card">
        <h3>CL-1 reconciliation · {referenceDate}</h3>

        <div className="row" style={{ marginBottom: '.9rem' }}>
          <button onClick={() => void run()} disabled={busy || !identity}>
            {busy ? 'Comparing…' : 'Reconcile against the filed return'}
          </button>
          <span className="hint" style={{ margin: 0 }}>
            the filed CL-1 is read through the read-only adapter
          </span>
        </div>

        {error && <p className="err">{error}</p>}
        {!recon && !error && <p className="empty">Not yet run.</p>}

        {recon && (
          <>
            <div className="grid-3" style={{ marginBottom: '1rem' }}>
              <div className="stat">
                <span className="value">{recon.filedCount}</span>
                <span className="label">filed on CL-1</span>
              </div>
              <div className="stat">
                <span className="value">{recon.ledgerCount}</span>
                <span className="label">on the ledger</span>
              </div>
              <div className={omissions.length > 0 ? 'stat alert' : 'stat good'}>
                <span className="value">{omissions.length}</span>
                <span className="label">absent from the return</span>
              </div>
            </div>

            {omissions.length > 0 && (
              <>
                <p style={{ fontSize: '.89rem', margin: '0 0 .7rem' }}>
                  <span className="pill coral">OMISSION</span> These exposures carry committed events
                  but do not appear in the quarterly return. Ranked by index — the first rows are the
                  ones to look at.
                </p>
                <div className="scroller" style={{ maxHeight: '18rem', overflowY: 'auto' }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Exposure</th>
                        <th>Institution</th>
                        <th>Ledger tier</th>
                        <th>RS</th>
                        <th className="num">E</th>
                      </tr>
                    </thead>
                    <tbody>
                      {omissions.slice(0, 20).map((f) => (
                        <tr
                          key={f.commitmentId}
                          onClick={() => onOpen(f.commitmentId)}
                          style={{ cursor: 'pointer' }}
                        >
                          <td className="mono">{f.commitmentId}</td>
                          <td style={{ fontSize: '.8rem' }}>{f.institutionMsp.replace('MSP', '')}</td>
                          <td style={{ fontSize: '.8rem' }}>{f.ledgerValue}</td>
                          <td className="mono">{f.rsSequence ? `RS-${f.rsSequence}` : '—'}</td>
                          <td className="num">
                            <strong>{(f.ediScore ?? 0).toFixed(3)}</strong>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            <p className="hint">{recon.note}</p>
          </>
        )}
      </div>

      {/* ---------- §4.3, checkable ---------- */}
      <div className="card">
        <h3>The core banking adapter</h3>
        {!adapter && <p className="empty">…</p>}
        {adapter && (
          <>
            <dl className="receipt">
              <dt>Connected as</dt>
              <dd>{adapter.role}</dd>
              <dt>Can read</dt>
              <dd>
                {adapter.canRead ? '✓' : '✗'} — {adapter.rowsVisible} loans visible
              </dd>
              <dt>Can write</dt>
              <dd style={{ color: adapter.canWrite ? 'var(--coral)' : 'var(--mint-deep)' }}>
                {adapter.canWrite ? '✗ WRITEABLE — this is a defect' : '✓ refused'}
              </dd>
            </dl>

            {adapter.refusal && (
              <div className="outcome refused" style={{ marginTop: '.9rem' }}>
                <span className="code">⛔ POSTGRESQL</span>
                <p className="text" style={{ fontFamily: 'var(--font-mono)', fontSize: '.78rem' }}>
                  {adapter.refusal}
                </p>
              </div>
            )}

            <p className="hint">
              §4.3 — Verity sits outside the core banking write path. That is a database grant, not a
              convention this application observes: the write above was attempted for real and the
              server refused it. Existing CL-1 to CL-5 submission, EDW upload and CIB reporting
              continue unchanged.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
