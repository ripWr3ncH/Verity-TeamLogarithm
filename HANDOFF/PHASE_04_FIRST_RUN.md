# Phase 4 — First run against Docker

**Status:** ✅ **The network runs.** BFT ordering live, all three chaincodes deployed, identities enrolled,
refusals firing, the Council quorum flow completing end to end.
**Next gate:** Gate A — a *browser* click producing a transaction ID. The chain half is done; the UI is not.

---

## 1. What is running

17 Fabric containers:

| Group | Containers |
|---|---|
| Ordering (BFT, n=5, f=1) | `orderer0.ord-bb` · `orderer1.ord-bibm` · `orderer2.ord-frc` · `orderer3.ord-seata` · `orderer4.ord-seatb` |
| Peers | `peer0.banka` · `peer0.bankb` · `peer0.bb` · `peer0.frc` |
| Certificate authorities | `ca-banka` · `ca-bankb` · `ca-bb` · `ca-frc` |
| Chaincode services | `cc-commitment` · `cc-exposure` · `cc-claims` |
| Tooling | `verity-cli` |

Three channels (`commitment`, `exposure`, `claims`), 15 enrolled identities, 162 unit tests still green.

**Recorded versions** — the benchmark annexe needs these, and "latest" is not an answer:

```
Fabric peer/orderer  3.1.1
fabric-nodeenv       2.5
fabric-ca            1.5.22
fabric-tools         2.5
```

---

## 2. Verified live, not just unit-tested

Run as **named officers with CA-issued certificates**, against the real network:

| Behaviour | Result |
|---|---|
| Origination by `officer-rahim` | `sanctioningOfficerRole: "sanctioning_officer", sanctioningSeniority: 2` — **read from his certificate**, not the payload |
| **RED TEAM #4** — BankB writes to BankA's exposure | `UNAUTHORISED_INSTITUTION: BankBMSP cannot write to an exposure held by BankAMSP` |
| **RED TEAM #5** — modify a committed event | `APPEND_ONLY: committed events cannot be modified; submit a CORRECTION event…` |
| **RED TEAM #7** — BankA alone raises its own alert threshold | `GOVERNANCE_QUORUM_REQUIRED: 'eStar' has 1 of 3 required approvals` |
| para 11(c) enforcement | `PARA_11C: … the assigning officer's signature is not over this event` |
| Council quorum, full cycle | refused at 1 of 3 → refused at 2 of 3 → **activated at 3 of 3**, `eStar 0.5 → 1.117`, approvals recorded as `["BankAMSP","BangladeshBankMSP","FRCMSP"]` |

> **Act 5 works, and it lands on the number Act 2's analysis produced.** The seed population's 95th
> percentile is 1.117 against the whitepaper's illustrative E\* of 0.50. Proposing exactly that value on
> stage makes Act 2 and Act 5 one continuous argument instead of two disconnected demos.

---

## 3. Six real defects found and fixed

Every one of these would have cost hours on demo week.

### 3.1 The Fabric version matrix is not uniform

`fabric-tools` and `fabric-nodeenv` publish **no 3.x tags**. Pulling them at 3.1.1 fails with
`docker.io/hyperledger/fabric-tools:3.1.1: not found`.

This is not a workaround: Fabric 3.1.1's own `config/core.yaml` pins `node.runtime: fabric-nodeenv:2.5`.
A 3.1.1 peer is *designed* to launch Node chaincode on the 2.5 runtime. `fabric-ca:1.5.15` also does not
exist — 1.5.22 is current. Fixed in `bootstrap.sh` with the matrix written out and explained.

### 3.2 `configtxgen` was reading the wrong `configtx.yaml`

`FABRIC_CFG_PATH` is `network/config`, which holds the **stock** config shipped with the binaries — and
that has no Verity profiles, so `Could not find profile: VerityCommitment`.

Fixed with `-configPath "${ROOT}"`. Consequence: relative paths inside `configtx.yaml` resolve against the
directory holding *that file*, so they are now `organizations/…`, not `../organizations/…`. **Change one and
you must change the other.**

### 3.3 V3_0 forbids global orderer addresses

```
global orderer endpoints exist, but can not be used with V3_0 capability
```

The `Orderer.Addresses:` list is not allowed under the V3_0 channel capability. Endpoints belong to the
organisation that operates the node — each ordering org's `OrdererEndpoints` is the only place they go.

### 3.4 There is no `ImplicitOrderer` policy type

`BlockValidation: {Type: ImplicitOrderer, Rule: SMARTBFT}` fails with `unknown policy type`. Fabric applies
SmartBFT's block-signature rules **internally** once `OrdererType: BFT`; the channel policy stays
`ImplicitMeta / ANY Writers`, exactly as the stock Fabric 3.1.1 config does.

### 3.5 The peer cannot build chaincode images on Docker Desktop + WSL2

