-- ==========================================================================
--  VERITY — the off-chain read model.
--
--  Rebuilt from block 0 by services/listener. NOT a source of truth: the ledger
--  is. Every row here is derived from a committed transaction, which is why the
--  supervisor portal offers "Rebuild from block 0" and runs it live.
--
--  That button is the cleanest available refutation of the question every judge
--  asks — "is this really on a blockchain, or a database with hashes?" We wipe
--  the database in front of them and replay the chain into it.
--
--  Peers run LevelDB, not CouchDB, precisely so rich queries live here instead
--  of on the peer. Standard Fabric practice, and it halves container memory.
-- ==========================================================================

CREATE SCHEMA IF NOT EXISTS readmodel;

-- --------------------------------------------------------------------------
--  Replay position, so a restart resumes rather than duplicates.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS readmodel.checkpoint (
    channel        TEXT PRIMARY KEY,
    last_block     BIGINT      NOT NULL DEFAULT 0,
    events_applied BIGINT      NOT NULL DEFAULT 0,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
--  Projected ledger state
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS readmodel.loan (
    commitment_id       TEXT PRIMARY KEY,
    institution_msp     TEXT        NOT NULL,
    current_tier        TEXT        NOT NULL,
    prev_state_hash     TEXT        NOT NULL,
    rs_sequence         INTEGER     NOT NULL DEFAULT 0,
    outstanding_band    TEXT        NOT NULL,
    outstanding_poisha  NUMERIC(20),
    origination_ts      TIMESTAMPTZ NOT NULL,
    sanctioning_seniority INTEGER   NOT NULL,
    group_token         TEXT,
    event_count         INTEGER     NOT NULL DEFAULT 0,
    status              TEXT        NOT NULL DEFAULT 'ACTIVE',
    -- Cached EDI, recomputed whenever a rescheduling lands or lambda changes.
    edi_score           DOUBLE PRECISION NOT NULL DEFAULT 0,
    cap_flag            BOOLEAN     NOT NULL DEFAULT FALSE,
    last_block          BIGINT      NOT NULL
);

CREATE INDEX IF NOT EXISTS loan_institution_idx ON readmodel.loan(institution_msp);
CREATE INDEX IF NOT EXISTS loan_edi_idx         ON readmodel.loan(edi_score DESC);
CREATE INDEX IF NOT EXISTS loan_group_idx       ON readmodel.loan(group_token);

CREATE TABLE IF NOT EXISTS readmodel.lifecycle_event (
    commitment_id          TEXT        NOT NULL,
    seq                    INTEGER     NOT NULL,
    event_type             TEXT        NOT NULL,
    event_ts               TIMESTAMPTZ NOT NULL,
    classification_ref_date DATE       NOT NULL,
    -- d_j in equation (1). The term the quarterly return does not carry.
    days_to_next_ref_date  INTEGER     NOT NULL,
    -- r_j in equation (1).
    rs_seq                 INTEGER     NOT NULL DEFAULT 0,
    tier_before            TEXT        NOT NULL,
    tier_after             TEXT        NOT NULL,
    prev_state_hash        TEXT        NOT NULL,
    new_state_hash         TEXT        NOT NULL,
    authority_kind         TEXT        NOT NULL,
    assigning_officer      TEXT,
    reviewing_officer      TEXT,
    director_signature_count INTEGER   NOT NULL DEFAULT 0,
    payload_hash           TEXT        NOT NULL,
    note                   TEXT,
    tx_id                  TEXT        NOT NULL,
    block_number           BIGINT      NOT NULL,
    committed_by_msp       TEXT        NOT NULL,
    PRIMARY KEY (commitment_id, seq)
);

CREATE INDEX IF NOT EXISTS event_reschedule_idx
    ON readmodel.lifecycle_event(event_type, days_to_next_ref_date)
    WHERE event_type = 'RESCHEDULE';

-- --------------------------------------------------------------------------
--  Supervisory access log (§4.7) — oversight is watched too.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS readmodel.access_log (
    id          BIGSERIAL PRIMARY KEY,
    ts          TIMESTAMPTZ NOT NULL,
    actor_id    TEXT        NOT NULL,
    actor_msp   TEXT        NOT NULL,
    resource    TEXT        NOT NULL,
    action      TEXT        NOT NULL,
    tx_id       TEXT        NOT NULL UNIQUE,
    block_number BIGINT     NOT NULL
);

CREATE INDEX IF NOT EXISTS access_resource_idx ON readmodel.access_log(resource, ts DESC);

-- --------------------------------------------------------------------------
--  Governance (§4.6) — parameter changes as attributable events.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS readmodel.parameter (
    name           TEXT PRIMARY KEY,
    value          DOUBLE PRECISION NOT NULL,
    effective_from TIMESTAMPTZ NOT NULL,
    proposal_id    TEXT        NOT NULL,
    changed_by_tx  TEXT        NOT NULL
);

CREATE TABLE IF NOT EXISTS readmodel.parameter_change (
    id            BIGSERIAL PRIMARY KEY,
    parameter     TEXT        NOT NULL,
    from_value    DOUBLE PRECISION NOT NULL,
    to_value      DOUBLE PRECISION NOT NULL,
    proposal_id   TEXT        NOT NULL,
    -- Every Council organisation that approved. Named, on the record.
    approved_by   TEXT[]      NOT NULL,
    tx_id         TEXT        NOT NULL,
    block_number  BIGINT      NOT NULL,
    changed_at    TIMESTAMPTZ NOT NULL
);

-- --------------------------------------------------------------------------
--  CL-1 reconciliation (§3.7.1) — omission is prevented by comparison.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS readmodel.reconciliation (
    id                BIGSERIAL PRIMARY KEY,
    institution_msp   TEXT        NOT NULL,
    reference_date    DATE        NOT NULL,
    commitment_id     TEXT,
    loan_account_no   TEXT,
    finding           TEXT        NOT NULL
        CHECK (finding IN ('ON_LEDGER_NOT_IN_CL1','IN_CL1_NOT_ON_LEDGER','CLASSIFICATION_DIVERGES','MATCHED')),
    ledger_value      TEXT,
    filed_value       TEXT,
    detected_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reconciliation_finding_idx
    ON readmodel.reconciliation(institution_msp, reference_date, finding);

-- --------------------------------------------------------------------------
--  Module II and III projections
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS readmodel.exposure_alert (
    period            TEXT        NOT NULL,
    group_token       TEXT        NOT NULL,
    total             NUMERIC(30) NOT NULL,
    threshold         NUMERIC(30) NOT NULL,
    contributor_count INTEGER     NOT NULL,
    -- Who took part in the decryption ceremony. Supervisor + quorum (§3.7.2).
    participants      TEXT[]      NOT NULL,
    proof_verified    BOOLEAN     NOT NULL,
    tx_id             TEXT        NOT NULL,
    block_number      BIGINT      NOT NULL,
    PRIMARY KEY (period, group_token)
);

CREATE TABLE IF NOT EXISTS readmodel.liability_root (
    institution_msp TEXT        NOT NULL,
    period          TEXT        NOT NULL,
    merkle_root     TEXT        NOT NULL,
    committed_sum   NUMERIC(30) NOT NULL,
    leaf_count      INTEGER     NOT NULL,
    -- Leaves turned away for want of a depositor signature. Visible on purpose.
    rejected_count  INTEGER     NOT NULL DEFAULT 0,
    tx_id           TEXT        NOT NULL,
    block_number    BIGINT      NOT NULL,
    PRIMARY KEY (institution_msp, period)
);

CREATE TABLE IF NOT EXISTS readmodel.claim (
    claim_id        TEXT PRIMARY KEY,
    leaf_hash       TEXT        NOT NULL,
    institution_msp TEXT        NOT NULL,
    period          TEXT        NOT NULL,
    depositor_key   TEXT        NOT NULL,
    face_value      NUMERIC(30) NOT NULL,
    priority_class  TEXT        NOT NULL,
    schedule        TEXT        NOT NULL,
    tx_id           TEXT        NOT NULL,
    block_number    BIGINT      NOT NULL
);

CREATE INDEX IF NOT EXISTS claim_depositor_idx ON readmodel.claim(depositor_key);

-- ==========================================================================
--  Rebuild. Called by the "Rebuild from block 0" control in the supervisor
--  portal, live, in front of the judges.
-- ==========================================================================
CREATE OR REPLACE PROCEDURE readmodel.truncate_all()
LANGUAGE SQL
AS $$
    TRUNCATE readmodel.loan, readmodel.lifecycle_event, readmodel.access_log,
             readmodel.parameter, readmodel.parameter_change, readmodel.reconciliation,
             readmodel.exposure_alert, readmodel.liability_root, readmodel.claim,
             readmodel.checkpoint;
$$;

COMMENT ON PROCEDURE readmodel.truncate_all() IS
    'Wipes every projection. The listener then replays the chain from block 0 and '
    'reconstructs all of it, which demonstrates that the ledger is the source of truth '
    'and this schema is a cache.';
