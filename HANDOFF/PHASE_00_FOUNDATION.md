# Phase 0 — Repository foundation and the Fabric network

**Covers:** sprint days 0–1 · **Status:** written, **not yet run against Docker**
**Next gate:** Gate A — a browser click producing a real transaction ID (day 2)

---

## 1. What state the repo is in

| Item | State |
|---|---|
| `.gitignore` | ✅ committed **before** any `npm install` — do not relax it |
| Root workspace (`package.json`, `tsconfig.base.json`) | ✅ |
| `README.md` with the honesty table | ✅ |
| `network/configtx.yaml` — 3 channel profiles, BFT, 5 consenters | ✅ written |
| `network/crypto-config.yaml` — 5 orderer orgs, 4 peer orgs | ✅ written |
| `network/compose/compose-net.yaml` — 5 orderers, 4 peers, cli | ✅ written |
| `network/bootstrap.sh` — binaries + images | ✅ written |
| `network/network.sh` — up / down / channels / status / kill-orderer | ✅ written |
| Chaincode | ❌ Phase 1 |
| Services, web | ❌ Phases 3–4 |

> 🔴 **Nothing in `network/` has been executed yet.** It was written on a machine
> where Docker was stopped. Treat the first `./network.sh up` as a debugging
> session, not a formality — that is exactly what sprint day 0 is budgeted for.
> §4 below lists what is most likely to break first.

---

## 2. What I did, and why

### 2.1 Four peer organisations, not two

Whitepaper §4.2 names Bangladesh Bank, participating banks, the FRC and auditors. The prototype runs
**BankA (Sammilito), BankB (Meghna), BangladeshBank, FRC**.

**BankB is not decoration.** Without a second bank there is no cross-bank aggregation (Module II) and, more
importantly, **no privacy demo** — Act 3a of the demo is "run the same query from two identities, one gets the
payload and one gets a hash". That needs two real organisations with real MSPs. Do not drop BankB to save
memory; drop a peer from BankA instead.

### 2.2 Five orderers across five organisations

Straight from §4.1: Bangladesh Bank, BIBM, FRC, and two rotating bank seats. BFT needs `n ≥ 3f + 1`, so five
nodes tolerate **f = 1**. Four would also tolerate f = 1 — five matches the paper, and one extra container is
cheap.

`./network.sh kill-orderer 3` stops one on demand. That is Act 5 of the demo.

### 2.3 Three chaincode packages, not five

The plan lists five logical contracts (lifecycle, exposure, liability, claims, governance). **Deploying five
separate chaincodes to four peers means seventeen-plus chaincode containers**, which is a lot of memory for
no benefit.

Fabric lets one chaincode package export several `Contract` classes, so we package **one chaincode per
channel**:

| Channel | Package | Contracts inside |
|---|---|---|
| `commitment` | `chaincode/commitment` | `LifecycleContract`, `GovernanceContract`, `AccessLogContract` |
| `exposure` | `chaincode/exposure` | `ExposureContract` |
| `claims` | `chaincode/claims` | `LiabilityContract`, `ClaimsContract` |

Ten chaincode containers instead of seventeen, and the boundary is architecturally honest — a chaincode
cannot read another channel's state anyway.

### 2.4 Chaincode is deliberately NOT an npm workspace

Fabric packages a chaincode *directory* and runs `npm install` inside the peer's build container. Workspace
symlinks do not resolve there, and the failure is a confusing runtime error rather than a build error.

So each chaincode package is **self-contained**: its own `package.json`, its own dependencies, and any shared
types **duplicated** rather than imported from `packages/`. That duplication is deliberate. Do not "fix" it.

`packages/` is for code consumed by `services/` and `web/` only.

### 2.5 cryptogen for the network, Fabric CA for humans

`crypto-config.yaml` bootstraps peers and orderers with cryptogen — fewer moving parts on day 0.

**The Fabric CA containers arrive in Phase 3**, because §4.4 needs two things cryptogen cannot do:
role attributes on officer certificates (`role`, `seniority`, `institution`) and **CRL-based revocation**,
which is red-team attack #8. The CA must issue user identities under the *same root* as the org's MSP.

### 2.6 LevelDB, not CouchDB

Peer state database is `goleveldb`. Rich queries belong in the off-chain read model (Phase 3), which is the
standard Fabric pattern *and* halves container memory. It also sets up the strongest architecture answer in
the demo: wipe the read model and rebuild it from block 0, live, proving the ledger is the source of truth.

### 2.7 Signcert filenames are normalised

`network.sh` runs `normaliseSigncerts()` after cryptogen: every `msp/signcerts/` directory gets a `cert.pem`.

