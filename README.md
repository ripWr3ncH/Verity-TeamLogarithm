# VERITY

**Making loan classification tamper-evident in Bangladesh's banking system.**
Prototype · BCOLBD 2026, Blockchain Category (Student) · Team Logarithm

> **Build status: Phase 4 of 5 — the network runs.** BFT ordering live, all three
> chaincodes deployed, 15 identities enrolled, refusals firing and the Council
> quorum flow completing end to end. 162/162 unit tests green. The web portals
> are Phase 5. The section
> [What is built, and what is not](#what-is-built-and-what-is-not) is kept
> honest at every commit. See [`HANDOFF/`](HANDOFF/) for where work stopped.

---

## The problem in one paragraph

Bangladesh's gross non-performing loan ratio stood at **32.26% in March 2026**. An Asset Quality Review of six
banks by Ernst & Young and KPMG assessed **Tk 147,595 crore** of non-performing loans against **Tk 35,044
crore** reported — about 4.2 times. Bangladesh Bank's rules are not what is missing: every classification must
already be justified in writing over two named signatures, rescheduling is capped at three occasions, and the
third attempt needs Board approval. **The record is what is missing.** It is held by the institution being
examined, it can be revised afterwards, and it is read only when an inspector is physically present. Verity
commits those existing signatures to an append-only ledger, checks the approval authority in code rather than
trusting a self-reported field, and measures rescheduling against the statutory quarterly calendar.

Full argument: the whitepaper, `VERITY_Whitepaper_v12`.

---

## Run it

Requires **Docker**, **Node 20+**, and **WSL2** on Windows. First run takes 15–30 minutes,
almost all of it downloading Fabric images.

```bash
git clone https://github.com/ripWr3ncH/Verity-TeamLogarithm
cd Verity-TeamLogarithm

source network/scripts/wsl-env.sh   # WSL2 only: Node + jq into user space, no sudo
cd network && ./bootstrap.sh        # once per machine: binaries + images (15-30 min)
cd .. && ./scripts/up.sh            # network, CAs, identities, chaincode, services, seed
```

Then `curl -s localhost:4000/health` and `./network/network.sh status`.
The web portals arrive in Phase 5.

To stop and clean: `./scripts/down.sh`.

---

## What is built, and what is not

Kept current. We would rather state this than be asked.

| Component | Status |
|---|---|
| Fabric v3 BFT network — 5 ordering orgs, 4 peer orgs, 3 channels | ✅ **running** — 17 containers |
| Lifecycle chaincode — signed events, k-of-n authority evidence, statutory calendar | ✅ **deployed**, 38 unit tests |
| Governance chaincode — Council parameters, quorum-gated change | ✅ **deployed and verified live** |
| Supervisory access log — every regulator read recorded | ✅ deployed |
| Cryptography — Paillier, Shamir, supervisor-plus-quorum ceremony, Merkle sum | ✅ **43 tests** |
| Exposure chaincode — on-chain aggregation, proof-checked ceremony results | ✅ **deployed**, 17 tests |
| Liability + claims chaincode — signed-leaf roots, claim tokens | ✅ **deployed**, 12 tests |
| EDI engine — equations (1) and (2), base-rate calibration | ✅ **32 tests** |
| Deterministic synthetic seed data | ✅ **20 tests** |
| Identities — 15 officers, CA-issued role attributes read by chaincode | ✅ **enrolled and verified** |
| API gateway — one X.509 identity per officer | ⏳ typechecks, not yet run |
| Block listener + read model, rebuildable from block 0 | ⏳ typechecks, not yet run |
| Mock core banking system with a read-only adapter grant | ⏳ written, not yet run |
| Private data collections | ❌ **not deployed** — see HANDOFF/PHASE_04 §5.1 |
| Bank officer · supervisor · depositor portals | ⏳ Phase 5 |
| Benchmark, red-team suite, demo assets | ⏳ Phase 5 |

**Out of scope for this prototype, and deliberately so:**

- **No zk-SNARK solvency circuit.** Designed in whitepaper §3.7.3; not built here, and we do not imply otherwise.
- **No secondary transfer of claim tokens — not even a disabled button.** §7.4 #9 asserts no legal authority
  for it. A trading interface would contradict our own paper.
- **No production HSM.** Officer keys use SoftHSM2 over PKCS#11 — the same interface as the FIPS 140-3
  Level 3 target, not the same assurance level.
- **All data is synthetic.** No real borrower, depositor or institutional data appears anywhere.
- **λ and E\* are illustrative.** They are Council-set parameters and must be calibrated against the measured
  system-wide base rate. The EDI is a screening indicator, not a finding of misconduct.

---

## Architecture

**Platform: Hyperledger Fabric v3, permissioned, SmartBFT ordering.** Not a public chain, because positions
must not be publicly readable and anonymous validators cannot be accountable under the Bank Companies Act.
**Not Raft**, because Raft is crash-fault-tolerant — it assumes nodes fail rather than lie — and our threat
model explicitly includes collusion among consortium members.

**Ordering service — 5 nodes across 5 organisations.** BFT requires `n ≥ 3f + 1`, so this tolerates **f = 1**.

| Node | Organisation |
|---|---|
| `orderer0` | Bangladesh Bank |
| `orderer1` | BIBM — institutional neutrality |
| `orderer2` | Financial Reporting Council |
| `orderer3` | Rotating bank seat A |
| `orderer4` | Rotating bank seat B |

**Peer organisations — 4.**

| Org | MSP | Role |
|---|---|---|
| Sammilito Islami Bank | `BankAMSP` | Originating institution, resolution entity |
| Meghna Bank | `BankBMSP` | Second institution — makes cross-bank aggregation and the privacy demo real |
| Bangladesh Bank | `BangladeshBankMSP` | Supervisor. Endorses every lifecycle event; holds rights from genesis and cannot be voted out |
| Financial Reporting Council | `FRCMSP` | Query peer. Reads all, borrower identity never |

**Channels — 3**, matching whitepaper §4.2: `commitment`, `exposure`, `claims`.
One chaincode package per channel, each exposing several contracts.

**On-chain:** commitment hashes, signed typed events, authority evidence, liability roots, group-token
attestations, encrypted exposure ciphertexts, claim tokens.
**Off-chain, hash-anchored:** loan agreements, KYC, PII, individual balances, valuation reports.

**Peer state database is LevelDB, not CouchDB.** Rich queries live in an off-chain read model rebuilt from
block 0 by a block-event listener — the standard Fabric pattern, and it halves container memory.

---

## Repository layout

```
network/      Fabric network — configtx, cryptogen, compose, control scripts
chaincode/    Smart contracts, one package per channel (self-contained, not workspaces)
packages/     Shared pure domain logic — EDI engine, Merkle sum tree, types
services/     API gateway, block listener, mock core banking system
web/          Next.js — bank officer, supervisor and depositor portals
seed/         Synthetic portfolios, including the whitepaper's Table 2 exposure
bench/        Throughput and latency measurement
redteam/      Eight attacks, eight expected refusals
HANDOFF/      Phase notes — read the newest before picking work up
```

---

## Team

| Member | Responsibility |
|---|---|
| *[name]* | Architecture, consensus design — Fabric network, BFT, benchmark |
| *[name]* | Cryptography — authority evidence, Paillier, Merkle sum tree |
| *[name]* | Smart contracts and data model |
| *[name]* | Banking regulation and domain research |
| *[name]* | Market analysis and business model |
| *[name]* | Verification interface design and documentation |

---

## Licence

MIT — see [LICENSE](LICENSE).
