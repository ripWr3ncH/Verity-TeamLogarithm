# Phase 3 — Services, identities, read model, seed data

**Covers:** sprint days 5–8 · **Status:** written; **162/162 tests passing**, API and listener typecheck clean
**Next gate:** Gate A — a browser click producing a real transaction ID. **This is the phase where the network must actually run.**

---

## 1. What state the repo is in

```bash
cd packages/crypto && npm test    # 43
cd packages/edi    && npm test    # 32  (25 EDI + 7 listener parity)
cd seed            && npm test    # 20
cd chaincode/commitment && npm test  # 38
cd chaincode/exposure   && npm test  # 17
cd chaincode/claims     && npm test  # 12
```

**162 tests, 0 failing.** `services/api` and `services/listener` typecheck clean against the real
`@hyperledger/fabric-gateway` types — which is meaningful: it means the gateway API is used correctly, not
merely plausibly.

| Item | State |
|---|---|
| `packages/edi` — equations (1) and (2), base-rate histogram, E\* suggestion | ✅ 32 tests |
| `seed/` — deterministic synthetic portfolios | ✅ 20 tests |
| `services/cbs-mock/schema.sql` — mock CBS + **read-only grant** | ✅ written |
| `services/listener/readmodel.sql` — projections + `truncate_all()` | ✅ written |
| `services/api` — Fabric gateway, one identity per officer | ✅ typechecks, **not yet run** |
| `services/listener` — chaincode events → read model, `rebuild()` | ✅ typechecks, **not yet run** |
| `network/compose/compose-ca.yaml` + `enroll-users.sh` — 15 identities with attributes | ✅ written |
| `scripts/up.sh`, `scripts/down.sh` | ✅ written |
| Portals | ❌ Phase 4 |

---

## 2. What I did, and why

### 2.1 Fabric CA on top of cryptogen — because roles must be real

cryptogen cannot issue **attributes** or do **revocation**. Both are load-bearing:

- without `role` and `seniority` on the certificate, chaincode would have to trust a field the client sent,
  and Act 1's refusal becomes theatre;
- without CRL revocation there is no red-team #8.

Each CA in `compose-ca.yaml` **adopts the root cryptogen already generated**
(`FABRIC_CA_SERVER_CA_CERTFILE` / `_KEYFILE`), so CA-issued users chain to the same root as the peers and are
valid in the same MSP. That is what lets the two tools coexist without regenerating the network.

`enroll-users.sh` registers 15 identities with `role`, `seniority`, `institution` and `displayName` as
`:ecert` attributes — burned into the certificate, readable by `ClientIdentity.getAttributeValue()`.

### 2.2 One X.509 per person. No shared service account.

Stated at the top of `services/api/src/identities.ts` and worth repeating: if the API ever signs *as the bank*
rather than as a named officer, three things quietly stop being true — Act 1's refusal, Act 3a's two-identity
comparison, and red-team #8.

Every route requires an `X-Verity-Identity` header naming the acting officer. There is **no default and no
fallback**; omitting it is a 400. The seed script has its own registered identity (`adapter-banka`,
`role=adapter`, `seniority=1`) rather than borrowing an officer's.

The cast (`enroll-users.sh`) deliberately includes **two sanctioning officers at seniority 2** — `officer-rahim`
and `officer-kamal` — so red-team #2 (equal seniority approving) has a real identity to fail with.

### 2.3 Chaincode refusals are HTTP 422, not 500

`extractRefusal()` digs the contract's own message out of the gRPC wrapping, so the UI renders
`BOARD_AUTHORISATION_REQUIRED: RS-3 requires Board approval under BRPD 16/2022; supplied 0 of 3 director
signatures` rather than a stack trace.

A refusal is the system **working**. 422 says so; the red-team suite asserts on `code`.

### 2.4 The read model is derived, and provably so

`services/listener` consumes chaincode events as a **trigger**, then re-reads authoritative state from the
ledger. Projections never trust the event payload, and every statement is an upsert on a natural key, so
replay is idempotent.

`rebuild()` calls `readmodel.truncate_all()` and replays all three channels from block 0. **This is the
architecture answer.** When a judge asks whether it is really a blockchain, wipe the dashboard's database and
rebuild it from the chain while they watch.

EDI scores are **recomputed from committed events every time**, never incremented. Incrementing would let one
projection bug become a permanently wrong score on a supervisor's screen.

### 2.5 λ comes from the ledger, even inside the listener

`currentLambda()` reads `readmodel.parameter`, which is itself projected from `ParameterChanged` events. So
Act 5's governance change propagates into the scores through the same path as everything else — the parameter
is Council-set all the way down (§4.6).

### 2.6 The read-only grant is the legacy-integration answer

`services/cbs-mock/schema.sql` ends with:

```sql
GRANT SELECT ON ALL TABLES IN SCHEMA cbs TO verity_adapter;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ... FROM verity_adapter;
```

The rubric asks, verbatim: *"Is integration of the blockchain solution with legacy systems addressed? How is
data stored?"* Most teams answer with an arrow on a slide. **Run an `UPDATE` as `verity_adapter` during the
demo** — PostgreSQL refuses it, not our application code. §4.3's claim becomes checkable in ten seconds.

### 2.7 The seed generator earns §3.7.1's concession

The single most dangerous question in Act 2 is *"won't this flag every bank at quarter-end?"*

§3.7.1 concedes the point openly — rescheduling clusters near period-ends for legitimate operational reasons.
So the generator makes the **ordinary** population cluster too: about 25% of ordinary reschedulings fall
within 30 days of a reference date. Measured on the default seed:

