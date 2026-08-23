# Phase 5 — Services live, end to end

**Status:** ✅ The full pipeline runs. API writes to the ledger and returns receipts; the listener replays the
chain into the read model; private data collections enforce Act 3a.
**Next gate:** Gate A — the *browser* half. Everything behind the UI now works.

---

## 1. What was proven live

### 1.1 The API writes to the chain and returns a receipt

```
POST /loans   X-Verity-Identity: officer-rahim

{ "result":  { "commitmentId": "BD-API-8998", "stateHash": "d1d4df77…", "txId": "f0d49995…" },
  "receipt": { "txId": "f0d49995…", "blockNumber": "25",
               "endorsers": ["originating bank peer", "BangladeshBankMSP peer"],
               "channel": "commitment", "contract": "LifecycleContract" } }
```

That receipt is the mandatory back-end criterion made visible. `endorsers` is what shows a judge that the
bank's peer alone was not enough (§3.8 step 4).

### 1.2 Refusals arrive with the contract's own words

```
POST /events   X-Verity-Identity: officer-shirin     → HTTP 422
{ "refused": true,
  "code": "UNAUTHORISED_INSTITUTION",
  "message": "UNAUTHORISED_INSTITUTION: BankBMSP cannot write to an exposure held by
              BankAMSP; no participant may write another institution's record" }
```

### 1.3 The read-only adapter grant, checkable in ten seconds

```
psql -U verity_adapter -c "select count(*) from cbs.loan_master"   →  works
psql -U verity_adapter -c "update cbs.loan_master set ..."         →  ERROR: permission denied
psql -U verity_adapter -c "insert into cbs.borrower ..."           →  ERROR: permission denied
```

PostgreSQL refuses it, not our application code. That is §4.3's claim, demonstrated rather than asserted,
and it answers the rubric's *"is integration with legacy systems addressed?"* better than any diagram.

### 1.4 The listener reconstructs the dashboard from block 0

```
[listener] following 'commitment' from block 0
loan: 5   lifecycle_event: 6   parameter: 1   parameter_change: 1
checkpoint: commitment -> block 25, 9 events, 0 projection failures
```

Two rows worth looking at:

| What | Value |
|---|---|
| `BD-PDC-25368` EDI | **0.698** — the exact first value of the whitepaper's Table 2 series (RS-1, 12 days before 30 June) |
| `parameter_change` | `eStar 0.5 → 1.117`, `approved_by {BankAMSP, BangladeshBankMSP, FRCMSP}` |

The EDI was recomputed inside the listener from a *committed event* and reproduced a published number. That
is chaincode → ledger → listener → EDI engine → read model, agreeing with the submitted paper.

### 1.5 Private data collections — Act 3a

Same query, two identities:

| Caller | `authorised` | Payload | Hash |
|---|---|---|---|
| `BangladeshBankMSP` | true | borrower reference, exact amount, justification, valuation | `61311e69263a1b409e54` |
| `BankBMSP` | false | — | `61311e69263a1b409e54` |

Both saw the **same hash**. The payload was never disseminated to BankB's peer; Fabric stops it at the gossip
layer, so the chaincode could not reveal it if it wanted to.

---

## 2. Four more defects found and fixed

### 2.1 ESM output with extensionless imports does not run

`services/api` and `services/listener` are `"type": "module"` but were compiled with
`moduleResolution: bundler`, which allows `from './identities'`. Node's ESM loader requires the extension at
runtime, so the build typechecked and then failed to start.

Fixed: `module`/`moduleResolution` → `NodeNext`, and every relative import carries `.js`.
**A clean `tsc` is not proof that a service starts.**

### 2.2 A client mistake was being reported as a chaincode refusal

`handle()` ran `extractRefusal()` first, and `IDENTITY_REQUIRED: send X-Verity-Identity…` matches the refusal
pattern — so a missing header returned **422 with `refused: true`**, indistinguishable from a policy decision.

Errors carrying their own `statusCode` come from the API layer and are now returned as-is (400) before any
refusal matching. The red-team suite asserts on refusal codes; a typo must never look like a rule firing.

