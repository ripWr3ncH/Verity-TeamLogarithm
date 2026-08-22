# Phase 1 — Module I chaincode: lifecycle, governance, access log

**Covers:** sprint days 3–4 · **Status:** written and **unit-tested (38/38 passing)**; not yet deployed to a peer
**Next gate:** Gate B — reject-then-approve works from the CLI

---

## 1. What state the repo is in

```bash
cd chaincode/commitment && npm test      # 38 passing, ~250 ms
```

| Item | State |
|---|---|
| `src/domain/errors.ts` — the refusal catalogue | ✅ 18 refusal codes with regulation citations |
| `src/domain/types.ts` — data model | ✅ |
| `src/domain/hash.ts` — canonical JSON, event hash, state chaining, ed25519 | ✅ tested |
| `src/domain/authority.ts` — the policy table + k-of-n + statutory calendar | ✅ tested |
| `src/contracts/lifecycle.ts` — `LifecycleContract` | ✅ compiles, **not yet run on a peer** |
| `src/contracts/governance.ts` — `GovernanceContract` | ✅ compiles |
| `src/contracts/accesslog.ts` — `AccessLogContract` | ✅ compiles |
| `scripts/deploy-cc.sh` | ✅ written, **not yet run** |
| Exposure / liability / claims chaincode | ❌ Phase 2 |

**38 tests cover the part that decides the demo:** the statutory calendar reproduces the whitepaper's day
counts (12, 11, 15, 23 for Loan A; 69 and 53 for the control), the authority policy table, all four ways a
Board threshold can fail, para 11(c), and hash chaining.

---

## 2. What I did, and why

### 2.1 The refusal catalogue is a source file, not error handling

`src/domain/errors.ts` holds every message a judge can see, each naming the rule broken and its circular
reference. Three rules for anything added:

1. Name the rule that was broken, with the circular.
2. Say what was supplied against what was required.
3. No stack traces, no internal identifiers, no apology.

This makes §3.7.1 literally true — *"an approval level that exists only on paper becomes a condition the code
checks, instead of a box the bank fills in itself."* **Write the refusal before the happy path.**

### 2.2 The regulation is a decision table

`requiredAuthority()` in `authority.ts`:

| Event | Condition | Required |
|---|---|---|
| `RESCHEDULE` | RS-1, RS-2 | `ONE_LEVEL_ABOVE` |
| `RESCHEDULE` | RS-3, RS-4 | `BOARD_THRESHOLD` |
| `RESCHEDULE` | RS-5+ | **refused** — `RS_CAP_EXCEEDED` |
| `RECLASSIFY_UP` | out of Sub-Standard or worse | `BOARD_THRESHOLD` (para 6(d)) |
| `RECLASSIFY_UP` | within Standard/SMA | `ONE_LEVEL_ABOVE` |
| `WRITE_OFF` | — | `BOARD_THRESHOLD` |
| `CORRECTION` | — | `MDCEO` |
| `RESTRUCTURE`, `COLLATERAL_REVALUATION`, `ASSET_PLEDGE` | — | `ONE_LEVEL_ABOVE` |
| `RECLASSIFY_DOWN`, `RECOVERY`, `LC_DEVOLVEMENT` | — | `MECHANICAL` |

`MECHANICAL` means days past due drive it, so there is no discretionary approval to prove — §3.7.1's
"where judgment drives it" distinction, in code.

### 2.3 `src/domain/` is pure — no Fabric imports anywhere

That is deliberate and it is why 38 tests run in 250 ms with no network. **Keep it that way.** If you find
yourself wanting `ctx` inside `domain/`, pass the value in instead. The contracts in `src/contracts/` are
thin: read state, call domain, write state.

### 2.4 Roles and seniority come from the CERTIFICATE

`ledger.ts → caller()` reads `role`, `seniority` and `institution` via `ctx.clientIdentity.getAttributeValue()`.
These are X.509 attributes the org's Fabric CA issued. **A client cannot set them — that is the entire point.**

Seniority scale used throughout:

| Role | `seniority` |
|---|---|
| `sanctioning_officer` | 2 |
| `reviewing_officer` | 3 |
| `mdceo` | 5 |
| `director` | 5 |
| `supervisor` (Bangladesh Bank) | — |
| `frc`, `auditor` | — |

`ONE_LEVEL_ABOVE` is `callerSeniority > loan.sanctioningSeniority`, **strictly**. Equal seniority is refused —
that is red-team attack #2.

### 2.5 The sanctioning officer's seniority is frozen at origination

`OriginateLoan` records `sanctioningSeniority` on the loan. Every later `ONE_LEVEL_ABOVE` check compares
against it. A bank cannot retroactively lower the bar, because the loan record is append-only and any change
is itself an event.

### 2.6 `SuperviseLoan` is a SUBMIT transaction, on purpose

An *evaluate* transaction cannot write state, so it cannot leave a trace — and a trace nobody can verify is
not one. `SuperviseLoan` therefore submits, writes an `ACCESSLOG` entry, and returns the loan plus trail.

That is §4.7 — *"supervisory queries leave a permanent trace"* — and it answers the sharpest question a judge
can ask: if Bangladesh Bank endorses everything, has it not become the custodian? In the demo, the
supervisor's Act 2 read shows up on the loan's own trail in Act 5.

`GetLoan` and `GetEventTrail` stay as evaluate for the owning institution's own screens.

### 2.7 `UpdateEvent` exists solely to refuse

There is no update and no delete path. `UpdateEvent` is a real transaction that always throws `APPEND_ONLY`,
so red-team attack #5 produces a **legible refusal** rather than "method not found". A correction must be a new
`CORRECTION` event carrying a `note` and referencing the prior-state hash.

