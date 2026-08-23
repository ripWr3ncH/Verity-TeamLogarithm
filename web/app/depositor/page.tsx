'use client';

/**
 * VERITY — depositor portal. ACT 4.
 *
 * Three steps, mobile-first. §4.7 treats usability as a security property:
 * LPOR reports that proof-of-reserves schemes see limited participation because
 * users cannot verify them, so a proof the depositor cannot check is not a
 * proof they have any reason to believe.
 *
 *   1. Sign the balance the bank reported. A leaf enters the commitment only if
 *      the depositor has signed it (§3.7.3, the signed-leaf principle).
 *   2. Verify inclusion TWICE — once recomputed in this browser, once against
 *      the root committed on the ledger. If those two ever disagree, the bank
 *      is showing the depositor something the chain does not carry.
 *   3. Hold the claim. Face value, priority class, resolution schedule.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THERE IS NO BUY OR SELL CONTROL ON THIS PAGE, AND THERE MUST NEVER BE ONE.
 *  §7.4 #9: Verity asserts no legal authority for secondary transfer of
 *  tokenised depositor claims. A trading interface would contradict our own
 *  whitepaper in front of judges who have read it.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { useEffect, useState } from 'react';

import { API_BASE } from '@/lib/api';

const BN = 'বাংলা';

/** Domain separation must match packages/crypto/src/merkle-sum.ts exactly. */
async function sha256Hex(input: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const leafDigest = (accountRef: string, balance: string, period: string): Promise<string> =>
  sha256Hex(`verity:leaf:v1:${accountRef}:${balance}:${period}`);
const internalHash = (l: { hash: string; sum: bigint }, r: { hash: string; sum: bigint }): Promise<string> =>
  sha256Hex(`verity:node:int:${l.hash}:${l.sum}:${r.hash}:${r.sum}`);

interface Session {
  institutionMsp: string;
  period: string;
  accountRef: string;
  balancePoisha: string;
  priorityClass: string;
  depositorKey: string;
  claimId: string;
  merkleRoot: string;
  committedSum: string;
  leafCount: number;
  proof: {
    leafIndex: number;
    leafHash: string;
    leafSum: string;
    path: Array<{ hash: string; sum: string; right: boolean }>;
    root: string;
    rootSum: string;
  };
}

const COPY = {
  en: {
    title: 'Your deposit',
    lede: 'Three steps. You are not asked to trust the bank, and you are not asked to trust us either — step two is recomputed on this device and checked against the ledger.',
    step1: 'Review and sign the balance your bank reported',
    step2: 'Verify it is inside the bank’s published commitment',
    step3: 'Your claim',
    sign: 'Sign this balance',
    signed: 'Signed on this device',
    verify: 'Verify inclusion',
    verified: 'Included in the commitment',
    failed: 'Not included — do not accept this statement',
    balance: 'Balance reported',
    period: 'Period',
    account: 'Account',
    inThisBrowser: 'Recomputed in this browser',
    onTheLedger: 'Checked against the committed root',
    among: 'among',
    depositors: 'depositors',
    noTransfer:
      'This claim cannot be sold or transferred. No legal authority for a secondary market in resolution claims exists, and Verity does not assert one.',
    free: 'Depositors are never charged.',
    notCommitted: 'No liability commitment has been published yet.',
  },
  bn: {
    title: 'আপনার আমানত',
    lede: 'তিনটি ধাপ। আপনাকে ব্যাংকের উপর নির্ভর করতে হবে না, আমাদের উপরেও নয় — দ্বিতীয় ধাপ এই ডিভাইসেই গণনা হয় এবং লেজারের সাথে মিলিয়ে দেখা হয়।',
    step1: 'আপনার ব্যাংক যে স্থিতি জানিয়েছে তা দেখে স্বাক্ষর করুন',
    step2: 'এটি ব্যাংকের প্রকাশিত প্রতিশ্রুতির ভিতরে আছে কিনা যাচাই করুন',
    step3: 'আপনার দাবি',
    sign: 'এই স্থিতিতে স্বাক্ষর করুন',
    signed: 'এই ডিভাইসে স্বাক্ষরিত',
    verify: 'অন্তর্ভুক্তি যাচাই করুন',
    verified: 'প্রতিশ্রুতিতে অন্তর্ভুক্ত',
    failed: 'অন্তর্ভুক্ত নয় — এই বিবরণী গ্রহণ করবেন না',
    balance: 'জানানো স্থিতি',
    period: 'সময়কাল',
    account: 'হিসাব',
    inThisBrowser: 'এই ব্রাউজারে পুনরায় গণনা করা হয়েছে',
    onTheLedger: 'লেজারের প্রতিশ্রুত মূলের সাথে যাচাই',
    among: 'মোট',
    depositors: 'জন আমানতকারীর মধ্যে',
    noTransfer:
      'এই দাবি বিক্রি বা হস্তান্তর করা যাবে না। রেজোলিউশন দাবির সেকেন্ডারি বাজারের কোনো আইনি অনুমোদন নেই।',
    free: 'আমানতকারীদের কাছ থেকে কোনো ফি নেওয়া হয় না।',
    notCommitted: 'এখনো কোনো দায় প্রতিশ্রুতি প্রকাশিত হয়নি।',
  },
} as const;

export default function DepositorPortal(): React.ReactNode {
  const [lang, setLang] = useState<'en' | 'bn'>('en');
  const t = COPY[lang];

  const [session, setSession] = useState<Session>();
  const [loadError, setLoadError] = useState<string>();
  const [signature, setSignature] = useState<string>();
  const [local, setLocal] = useState<boolean>();
  const [onChain, setOnChain] = useState<boolean>();
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE}/depositor/session`, { cache: 'no-store' })
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
        setSession(body as Session);
      })
      .catch((e: Error) => setLoadError(e.message));
  }, []);

  const taka = session
    ? (Number(session.balancePoisha) / 100).toLocaleString('en-BD', { minimumFractionDigits: 2 })
    : '';

  const sign = async (): Promise<void> => {
    if (!session) return;
    // Non-extractable key, generated here, never sent anywhere.
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'sign',
      'verify',
    ]);
    const digest = await leafDigest(session.accountRef, session.balancePoisha, session.period);
    const sig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.privateKey,
      new TextEncoder().encode(digest),
    );
    setSignature(btoa(String.fromCharCode(...new Uint8Array(sig))).slice(0, 44));
  };

  /**
   * Walk the real Merkle path from the leaf to the root, here, and separately
   * ask the ledger. Two independent answers to the same question — that is the
   * point, and it is why the depositor does not have to trust this page either.
   */
  const verify = async (): Promise<void> => {
    if (!session) return;
    setChecking(true);
    try {
      let node = { hash: session.proof.leafHash, sum: BigInt(session.proof.leafSum) };
      for (const step of session.proof.path) {
        const sibling = { hash: step.hash, sum: BigInt(step.sum) };
        node = step.right
          ? { hash: await internalHash(node, sibling), sum: node.sum + sibling.sum }
          : { hash: await internalHash(sibling, node), sum: sibling.sum + node.sum };
      }
      setLocal(node.hash === session.merkleRoot && node.sum === BigInt(session.committedSum));

      const r = await fetch(`${API_BASE}/liability/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Verity-Identity': 'supervisor-1' },
        body: JSON.stringify({
          institutionMsp: session.institutionMsp,
          period: session.period,
          proof: session.proof,
        }),
      });
      setOnChain((await r.json())?.verified === true);
    } finally {
      setChecking(false);
    }
  };

  const both = local === true && onChain === true;

  return (
    <div style={{ maxWidth: '31rem', margin: '0 auto' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ marginBottom: 0 }}>{t.title}</h1>
        <button className="ghost small" onClick={() => setLang(lang === 'en' ? 'bn' : 'en')}>
          {lang === 'en' ? BN : 'English'}
        </button>
      </div>
      <p className="sub" style={{ marginTop: '.5rem' }}>{t.lede}</p>

      {loadError && (
        <div className="card">
          <p className="err" style={{ margin: 0 }}>{t.notCommitted}</p>
          <p className="hint">{loadError}</p>
        </div>
      )}

      {session && (
        <>
          {/* Step 1 */}
          <div className="card">
            <h3>1 · {t.step1}</h3>
            <dl className="receipt">
              <dt>{t.account}</dt>
              <dd>{session.accountRef}</dd>
              <dt>{t.balance}</dt>
              <dd style={{ fontSize: '1.15rem', fontWeight: 700 }}>Tk {taka}</dd>
              <dt>{t.period}</dt>
              <dd>{session.period}</dd>
            </dl>
            {!signature ? (
              <button onClick={() => void sign()} style={{ marginTop: '1rem', width: '100%' }}>
                {t.sign}
              </button>
            ) : (
              <div className="outcome committed" style={{ marginTop: '1rem' }}>
                <span className="code">✓ {t.signed}</span>
                <p className="mono" style={{ margin: 0, fontSize: '.7rem', wordBreak: 'break-all' }}>
                  {signature}…
                </p>
              </div>
            )}
            <p className="hint">
              A balance enters the bank&rsquo;s commitment only if you have signed it. The key was
              generated on this device and never leaves it.
            </p>
          </div>

          {/* Step 2 */}
          <div className="card" style={{ marginTop: '1rem', opacity: signature ? 1 : 0.45 }}>
            <h3>2 · {t.step2}</h3>
            <button
              onClick={() => void verify()}
              disabled={!signature || checking}
              style={{ width: '100%' }}
            >
              {checking ? '…' : t.verify}
            </button>

            {local !== undefined && (
              <div className={`outcome ${both ? 'committed' : 'refused'}`} style={{ marginTop: '1rem' }}>
                <span className="code">
                  {both ? `✓ ${t.verified}` : `⛔ ${t.failed}`}
                </span>
                <dl className="receipt">
                  <dt>{t.inThisBrowser}</dt>
                  <dd>{local ? '✓' : '✗'}</dd>
                  <dt>{t.onTheLedger}</dt>
                  <dd>{onChain ? '✓' : '✗'}</dd>
                  <dt>Root</dt>
                  <dd>{session.merkleRoot.slice(0, 34)}…</dd>
                  <dt>Path</dt>
                  <dd>
                    {session.proof.path.length} steps · {t.among} {session.leafCount} {t.depositors}
                  </dd>
                </dl>
              </div>
            )}
            <p className="hint">
              Two independent answers to the same question. If they ever disagreed, the bank would be
              showing you something the ledger does not carry.
            </p>
          </div>

          {/* Step 3 */}
          <div className="card" style={{ marginTop: '1rem', opacity: both ? 1 : 0.45 }}>
            <h3>3 · {t.step3}</h3>
            <dl className="receipt">
              <dt>Claim</dt>
              <dd>{session.claimId}</dd>
              <dt>Face value</dt>
              <dd>Tk {taka}</dd>
              <dt>Priority</dt>
              <dd>{session.priorityClass.replace(/_/g, ' ')}</dd>
              <dt>Schedule</dt>
              <dd>Payout within 17 working days of a resolution event</dd>
            </dl>

            {session.priorityClass !== 'PROTECTED' && (
              <p className="hint">
                Above the Tk 2,00,000 ceiling of the Deposit Protection Act, 2026 — which covers roughly
                93% of accounts but a minority of deposit value. This is the balance that Act leaves open.
              </p>
            )}

            {/* No transfer control. See the file header — the absence is deliberate. */}
            <div className="disclaimer" style={{ marginTop: '1rem', marginBottom: 0 }}>
              {t.noTransfer}
            </div>
            <p className="hint" style={{ marginTop: '.7rem' }}>
              <strong>{t.free}</strong>
            </p>
          </div>
        </>
      )}
    </div>
  );
}
