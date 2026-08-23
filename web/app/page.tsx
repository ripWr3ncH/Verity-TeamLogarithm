import Link from 'next/link';

/**
 * Landing. Three portals, and the one sentence that frames the whole demo.
 */
export default function Home() {
  return (
    <>
      <h1>Verity</h1>
      <p className="sub">
        Bangladesh Bank already requires two signatures on every classification, caps rescheduling at three
        occasions, and reserves the third to the Board. <strong>The rules are not what is missing.</strong>{' '}
        The record is — it is held by the institution being examined, it can be revised afterwards, and it is
        read only when an inspector is present.
      </p>

      <div className="grid-2">
        <Link href="/bank" className="card" style={{ textDecoration: 'none', color: 'inherit' }}>
          <h3>Bank officer</h3>
          <p style={{ margin: 0, fontSize: '.9rem', color: 'var(--ink-2)' }}>
            Commit a classification event. Watch the chaincode refuse an approval level that exists only on
            paper.
          </p>
        </Link>

        <Link href="/supervisor" className="card" style={{ textDecoration: 'none', color: 'inherit' }}>
          <h3>Bangladesh Bank</h3>
          <p style={{ margin: 0, fontSize: '.9rem', color: 'var(--ink-2)' }}>
            The Evergreening Detection Index beside what the quarterly return recorded. Council parameters,
            and the log of your own reads.
          </p>
        </Link>

        <Link href="/depositor" className="card" style={{ textDecoration: 'none', color: 'inherit' }}>
          <h3>Depositor</h3>
          <p style={{ margin: 0, fontSize: '.9rem', color: 'var(--ink-2)' }}>
            Sign your balance, verify it is inside the bank&rsquo;s published commitment, hold the claim.
            Three steps, and depositors pay nothing.
          </p>
        </Link>

        <div className="card">
          <h3>What this is not</h3>
          <p style={{ margin: 0, fontSize: '.88rem', color: 'var(--ink-2)' }}>
            No zk-SNARK solvency circuit. No secondary transfer of claim tokens — no legal authority for one
            exists. No production HSM. All data synthetic. The EDI is a screening indicator, never a finding
            of misconduct.
          </p>
        </div>
      </div>
    </>
  );
}