### 2.8 Governance parameters live on the ledger from block one

`InitParameters` writes the genesis calibration: `lambda=0.03`, `eStar=0.5`, `theta=0.25`,
`boardThresholdK=3`, `councilQuorum=3`, `disclosureLagDays=90`.

`LifecycleContract` reads `boardThresholdK` **from the governance contract**, not from a constant. So the
Act 5 demo — a bank trying to raise its own alert threshold and being refused — is not a special case, it is
the ordinary path. `readParameter()` falls back to the same genesis numbers if `InitParameters` has not run,
so the fallback can never silently disagree with the ledger.

`deploy-cc.sh` calls `InitParameters` automatically after committing the `commitment` chaincode.

### 2.9 Endorsement policies

Set at deploy time in `scripts/deploy-cc.sh`, not in the contract:

| Chaincode | Policy |
|---|---|
| `commitment` | `AND(OR('BankAMSP.peer','BankBMSP.peer'),'BangladeshBankMSP.peer')` |
| `exposure` | `AND(OR('BankAMSP.peer','BankBMSP.peer'),'BangladeshBankMSP.peer')` |
| `claims` | `AND('BankAMSP.peer','BangladeshBankMSP.peer')` |

**Bangladesh Bank's endorsement is a precondition of commitment**, not a review afterwards (§3.8 step 4).
Show a bank-only endorsement failing during the demo — it makes the point better than any slide.

---

## 3. Where I stopped — the exact next steps

```bash
# 1. Network must be up first (Phase 0)
cd network && ./network.sh up && cd ..

# 2. Deploy the commitment chaincode. Network stays up.
./scripts/deploy-cc.sh commitment

# 3. Gate B — the reject-then-approve flow, from the CLI.
#    See §3.1 below for the exact invocations.
```

### 3.1 Gate B by hand

Set the peer environment for BankA (see `deploy-cc.sh → setOrg`), then:

```bash
# a. Originate. Caller must hold role=sanctioning_officer, seniority=2.
peer chaincode invoke ... -c '{"Args":["LifecycleContract:OriginateLoan",
  "BD-4471","STANDARD","100-200cr","G-0447","<payloadHash>","2027-01-15"]}'

# b. Two reschedulings at RS-1 and RS-2 as reviewing_officer (seniority=3). Both commit.

# c. RS-3 with ONE_LEVEL_ABOVE evidence  ->  MUST BE REFUSED:
#    BOARD_AUTHORISATION_REQUIRED: RS-3 requires Board approval under BRPD 16/2022;
#    supplied 0 of 3 director signatures

# d. Register three directors, sign the event hash with each, resubmit  ->  commits.
```

**Gate B passes when (c) refuses with that message and (d) then commits.** That pair is Act 1 of the demo and
the highest-scoring ninety seconds in the prototype.

Helper scripts for registering directors and producing signatures land in Phase 3 (`services/api`). Until
then, `chaincode/commitment/test/domain.test.ts → newDirector()` shows exactly how to generate an ed25519
keypair and sign an event hash.

---

## 4. What will bite you

### 4.1 Contract names must be qualified in every invocation

Three contracts share one chaincode, so **every** call needs the contract prefix:

```
"Args":["LifecycleContract:AppendEvent", ...]     ✅
"Args":["AppendEvent", ...]                       ❌ resolves to the default contract
```

### 4.2 `main` points at `dist/src/index.js`

`tsconfig.json` has `rootDir: "."`, so compiled output is `dist/src/…` and `dist/test/…`, not `dist/…`.
`package.json → main` is set to match. **If you change `rootDir`, change `main` in the same commit** — Fabric
starts the chaincode from `main`, and a wrong path fails at container start with a confusing error.

### 4.3 Never use `Date.now()` in chaincode

Every endorsing peer executes independently and results must agree byte for byte. Use `txTimestamp(ctx)`,
which reads `ctx.stub.getTxTimestamp()`. Same for `Math.random()` and for iterating an object without sorting
— `canonicalJson()` exists for that reason.

### 4.4 The para 11(c) signature check is a prototype binding

`verifyPara11c` currently requires the officer's signature string to contain the first 8 hex characters of the
event hash. It is a real binding to *this* event, but it is not a real signature.

**Phase 3 replaces it with ed25519 under the officer's SoftHSM-held key** — same check, stronger primitive.
Until then, **do not claim officer signatures are cryptographic in the demo.** Director threshold signatures
*are* real ed25519 today; say that precisely and no more.

### 4.5 `getStateByPartialCompositeKey` needs the iterator closed

`listByPartialKey()` closes it in a `finally`. If you write another range query, do the same, or the peer
leaks iterators and eventually refuses new queries.

### 4.6 Deploying a changed chaincode needs a new sequence number

Second and later deployments of the same chaincode:

```bash
CC_SEQUENCE=2 ./scripts/deploy-cc.sh commitment
```

Forgetting this gives an opaque "sequence 1 already committed" error. It is the most common way five minutes
disappear.

---

## 5. Test coverage map — which tests guard which demo moment

| Test | Guards |
|---|---|
| statutory calendar (5 tests) | Act 2's headline numbers: 0.698 → 6.055 and the 0.534 control |
| authority policy table (7 tests) | Act 1's refusal, and every red-team attack |
| para 11(c) (5 tests) | Act 1's two-signature requirement |
| k-of-n Board threshold (7 tests) | Red team #1 and #3 |
| one level above (5 tests) | Red team #2 |
| hashing and chaining (7 tests) | Red team #5 and #6 (`APPEND_ONLY`, `STATE_DIVERGENCE`) |
| ed25519 (3 tests) | The claim that director signatures are real |

**If any of these go red, the demo has a hole in it.** Run `npm test` before every push.
