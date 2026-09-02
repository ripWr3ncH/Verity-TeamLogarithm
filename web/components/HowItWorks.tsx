/**
 * VERITY — static process diagrams for the homepage.
 *
 * These exist so a recorded walkthrough never has to cut away to README.md or
 * a slide deck. Every diagram below is drawn from what the system actually
 * does — the refusal codes are the real strings the chaincode returns, not
 * paraphrases — so pointing at one of these on screen and reading it aloud is
 * exactly as honest as pointing at a live refusal panel.
 *
 * This is every diagram README.md has, redrawn for the portal rather than
 * GitHub's renderer: the architecture flow, the two authority-threshold
 * sequences (Act 1 and Act 1b), the cross-bank exposure ceremony (Module II),
 * the BFT ordering topology, the on-chain/off-chain split, and the read
 * model as a disposable cache.
 *
 * Deliberately plain HTML and CSS, no diagram library — mermaid needs a
 * renderer and an internet connection neither this venue nor next/font's
 * build-time philosophy assumes. Seven of these, all static, are a worse
 * trade for a dependency than components that inherit the page's own design
 * tokens.
 */

type Accent = 'mint' | 'amber' | 'ink' | undefined;

function FlowNode({
  label,
  detail,
  accent,
}: {
  label: string;
  detail: string;
  accent?: Accent;
}): React.ReactNode {
  return (
    <div className={`flow-node${accent ? ` accent-${accent}` : ''}`}>
      <div className="flow-node-label">{label}</div>
      <div className="flow-node-detail">{detail}</div>
    </div>
  );
}

function FlowArrow({ label }: { label: string }): React.ReactNode {
  return (
    <div className="flow-arrow">
      <span className="flow-arrow-line">→</span>
      <span className="flow-arrow-label">{label}</span>
    </div>
  );
}

/** The whole system, left to right: where a write starts, what checks it, where it lands. */
export function ArchitectureFlow(): React.ReactNode {
  return (
    <div className="card">
      <h3>How a classification becomes a record</h3>
      <div className="scroller">
        <div className="flow">
          <FlowNode label="Core banking system" detail="the bank's system of record" />
          <FlowArrow label="reads, never writes" />
          <FlowNode label="Adapter" detail="SELECT only — no write grant" accent="amber" />
          <FlowArrow label="signed event" />
          <FlowNode label="Officer" detail="X.509 · role · seniority" />
          <FlowArrow label="submits" />
          <FlowNode label="Chaincode" detail="checks authority, refuses by name" accent="ink" />
          <FlowArrow label="endorsed by bank AND supervisor" />
          <FlowNode label="Ledger" detail="Hyperledger Fabric · append-only" accent="mint" />
          <FlowArrow label="block events" />
          <FlowNode label="Read model" detail="disposable — rebuilt from block 0" />
          <FlowArrow label="serves" />
          <FlowNode label="Supervisor dashboard" detail="Bangladesh Bank" />
        </div>
      </div>

      <div className="flow-branch">
        <span>the ledger&rsquo;s own root</span>
        <span className="dashed" />
        <span>inclusion proof, recomputed on-device</span>
        <span className="dashed" />
        <span>Depositor</span>
      </div>
      <div className="flow-branch">
        <span>Core banking system</span>
        <span className="dashed" />
        <span>quarterly CL-1 return, unchanged and still filed</span>
        <span className="dashed" />
        <span>Supervisor dashboard</span>
      </div>

      <p className="hint">
        The adapter is read-only at the database grant, not by convention — Verity could not write
        to the bank&rsquo;s core system even if its own code tried to. Existing CL-1&ndash;CL-5
        submission, EDW upload and CIB reporting continue exactly as they are.
      </p>
    </div>
  );
}

interface Step {
  label: string;
  detail: string;
  outcome: 'refused' | 'committed' | 'watch';
  code?: string;
}

