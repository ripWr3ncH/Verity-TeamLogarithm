import Link from 'next/link';

import {
  ApprovalThreshold,
  ArchitectureFlow,
  BFTTopology,
  DirectorConfirmation,
  ExposureCeremony,
  OnChainOffChain,
  ReadModelCache,
} from '@/components/HowItWorks';

/**
 * Landing. The one sentence that frames the whole demo, then three doors.
 *
 * "The rules are not what is missing" is the thesis of the paper and the first
 * thing a judge should read, so it is set at display size and nothing competes
 * with it.
 *
 * The diagrams below "Three views of the same ledger" exist so a recorded
 * walkthrough never has to cut away to README.md to explain the architecture
 * or a refusal mechanism — everything a judge needs to see conceptually is
 * one scroll down this page, next to the live portals it describes.
 */
export default function Home() {
  return (
    <>
      <section style={{ maxWidth: '62rem', margin: '1.5rem 0 3.5rem' }}>
        <span className="eyebrow">BCOLBD 2026 · prototype</span>
        <h1 style={{ fontSize: 'clamp(2.1rem, 5.2vw, 3.6rem)', maxWidth: '19ch' }}>
          The rules are not
          <br />
          what is <span style={{ background: 'var(--mint)', padding: '0 .18em', borderRadius: '6px' }}>missing</span>.
        </h1>
        <p className="sub" style={{ fontSize: '1.05rem', marginTop: '1.25rem', maxWidth: '58ch' }}>
          Bangladesh Bank already requires two signatures on every classification, caps rescheduling at three
          occasions, and reserves the third to the Board. <strong>The record is what is missing</strong> — it
          is held by the institution being examined, it can be revised afterwards, and it is read only when
          an inspector is present.
        </p>

        <div className="row" style={{ marginTop: '1.75rem' }}>
          <Link href="/bank" style={{ textDecoration: 'none' }}>
            <button>See a rule refuse something →</button>
          </Link>
          <Link href="/supervisor" style={{ textDecoration: 'none' }}>
            <button className="ghost">Supervisor view</button>
          </Link>
        </div>
      </section>

      {/* The number that motivates the whole project. */}
      <div className="grid-3" style={{ marginBottom: '2.5rem' }}>
        <div className="card">
          <div className="stat alert">
            <span className="value">4.2×</span>
            <span className="label">assessed against reported</span>
          </div>
          <p className="hint">
            An Asset Quality Review of six banks found Tk 147,595 crore of non-performing loans against
            Tk 35,044 crore reported.
          </p>
        </div>
        <div className="card">
          <div className="stat alert">
            <span className="value">32.26%</span>
            <span className="label">gross NPL ratio, March 2026</span>
          </div>
          <p className="hint">Second-highest nationally in the world, after war-affected Ukraine.</p>
        </div>
        <div className="card">
          <div className="stat">
            <span className="value">17 / 61</span>
            <span className="label">banks an AQR has reached</span>
          </div>
          <p className="hint">
            120 calendar days per bank, international firms, donor money — and it happens once.
          </p>
        </div>
      </div>

      <h2>Three views of the same ledger</h2>
      <div className="grid-3">
        <Link href="/bank" className="card linky">
          <span className="pill ink">Act 1</span>
          <h3 style={{ marginTop: '.7rem' }}>Bank officer</h3>
          <p style={{ margin: 0, fontSize: '.9rem', color: 'var(--ink-2)' }}>
            Commit a classification event. Watch the chaincode refuse an approval level that exists only on
            paper, then accept it once three registered directors have signed.
          </p>
        </Link>

        <Link href="/supervisor" className="card linky">
          <span className="pill ink">Acts 2 &amp; 5</span>
          <h3 style={{ marginTop: '.7rem' }}>Bangladesh Bank</h3>
          <p style={{ margin: 0, fontSize: '.9rem', color: 'var(--ink-2)' }}>
            The Evergreening Detection Index beside what the quarterly return recorded. Council parameters no
            single bank can move, and a log of your own reads.
          </p>
        </Link>

        <Link href="/depositor" className="card linky">
          <span className="pill ink">Act 4</span>
          <h3 style={{ marginTop: '.7rem' }}>Depositor</h3>
          <p style={{ margin: 0, fontSize: '.9rem', color: 'var(--ink-2)' }}>
            Sign your balance, verify it is inside the bank&rsquo;s published commitment, hold the claim.
            Three steps, checked on your own device.
          </p>
        </Link>
      </div>

      <h2>How it works</h2>
      <ArchitectureFlow />

      <div className="grid-2" style={{ marginTop: '1.1rem' }}>
        <ApprovalThreshold />
        <DirectorConfirmation />
      </div>

      <div style={{ marginTop: '1.1rem' }}>
        <ExposureCeremony />
      </div>

      <h2>Architecture</h2>
      <div className="grid-2">
        <BFTTopology />
        <ReadModelCache />
      </div>
      <div style={{ marginTop: '1.1rem' }}>
        <OnChainOffChain />
      </div>

      <h2>What this is not</h2>
      <div className="card" style={{ maxWidth: '70ch' }}>
        <p style={{ margin: 0, fontSize: '.92rem', color: 'var(--ink-2)' }}>
          No zk-SNARK solvency circuit — designed in the paper, not built here. No secondary transfer of
          claim tokens, because no legal authority for one exists. No production HSM. All data synthetic.{' '}
          <strong>The EDI is a screening indicator that ranks exposures for supervisory attention, never a
          finding of misconduct.</strong>
        </p>
      </div>
    </>
  );
}