```
could not build chaincode: docker build failed:
write unix @->/var/run/docker.sock: write: broken pipe
```

The socket was mounted and `CORE_VM_ENDPOINT` was correct. Docker Desktop's socket proxy simply does not
survive the build upload. Reducing the package from ~150 MB to 36 KB did not help either — it is not size.

**Switched to Chaincode-as-a-Service.** Fabric 3.x ships the builder (`/opt/hyperledger/ccaas_builder`);
each chaincode now runs as its own container that the peer dials. Two things this buys beyond making it
work:

- **the peers no longer mount the host Docker socket at all**, so a chaincode package can never reach the
  host daemon — a straightforwardly better security posture, and worth saying to a judge
- chaincode containers are explicit and restartable, so a contract redeploys without touching the network

`chaincode/Dockerfile` builds them; `scripts/deploy-cc.sh` starts them with the package ID passed through
(never retyped — a mismatch is rejected with an error that does not say which side is wrong).

### 3.6 ⚠ The CA silently generated its own root

The nastiest of the six. `compose-ca.yaml` points at `ca-cert.pem` / `ca-key.pem`, but cryptogen writes
`ca.<domain>-cert.pem` and a hash-named `*_sk`.

**Fabric CA did not fail.** It generated a self-signed root of its own, every enrolment succeeded, and the
first transaction died with:

```
access denied: channel [commitment] creator org unknown, creator is malformed
```

— which mentions no certificate authority at all. Diagnosed by comparing issuers:

```
org MSP root : CN = ca.banka.verity.bd        (cryptogen)
officer cert : CN = fabric-ca-server          (the CA's own invention)
```

Fixed by `normaliseCaMaterial()` in `network.sh`, the same filename-normalisation lesson as the signcerts.
After the fix both read `CN = ca.banka.verity.bd`.

---

## 4. Environment findings for a fresh machine

### 4.1 WSL2 needs Node and jq, and `sudo` may want a password

Neither is installable with `sudo apt` on a machine where sudo prompts. Both are now handled without root:

- `network/scripts/wsl-env.sh` installs Node into `~/.local/node` — **source it before anything else**
- `bootstrap.sh` fetches the `jq` static binary into `network/bin`

```bash
source network/scripts/wsl-env.sh
```

### 4.2 `--waitForEvent` reports false failures here

```
Error: error receiving from deliver filtered at localhost:9051:
rpc error: code = DeadlineExceeded ... RST_STREAM ... CANCEL
```

**The transaction commits anyway.** Verified: the "failed" origination was on the ledger, and re-submitting
returned `LOAN_EXISTS`. Only the event-delivery wait times out, on Docker Desktop's networking.

Do not use `--waitForEvent` in demo scripts — invoke, sleep 3, then query. The API uses `fabric-gateway`'s
commit-status service rather than the deliver stream, so this should not affect it; **confirm that during
Phase 5** before relying on it in front of judges.

### 4.3 Endorsers and submitters are different questions

The FRC can *submit* a governance vote — that is what gets recorded as its approval — but the endorsement
policy is `AND(OR(BankA.peer, BankB.peer), BangladeshBank.peer)`, so the *endorsing peers* must always
include a bank peer and Bangladesh Bank's, whoever submits.

Targeting `--peerAddresses` at FRC+BB gives a transaction that endorses fine and then **fails validation
silently at commit** — the approval count simply does not increase. That cost twenty minutes here. The API
already targets the right peers; keep it that way.

### 4.4 Transient Docker Hub DNS failures in WSL

One `claims` build failed with `lookup auth.docker.io ... i/o timeout` even though `node:22-alpine` was
already cached locally. Retrying with `DOCKER_BUILDKIT=0` succeeded — the legacy builder does not
round-trip for a registry token when the image is present. Harmless, but expect it.

---

## 5. Where I stopped

```bash
source network/scripts/wsl-env.sh
cd network && ./bootstrap.sh          # once per machine
cd .. && ./scripts/up.sh              # everything
```

The network, chaincode, identities and governance all work. **Not yet exercised:**

- [ ] `services/api` and `services/listener` against the live network (they typecheck but have never run)
- [ ] Postgres read model and the block listener
- [ ] Module II end to end — the Paillier ceremony against `cc-exposure`
- [ ] Module III/IV — liability roots and claim tokens against `cc-claims`
- [ ] Private data collections (Act 3a's two-identity comparison needs them; the `commitment` channel
      currently has none, so BankB can *read* BankA's loan record — **this is the next correctness gap to close**)
- [ ] The orderer-kill demonstration
- [ ] The web portals — Phase 5

### 5.1 The one thing to fix before the demo

**Private data collections are not deployed.** Act 3a claims that the same query returns a payload to one
identity and a hash to another. Right now every `commitment` channel member can read every loan record,
because the PDC definitions in the plan were never added to the chaincode deployment.

That is the difference between a demonstration and a claim. It belongs at the top of Phase 5.