function StepTrack({ steps }: { steps: Step[] }): React.ReactNode {
  return (
    <div className="steps">
      {steps.map((s, i) => (
        <div className="step" key={i}>
          <div className="step-rail">
            <div className={`step-dot ${s.outcome === 'watch' ? 'amber' : s.outcome}`} />
            <div className="step-line" />
          </div>
          <div className="step-body">
            <div className="step-label">{s.label}</div>
            <div className="step-detail">{s.detail}</div>
            {s.code && (
              <span className={`step-code ${s.outcome === 'watch' ? 'amber' : s.outcome}`}>
                {s.outcome === 'refused' ? '⛔ ' : s.outcome === 'committed' ? '✓ ' : '— '}
                {s.code}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Act 1 — a signature count is not the same thing as an authority check. */
export function ApprovalThreshold(): React.ReactNode {
  return (
    <div className="card">
      <h3>Act 1 · an approval level that exists only on paper</h3>
      <StepTrack
        steps={[
          {
            label: 'A third rescheduling, the officer&rsquo;s signature alone',
            detail: 'BRPD 16/2022 already reserves this to the Board — today it is a field the bank fills in itself.',
            outcome: 'refused',
            code: 'BOARD_AUTHORISATION_REQUIRED — supplied 0 of 3 director signatures',
          },
          {
            label: 'Two of three registered directors sign',
            detail: 'Real ed25519 signatures, checked against the registered director set, counted as distinct signers.',
            outcome: 'refused',
            code: 'supplied 2 of 3',
          },
          {
            label: 'The third director signs',
            detail: 'Endorsed by the bank’s peer AND Bangladesh Bank’s — without the supervisor this transaction does not exist.',
            outcome: 'committed',
            code: 'committed · block height + endorsers on the receipt',
          },
        ]}
      />
    </div>
  );
}

/** Act 1b — counting signatures proves three keys signed, not whose keys they are. */
export function DirectorConfirmation(): React.ReactNode {
  return (
    <div className="card">
      <h3>Act 1b · who decides who the directors are?</h3>
      <StepTrack
        steps={[
          {
            label: 'A bank registers three directors as its own MD/CEO',
            detail: 'Every key is real, and every key is in the bank’s own registered set.',
            outcome: 'watch',
            code: 'registered — not yet confirmed',
          },
          {
            label: 'Those same three sign an RS-3',
            detail: 'The threshold is met exactly. The only thing missing is Bangladesh Bank.',
            outcome: 'refused',
            code: 'DIRECTOR_NOT_CONFIRMED — not confirmed by Bangladesh Bank',
          },
          {
            label: 'Bangladesh Bank confirms the three directors',
            detail: 'A bank can register a director. It cannot seat one.',
            outcome: 'watch',
            code: 'confirmed',
          },
          {
            label: 'The same three signatures, replayed',
            detail: 'Nothing about the signatures changed — only whether the signers were seated.',
            outcome: 'committed',
            code: 'committed',
          },
        ]}
      />
    </div>
  );
}

/** Module II — two banks, one aggregate, and a key nobody holds alone. */
export function ExposureCeremony(): React.ReactNode {
  return (
    <div className="card">
      <h3>Module II · cross-bank exposure, without disclosure</h3>
      <StepTrack
        steps={[
          {
            label: 'Two banks each encrypt their own exposure to the same borrower group',
            detail: 'Tk 520 crore, Tk 430 crore — each comfortably under its own single-borrower limit.',
            outcome: 'committed',
            code: 'published, still encrypted',
          },
          {
            label: 'Chaincode multiplies the ciphertexts',
            detail: 'Paillier is additively homomorphic — the product decrypts to the sum. Nothing is decrypted yet.',
            outcome: 'committed',
            code: 'aggregate committed, still encrypted',
          },
          {
            label: 'The supervisor alone tries to open it',
            detail: 'One share of a threshold key is not the key.',
            outcome: 'refused',
            code: 'CEREMONY_QUORUM_SHORT',
          },
          {
            label: 'All three independent holders try, without the supervisor',
            detail: 'The supervisor’s share is required in every valid combination.',
            outcome: 'refused',
            code: 'CEREMONY_SUPERVISOR_ABSENT',
          },
          {
            label: 'Supervisor + two of three independents',
            detail: 'Opened: Tk 950 crore combined, against a Tk 625 crore system-wide limit. Over the limit, while under every single bank’s own.',
            outcome: 'watch',
            code: 'ALERT — verified on-chain against the ciphertext before being believed',
          },
        ]}
      />
    </div>
  );
}

function NetGroup({
  title,
  chips,
  accent,
}: {
  title: string;
  chips: string[];
  accent?: Accent;
}): React.ReactNode {
  return (
    <div className={`netgroup${accent ? ` accent-${accent}` : ''}`}>
      <div className="netgroup-title">{title}</div>
      <div className="netgroup-chips">
        {chips.map((c) => (
          <span className="pill quiet" key={c}>
            {c}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Why Fabric, and why BFT — five ordering nodes across five organisations, three channels, four peers. */
export function BFTTopology(): React.ReactNode {
  return (
    <div className="card">
      <h3>Why Fabric, and why BFT</h3>
      <p style={{ fontSize: '.87rem', color: 'var(--ink-2)', margin: '0 0 1rem' }}>
        <strong>Permissioned</strong>, because positions must not be publicly readable. <strong>Not Corda</strong>
        , because point-to-point suits bilateral contracts. <strong>Not Raft</strong> — Raft is crash fault
        tolerant, it assumes nodes fail rather than lie, and our threat model explicitly includes collusion
        among consortium members.
      </p>
      <NetGroup
        title="Ordering service · SmartBFT · tolerates f = 1"
        accent="ink"
        chips={[
          'orderer0 — Bangladesh Bank',
          'orderer1 — BIBM',
          'orderer2 — FRC',
          'orderer3 — bank seat A',
          'orderer4 — bank seat B',
        ]}
      />
      <div className="net-down" />
      <NetGroup
        title="Channels"
        accent="mint"
        chips={[
          'commitment — BankA · BankB · BB · FRC',
          'exposure — BankA · BankB · BB',
          'claims — BankA · BB · FRC',
        ]}
      />
      <div className="net-down" />
      <NetGroup
        title="Peer organisations"
        chips={[
          'peer0.banka — Sammilito',
          'peer0.bankb — Meghna',
          'peer0.bb — Bangladesh Bank',
          'peer0.frc — FRC · query only',
        ]}
      />
      <p className="hint">
        Five ordering nodes, so n ≥ 3f+1 tolerates <strong>one Byzantine node</strong>. Bangladesh Bank holds
        endorsement and querying rights on every channel from genesis and cannot be voted out — but endorsement
        and ordering are separate powers: it can refuse an event, and it cannot author a bank&rsquo;s record,
        rewrite a committed one, or decrypt an aggregate alone. Its own queries are logged too.
      </p>
    </div>
  );
}

/** What sits on the ledger in the open, what sits in a private data collection, and what never leaves the bank. */
export function OnChainOffChain(): React.ReactNode {
  return (
    <div className="card">
      <h3>On-chain and off-chain</h3>
      <div className="grid-3">
        <div className="netcol accent-ink">
          <div className="netcol-title">On the ledger</div>
          <ul className="netcol-list">
            <li>commitment hashes</li>
            <li>signed typed events</li>
            <li>authority evidence</li>
            <li>liability roots</li>
            <li>encrypted exposures</li>
            <li>claim tokens</li>
          </ul>
        </div>
        <div className="netcol accent-mint">
          <div className="netcol-title">Private data collections</div>
          <ul className="netcol-list">
            <li>borrower reference</li>
            <li>exact amounts</li>
            <li>justification memos</li>
          </ul>
        </div>
        <div className="netcol">
          <div className="netcol-title">Off-chain, hash-anchored</div>
          <ul className="netcol-list">
            <li>loan agreements</li>
            <li>KYC and PII</li>
            <li>individual balances</li>
            <li>valuation reports</li>
          </ul>
        </div>
      </div>
      <p className="hint">
        The ledger reaches the other two columns <strong>hash only</strong>, in both directions. Borrower-group
        tokens are held as attestations, never as record keys — no ledger query returns a borrower&rsquo;s
        identity.
      </p>
    </div>
  );
}

/** The dashboard is a disposable projection; the ledger is the only thing that survives deleting it. */
export function ReadModelCache(): React.ReactNode {
  return (
    <div className="card">
      <h3>The read model is a cache</h3>
      <div className="scroller">
        <div className="flow">
          <FlowNode label="Ledger" detail="source of truth" accent="ink" />
          <FlowArrow label="block events" />
          <FlowNode label="Listener" detail="re-reads authoritative state" />
          <FlowArrow label="projects" />
          <FlowNode label="PostgreSQL" detail="disposable projection" />
          <FlowArrow label="serves" />
          <FlowNode label="Queue, histogram, reconciliation" detail="everything the dashboard shows" />
        </div>
      </div>
      <div className="flow-branch">
        <span>Ledger</span>
        <span className="dashed" />
        <span>SuperviseLoan — costs a block, logged</span>
        <span className="dashed" />
        <span>opening one exposure</span>
      </div>
      <p className="hint">
        Peers run <strong>LevelDB, not CouchDB</strong> — rich queries belong in the projection, not the
        ledger. Press <strong>Rebuild from block 0</strong> in the supervisor portal and every projection is
        truncated and replayed: exposures return in about 90 seconds, scoring exactly what they scored before.
        Nothing is lost, because nothing there was ever the record.
      </p>
    </div>
  );
}