| Days to reference date | Ordinary reschedulings | Share |
|---|---|---|
| 0–14 | 44 | 12.1% |
| 15–29 | 59 | 16.2% |
| 30–44 | 74 | 20.3% |
| 45–59 | 64 | 17.6% |
| 60–74 | 51 | 14.0% |
| 75+ | 72 | 19.8% |

The planted cases still separate, because they combine tight timing **with** repetition. Two tests guard both
sides: one fails if the base rate is too clean to be credible, another if it is so high the signal drowns.

**A finding worth using in the demo:** on this population, `suggestEStar()` at the 95th percentile returns
**1.117**, against the whitepaper's illustrative **0.50**. That is exactly §3.7.1's point — E\* must be set
against the measured base rate, not against zero — and now it is demonstrable rather than asserted. Consider
opening a governance proposal on stage to move E\* from 0.50 to the data-suggested value: it makes Act 2 and
Act 5 one continuous argument.

### 2.8 Determinism in the seed is a demo requirement

`seed/src/rng.ts` is a seeded mulberry32; `Math.random()` is banned in `seed/`. The same flags always produce
the same bytes, which is what makes `reset-to-seed` a reset rather than a re-roll — and what keeps the poster
screenshots matching the live system.

---

## 3. Where I stopped — the exact next steps

```bash
cd network && ./bootstrap.sh      # once per machine, 15-30 min
cd ..
./scripts/up.sh                   # everything, in order
```

Then check, in this order:

```bash
./network/network.sh status                    # 9 Fabric containers, 3 channels
curl -s localhost:4000/health                  # {"status":"ok","synthetic":true}
curl -s localhost:4000/identities | jq '.users | length'   # 15
```

**GATE A is the next milestone and it outranks everything else.** Once a click in the browser produces a real
transaction ID, tag it and never break it:

```bash
git tag gate-a-safety-net && git push --tags
```

Phase 4 is the three portals.

---

## 4. What will bite you

### 4.1 The CAs need the network up first

`compose-ca.yaml` mounts `network/organizations/.../ca`, which does not exist until `network.sh up` has run
cryptogen. `up.sh` sequences this correctly; running the compose file alone will not.

### 4.2 `enroll-users.sh` is not idempotent in the way you expect

`register` fails harmlessly if the identity already exists (suppressed), but `enroll` overwrites the user's
MSP directory. Re-running is safe. Running it against a **regenerated** network is also necessary — the old
certificates chain to a root that no longer exists, and the failure looks like a TLS error rather than an
identity error.

### 4.3 The gateway needs `grpc.ssl_target_name_override`

The peer's TLS certificate carries `peer0.banka.verity.bd`, not `localhost`. Without the override the
handshake fails with a name mismatch that reads like a certificate problem. It is set in `gateway.ts`; do not
remove it when you refactor.

### 4.4 Key filenames differ between cryptogen and Fabric CA

`priv_sk`, a long hash, `cert.pem` — it varies. `firstFileIn()` takes whatever is in the directory rather than
guessing, the same lesson as `normaliseSigncerts` in `network.sh`. Do not "tidy" it into a hard-coded name.

### 4.5 The listener runs as a real identity too

`VERITY_LISTENER_IDENTITY` defaults to `supervisor-2`. It only ever **evaluates**, so it writes nothing to the
ledger — but note that it deliberately uses `GetEventTrail` (evaluate, untraced), **not** `SuperviseLoan`
(submit, logged). If the listener used the logged path, the access log would fill with machine reads and Act
5's "the regulator's own read is on the trail" would be lost in noise.

### 4.6 Postgres init scripts run once, on an empty volume

`schema.sql` and `readmodel.sql` are applied by `docker-entrypoint-initdb.d` **only when the data directory is
empty**. Editing them and restarting does nothing. To reapply:

```bash
docker compose -f services/compose.yaml down --volumes
docker compose -f services/compose.yaml up -d
```

### 4.7 `services/listener/src/edi.ts` duplicates `packages/edi`

Deliberate — the listener ships as its own container from a compiled bundle. **`packages/edi` is
authoritative**, and it carries the tests that pin equation (1) to the whitepaper's published numbers. If you
change the equation, change it there first, then mirror it.

This is the third duplication pair, and it is **now pinned** like the other two.
`packages/edi/test/listener-parity.test.ts` imports the listener's copy directly and asserts the two agree on
the Table 2 fixture, the control, the statutory calendar, which event types count, the illustrative defaults,
and six different values of λ.

**That pin matters more than the other two.** The supervisor dashboard reads the *projection*, not
`packages/edi` — so a drift here would put scores on stage that disagree with the submitted whitepaper,
silently, with nothing erroring anywhere.

---

## 5. Test coverage map

| Suite | Tests | Guards |
|---|---|---|
| `packages/crypto` | 43 | Module II and III cryptography; the two §3.5 claims |
| `packages/edi` | 32 | **Act 2's published numbers**: 0.698 → 6.055, control 0.534, 11.3×; listener parity |
| `seed` | 20 | Determinism, the whitepaper fixtures, and an honest base rate |
| `chaincode/commitment` | 38 | The authority policy; red team #1, #2, #3, #5, #6 |
| `chaincode/exposure` | 17 | Paillier golden vector; the withdrawn v6 design stays withdrawn |
| `chaincode/claims` | 12 | Merkle golden vector; proof tampering |

Run all six before every push. If `packages/edi` goes red, **the demo contradicts the submitted whitepaper** —
that is the most expensive failure on the board.
