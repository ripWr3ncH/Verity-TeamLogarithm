# Verity — measured performance

Every figure below was produced on the hardware and topology named here. **None of it is quoted from a
published Fabric benchmark**, and none of it should be presented as anything other than what a laptop running
the whole consortium can do.

The whitepaper audit flagged this as the submission's one remaining hole: *"❌ No throughput or volume figure
anywhere."* This closes it.

Regenerate with `node scripts/seed-ledger.mjs` and `bash redteam/orderer-fault.sh`.

---

## 1. Environment

| | |
|---|---|
| Host | Windows 11, WSL2 backend, Docker Desktop 29.3.1 |
| CPU | AMD Ryzen 5 5500U, 12 logical cores (mobile part) |
| RAM | 15.4 GB total; WSL2 capped at 10 GB |
| Storage | Docker data root on a mechanical-speed volume, not NVMe |
| Fabric | peer/orderer **3.1.1** · fabric-nodeenv **2.5** · fabric-ca **1.5.22** |
| Node | 22.14.0 (WSL) / 22.18.0 (host) |

**Everything runs on one machine** — five orderers, four peers, four CAs, three chaincode services,
PostgreSQL, the API and the web app, seventeen-plus containers competing for twelve cores. A distributed
deployment on server hardware would not resemble this. Treat these as a floor, not a projection.

## 2. Topology under test

| Component | Count |
|---|---|
| Ordering nodes (SmartBFT) | 5, across 5 organisations |
| Peer organisations | 4 (BankA, BankB, Bangladesh Bank, FRC) |
| Peers | 4, LevelDB state database |
| Channels | 3 — `commitment`, `exposure`, `claims` |
| Chaincode | 3 packages, chaincode-as-a-service |
| Endorsement policy | `AND(OR('BankAMSP.peer','BankBMSP.peer'),'BangladeshBankMSP.peer')` |
| Block cutting | `BatchTimeout 2s`, `MaxMessageCount 10` |

## 3. Sustained throughput

Loading the synthetic portfolio through the **full stack** — HTTP API → fabric-gateway → endorsement by two
organisations → BFT ordering → commit-status wait — not a raw chaincode driver.

| | |
|---|---|
| Transaction mix | 64% `OriginateLoan`, 36% `AppendEvent` |
| Client concurrency | 16 |
| Committed | **776 loans + 443 lifecycle events = 1,219 transactions** |
| Elapsed | **59.8 s** |
| **Sustained throughput** | **20.4 tx/s** |
| Failed | **0** |
| Refused | 30, all `LOAN_EXISTS` — duplicates from an earlier run, correctly rejected |

At concurrency 8 the same workload ran at 9.6 tx/s, so the bottleneck at 16 is client-side batching against a
2-second block timer rather than the ordering service.

> **Every one of the 1,219 transactions carried two officer signatures and authority evidence, and every one
> was endorsed by the originating bank AND Bangladesh Bank before it could commit.** The number is not a
> measure of an empty write path.

## 4. End-to-end latency

Single transaction, measured at the HTTP client, including endorsement by two organisations, BFT ordering,
and waiting for commit status.

| Condition | Latency |
|---|---|
| All five ordering nodes up | **443 ms** |
| **One ordering node stopped** | **423 ms** |
| Immediately after that node rejoined | **351 ms** |

Latency did not degrade with a node down. With `BatchTimeout` at 2 s and blocks cutting at 10 messages, a
single in-flight transaction is dominated by the batch timer, so these figures are a *floor on latency*, not a
ceiling on throughput.

## 5. Byzantine fault injection

`bash redteam/orderer-fault.sh`

| | |
|---|---|
| Ordering | SmartBFT, n = 5 across 5 organisations |
| Tolerance | **f = 1** (BFT requires n ≥ 3f + 1) |
| Fault injected | `orderer3` (rotating bank seat A) stopped |
| Result | **Network continued to order and commit** — block 263 at 423 ms |
| Recovery | Node rejoined in ~1 s; next commit at block 264 |

Expanding to seven ordering organisations would raise tolerance to f = 2. That is a design statement, not a
measurement — it has not been run.

## 6. Ledger growth

| | |
|---|---|
| Blocks after the full load | 264 |
| Transactions | 1,219 |
| Loans projected into the read model | 813 |
| Lifecycle events | 463 |

A lifecycle event carries typed fields, two officer signatures, authority evidence and two state hashes;
exact amounts, borrower references and justifications stay **off-chain in private data collections**, with
only the hash on the public channel. Per-million-event growth has **not** been measured and must not be
extrapolated from 264 blocks — the honest thing to say is that it is not yet known.

## 7. Red team

`node redteam/run.mjs` — **8 of 8 attacks refused.**

| # | Attack | Refusal |
|---|---|---|
| 1 | RS-3 reschedule with no Board signatures | `BOARD_AUTHORISATION_REQUIRED` — supplied 0 of 3 |
| 2 | Approval by an officer of equal seniority | `AUTHORITY_INSUFFICIENT` |
| 3 | Board signature from outside the registered set | `DIRECTOR_NOT_REGISTERED` |
| 4 | Competing bank reads a private payload | hash only, payload never replicated |
| 5 | Unknown event type | `INVALID_EVENT_TYPE` |
| 6 | Stale prior-state hash | `STATE_DIVERGENCE` |
| 7 | One bank raising its own alert threshold | `GOVERNANCE_QUORUM_REQUIRED` — 1 of 3 |
| 8 | **Revoked certificate signs a new event** | `IDENTITY_NOT_VALID` — and the officer's earlier events remain readable |

An intermediate result worth showing: at RS-3 with **two** valid director signatures the refusal reads
*supplied 2 of 3*. Those were real ed25519 signatures, verified against the registered set and counted as
distinct signers — the threshold is not an array-length check.

## 8. What has NOT been measured

Stated so nobody fills the gap with an assumption.

- **Ledger growth per million events.** Extrapolating from 264 blocks would be fabrication.
- **f = 2 tolerance.** Requires seven ordering organisations; not built.
- **Peak throughput.** 20.4 tx/s is what this client configuration sustained, not a ceiling found by search.
- **p95 / p99 latency.** Only single-transaction latencies were timed. A proper percentile distribution needs
  Caliper or an equivalent harness.
- **Distributed topology.** Everything shares one host. Cross-machine ordering has not been tested.
- **Revocation latency.** `redteam/revoke.sh` demonstrates §4.4 end to end — revoke at the CA, generate the
  CRL, write it into the org MSP by channel config update, and the officer can no longer write while their
  earlier events stay valid. How long peers take to apply that config was not timed.

---

*All data synthetic. No real borrower, depositor or institution appears anywhere in these measurements.*
