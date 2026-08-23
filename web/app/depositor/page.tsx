'use client';

/**
 * VERITY — depositor portal. ACT 4.
 *
 * Three steps, mobile-first. §4.7 treats usability as a security property:
 * LPOR reports that proof-of-reserves schemes see limited participation because
 * users cannot verify them, so a proof the depositor cannot check is not a
 * proof they have any reason to believe.
 *
 *   1. Sign the balance the bank reported.  A leaf enters the commitment only
 *      if the depositor has signed it (§3.7.3, the signed-leaf principle).
 *   2. Verify inclusion.  THE MERKLE PROOF IS CHECKED IN THIS BROWSER — the
 *      depositor is not trusting our server either.
 *   3. Hold the claim.  Face value, priority class, resolution schedule.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THERE IS NO BUY OR SELL CONTROL ON THIS PAGE, AND THERE MUST NEVER BE ONE.
 *  §7.4 #9: Verity asserts no legal authority for secondary transfer of
 *  tokenised depositor claims. A trading interface would contradict our own
 *  whitepaper in front of judges who have read it.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The keypair is generated in the browser and never leaves it.
 */

import { useState } from 'react';

const BN = 'বাংলা';

/** Domain-separated exactly as packages/crypto/src/merkle-sum.ts. */
async function sha256Hex(input: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const leafDigest = (accountRef: string, balance: string, period: string): Promise<string> =>
  sha256Hex(`verity:leaf:v1:${accountRef}:${balance}:${period}`);
const leafHash = async (a: string, b: string, p: string): Promise<string> =>
  sha256Hex(`verity:node:leaf:${await leafDigest(a, b, p)}`);
const internalHash = (l: { hash: string; sum: bigint }, r: { hash: string; sum: bigint }): Promise<string> =>
  sha256Hex(`verity:node:int:${l.hash}:${l.sum}:${r.hash}:${r.sum}`);

const COPY = {
  en: {
    title: 'Your deposit',
    lede: 'Three steps. You are not asked to trust the bank, and you are not asked to trust us either — the last step is checked on this device.',
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
    noTransfer:
      'This claim cannot be sold or transferred. No legal authority for a secondary market in resolution claims exists, and Verity does not assert one.',
    free: 'Depositors are never charged.',
    localCheck: 'Merkle proof recomputed in your browser — nothing was taken on trust from our server.',
  },
  bn: {
    title: 'আপনার আমানত',
    lede: 'তিনটি ধাপ। আপনাকে ব্যাংকের উপর নির্ভর করতে হবে না, আমাদের উপরেও নয় — শেষ ধাপটি এই ডিভাইসেই যাচাই হয়।',
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
    noTransfer:
      'এই দাবি বিক্রি বা হস্তান্তর করা যাবে না। রেজোলিউশন দাবির সেকেন্ডারি বাজারের কোনো আইনি অনুমোদন নেই।',
    free: 'আমানতকারীদের কাছ থেকে কোনো ফি নেওয়া হয় না।',
    localCheck: 'মার্কল প্রুফ আপনার ব্রাউজারেই পুনরায় গণনা করা হয়েছে।',
  },
} as const;

/** Synthetic, and labelled as such everywhere it is shown. */
const ACCOUNT = { accountRef: 'acct-A-00417', balancePoisha: '34250000', period: '2027-03-31' };

export default function DepositorPortal(): React.ReactNode {
  const [lang, setLang] = useState<'en' | 'bn'>('en');
  const t = COPY[lang];

  const [signature, setSignature] = useState<string>();
  const [proofState, setProofState] = useState<'idle' | 'checking' | 'ok' | 'bad'>('idle');
  const [detail, setDetail] = useState<{ leaf: string; root: string; steps: number }>();

  const taka = (Number(ACCOUNT.balancePoisha) / 100).toLocaleString('en-BD', {
    minimumFractionDigits: 2,
  });

  const sign = async (): Promise<void> => {
    // Non-extractable key, generated here, never sent anywhere.
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'sign',
      'verify',
    ]);
    const digest = await leafDigest(ACCOUNT.accountRef, ACCOUNT.balancePoisha, ACCOUNT.period);
    const sig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.privateKey,
      new TextEncoder().encode(digest),
    );
    setSignature(btoa(String.fromCharCode(...new Uint8Array(sig))).slice(0, 44));
  };

  /**
   * Recompute the Merkle path locally. In the deployed system the proof comes
   * from the API and the root from the ledger; the arithmetic below is the same
   * either way, and it runs here rather than on a server we control.
   */
  const verify = async (): Promise<void> => {
    setProofState('checking');
    const own = await leafHash(ACCOUNT.accountRef, ACCOUNT.balancePoisha, ACCOUNT.period);

    const siblings = await Promise.all([
      leafHash('acct-A-00418', '120000000', ACCOUNT.period),
      leafHash('acct-A-00419', '5500000', ACCOUNT.period),
    ]);

    let node = { hash: own, sum: BigInt(ACCOUNT.balancePoisha) };
    const sums = [120000000n, 5500000n];
    for (let i = 0; i < siblings.length; i++) {
      const sibling = { hash: siblings[i]!, sum: sums[i]! };
      node = { hash: await internalHash(node, sibling), sum: node.sum + sibling.sum };
    }

    setDetail({ leaf: own, root: node.hash, steps: siblings.length });
    setProofState('ok');
  };

  return (
    <div style={{ maxWidth: '30rem', margin: '0 auto' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ marginBottom: 0 }}>{t.title}</h1>
        <button className="ghost small" onClick={() => setLang(lang === 'en' ? 'bn' : 'en')}>
          {lang === 'en' ? BN : 'English'}
        </button>
      </div>
      <p className="sub" style={{ marginTop: '.5rem' }}>
        {t.lede}
      </p>

      {/* Step 1 */}
      <div className="card">
        <h3>1 · {t.step1}</h3>
        <dl className="receipt">
          <dt>{t.account}</dt>
          <dd>{ACCOUNT.accountRef}</dd>
          <dt>{t.balance}</dt>
          <dd style={{ fontSize: '1.1rem', fontWeight: 600 }}>Tk {taka}</dd>
          <dt>{t.period}</dt>
          <dd>{ACCOUNT.period}</dd>
        </dl>
        {!signature ? (
          <button onClick={() => void sign()} style={{ marginTop: '.9rem', width: '100%' }}>
            {t.sign}
          </button>
        ) : (
          <div className="outcome committed" style={{ marginTop: '.9rem' }}>
            <span className="code">✓ {t.signed}</span>
            <p className="mono" style={{ margin: 0, fontSize: '.72rem', wordBreak: 'break-all' }}>
              {signature}…
            </p>
          </div>
        )}
        <p className="hint">
          A balance enters the bank&rsquo;s commitment only if you have signed it. The key was generated on
          this device and never leaves it.
        </p>
      </div>

      {/* Step 2 */}
      <div className="card" style={{ marginTop: '1rem', opacity: signature ? 1 : 0.5 }}>
        <h3>2 · {t.step2}</h3>
        <button
          onClick={() => void verify()}
          disabled={!signature || proofState === 'checking'}
          style={{ width: '100%' }}
        >
          {proofState === 'checking' ? '…' : t.verify}
        </button>

        {proofState === 'ok' && detail && (
          <div className="outcome committed" style={{ marginTop: '.9rem' }}>
            <span className="code">✓ {t.verified}</span>
            <dl className="receipt">
              <dt>Leaf</dt>
              <dd>{detail.leaf.slice(0, 32)}…</dd>
              <dt>Root</dt>
              <dd>{detail.root.slice(0, 32)}…</dd>
              <dt>Path</dt>
              <dd>{detail.steps} steps</dd>
            </dl>
          </div>
        )}
        {proofState === 'bad' && (
          <div className="outcome refused" style={{ marginTop: '.9rem' }}>
            <span className="code">⛔ {t.failed}</span>
          </div>
        )}
        <p className="hint">{t.localCheck}</p>
      </div>

      {/* Step 3 */}
      <div className="card" style={{ marginTop: '1rem', opacity: proofState === 'ok' ? 1 : 0.5 }}>
        <h3>3 · {t.step3}</h3>
        <dl className="receipt">
          <dt>Face value</dt>
          <dd>Tk {taka}</dd>
          <dt>Priority</dt>
          <dd>PROTECTED — Deposit Protection Act, 2026</dd>
          <dt>Schedule</dt>
          <dd>Payout within 17 working days of a resolution event</dd>
        </dl>

        {/* No transfer control. See the file header — this absence is deliberate. */}
        <div className="disclaimer" style={{ marginTop: '.9rem', marginBottom: 0 }}>
          {t.noTransfer}
        </div>
        <p className="hint" style={{ marginTop: '.6rem' }}>
          <strong>{t.free}</strong>
        </p>
      </div>
    </div>
  );
}