Some cryptogen versions write `<CN>-cert.pem`, others write `cert.pem`, and `configtx.yaml`'s
`ConsenterMapping.Identity` needs one deterministic path. Copying costs nothing and removes a whole class of
"file not found" failures. **Leave it in.**

### 2.8 Port map

| Component | Host ports |
|---|---|
| Orderers, general | 7050–7054 |
| Orderers, admin (osnadmin) | 8050–8054 |
| Orderers, operations | 8450–8454 |
| Peers | 9051 (BankA), 9061 (BankB), 9071 (BB), 9081 (FRC) |
| Peer operations | 9451, 9461, 9471, 9481 |
| Fabric CAs *(Phase 3)* | 10054, 10064, 10074, 10084 |

---

## 3. Where I stopped — the exact next steps

```bash
cd network

# 1. Once per machine. Needs internet, 15-30 min.
./bootstrap.sh

# 2. The moment of truth.
./network.sh up

# 3. Should show 9 Fabric containers and three channels at height 1.
./network.sh status
```

**When `up` succeeds, commit immediately and tag it.** This is the foundation everything else stands on:

```bash
git add -A && git commit -m "network: Fabric v3 BFT network up, three channels live"
git tag phase-0-network-up && git push --tags
```

Then Phase 1 — the lifecycle chaincode. `HANDOFF/PHASE_01_LIFECYCLE.md`.

---

## 4. What will bite you

Ordered by how likely it is to happen on the first run.

### 4.1 `configtxgen` rejects a `SmartBFT` field

**Symptom:** `error unmarshaling config into struct ... field X not found`.
**Fix:** delete that line from `configtx.yaml`. The `SmartBFT` block is written out explicitly so the values
are auditable, but every field has a Fabric default. Omitting the whole block is valid.

### 4.2 `ConsenterMapping` cannot find a certificate

**Symptom:** `open ../organizations/.../signcerts/cert.pem: no such file or directory`.
**Cause:** paths in `configtx.yaml` are relative to **`FABRIC_CFG_PATH`**, not to the file's own location.
`network.sh` sets `FABRIC_CFG_PATH=network/config`, so `../organizations/...` resolves to
`network/organizations/...`. If you move `configtx.yaml`, fix the paths too.
**Check:** `ls network/organizations/ordererOrganizations/ord-bb.verity.bd/orderers/*/msp/signcerts/`

### 4.3 Orderers start, then die in a view-change loop

**Symptom:** containers restart repeatedly; logs mention `view change` or `failed to verify`.
**Cause:** almost always a mismatch between `ConsenterMapping` and the TLS certificates actually mounted —
wrong host, wrong port, or stale crypto material from a previous run.
**Fix:** `./network.sh down` then `up`. `down` deletes `organizations/` and `channel-artifacts/` precisely so
half-regenerated material cannot survive.

### 4.4 `osnadmin channel join` refuses the connection

**Symptom:** `connection refused` on `localhost:8050`.
**Cause:** the orderer has not finished starting. `network.sh` sleeps 8 seconds; a cold laptop may need more.
**Fix:** raise the `sleep 8` in `startContainers()`. If it still fails, `docker logs orderer0.ord-bb.verity.bd`.

### 4.5 Docker Desktop is not running

`./network.sh up` checks for this and says so plainly. On Windows, launch Docker Desktop and wait for the
whale icon to stop animating **before** running anything in WSL.

### 4.6 Disk

`docker_data.vhdx` was **22.3 GB** on C: with only 13.6 GB free when this repo was created. Move Docker's disk
image to G: before `bootstrap.sh` pulls images. Details in
`WinningProjects/10_Prototype_Plan/04_ENV_SETUP.md` §1.

---

## 5. If day 1 ends and the network is still fighting you

**Do not spend day 2 on it.** Gate A — a browser click producing a real transaction ID — is the *mandatory*
evaluation criterion, and it outranks the topology.

Fallback, in order:

1. Drop to **4 orderers** (still `f = 1`). Remove `orderer4` from `compose-net.yaml`, `configtx.yaml`
   `Addresses` and `ConsenterMapping`, and the `ORDERERS` array in `network.sh`.
2. Drop to **2 peer orgs** (BankA + BangladeshBank). You lose the Act 3a privacy demo temporarily; add BankB
   back on day 9.
3. Switch `OrdererType: BFT` → `etcdraft` to get *something* running, take Gate A, and return to BFT on day 9.
   **If you ship Raft, say so** — §4.1 argues for BFT specifically because the threat model includes collusion,
   and claiming BFT while running Raft is the kind of thing a technical judge checks with `docker logs`.

Record whichever fallback you took at the top of this file, so nobody presents a topology we are not running.