### 2.3 ⚠ The refusal message was the gRPC status, not the contract's

The one that mattered most. A fabric-gateway `EndorseError`'s own `.message` is:

```
ABORTED: failed to endorse transaction, see attached details for more info
```

The message the **contract** wrote is nested in `.details[]`, one entry per endorsing peer. `extractRefusal`
was matching the outer message, so Act 1 would have put **"ABORTED"** on screen instead of
`BOARD_AUTHORISATION_REQUIRED: RS-3 requires Board approval under BRPD 16/2022…`.

That is the entire point of the refusal catalogue, and it would have been discovered on stage. `extractRefusal`
now reads `details[]` first and explicitly excludes gRPC status names, so a transport failure can never be
mistaken for a policy decision.

### 2.4 Port 5432 was contested by a native PostgreSQL install

The listener died with `password authentication failed for user "verity"` — correct credentials, wrong
database. `netstat` showed **two** listeners on 5432: our container and a `postgresql-x64-18` Windows service.

The container now publishes **5433** on the host. In-network the services still use 5432, which is why the
compose file carries both numbers with a comment. If a teammate's machine has no native PostgreSQL this
changes nothing; if it does, it saves an hour of looking at the wrong password.

---

## 3. Running the services during development

The compose file builds containers, but for development run them natively — faster to restart, and the logs
are right there:

```bash
source network/scripts/wsl-env.sh

# Postgres (5433 on the host), API (:4000), listener, portal (:3000)
docker compose -f services/compose.yaml up -d --build
```

> **If you run the API or listener from a shell instead**, leave `VERITY_PEER_HOST`
> unset — it defaults to `localhost`, which is right for a host process. The
> compose file sets `VERITY_PEER_HOST=dns` because inside a container
> `localhost:9071` is the container itself, and Fabric reports that as
> `14 UNAVAILABLE ... ECONNREFUSED 127.0.0.1:9071`, which reads like a dead peer
> rather than a wrong address. See `services/*/src/{credentials,identities}.ts`.

Quick checks:

```bash
curl -s localhost:4000/health
curl -s localhost:4000/identities | jq '.users | length'          # 15
curl -s localhost:4000/loans/BD-API-8998 -H 'X-Verity-Identity: supervisor-1' | jq
docker exec verity-postgres psql -U verity -d verity -c 'select * from readmodel.loan'
```

---

## 4. Where I stopped

Working: network, all three chaincodes, 15 identities, private data collections, the API (writes, reads,
refusals, receipts), the listener and read model, the CBS mock with its read-only grant.

**Not yet exercised:**

- [ ] Modules II–IV end to end — the Paillier ceremony against `cc-exposure`, liability roots and claim
      tokens against `cc-claims`. The chaincode is deployed and unit-tested; nothing has driven it live.
- [ ] The remaining seven red-team scripts (`redteam/act3a.sh` is the pattern to copy)
- [ ] The orderer-kill demonstration — `./network/network.sh kill-orderer 3`, never yet run
- [ ] `rebuild()` triggered from an endpoint rather than a process restart
- [ ] Seeding the CBS mock and the ledger from `seed/out/seed.json`
- [ ] Benchmark: sustained TPS, p95 latency, ledger growth per million events
- [ ] **The three portals** — this is the last big piece, and Gate A is not passed until a browser click
      produces a transaction ID

### 4.1 Bringing it back up tomorrow

```bash
source network/scripts/wsl-env.sh
cd network && ./network.sh up && cd ..
docker compose -f network/compose/compose-ca.yaml up -d
cd network && ./scripts/enroll-users.sh && cd ..
for cc in commitment exposure claims; do ./scripts/deploy-cc.sh "$cc"; done
docker compose -f services/compose.yaml up -d postgres
```

`network.sh up` regenerates crypto material, so **`enroll-users.sh` must be re-run** — old certificates chain
to a root that no longer exists, and the failure looks like TLS rather than identity.

The commitment chaincode needs `CC_SEQUENCE=2` because of the collections config, or deploy will report the
sequence as already committed and skip. Deploys are idempotent now, so re-running is safe.
