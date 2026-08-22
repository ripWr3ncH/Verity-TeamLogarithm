# Phase 2 — Modules II, III and IV

**Covers:** sprint day 10 work, pulled forward · **Status:** written, **110/110 tests passing**; not yet deployed
**Next gate:** Gate F — Acts 3b and 4 run in the browser (needs Phase 3 services first)

---

## 1. What state the repo is in

```bash
# from the repo root
cd packages/crypto      && npm test    # 43 passing
cd chaincode/commitment && npm test    # 38 passing
cd chaincode/exposure   && npm test    # 17 passing
cd chaincode/claims     && npm test    # 12 passing
```

**110 tests, 0 failing.**

| Item | State |
|---|---|
| `packages/crypto` — bigint, Paillier, Shamir, ceremony, Merkle sum | ✅ 43 tests |
| `chaincode/exposure` — `ExposureContract` (Module II) | ✅ 17 tests, deploy pending |
| `chaincode/claims` — `LiabilityContract` (III), `ClaimsContract` (IV) | ✅ 12 tests, deploy pending |
| Golden vectors pinning the duplicated crypto | ✅ both directions |
| Services, portals | ❌ Phase 3–4 |

---

## 2. What I did, and why

### 2.1 The on-chain / off-chain split follows determinism, not convenience

Chaincode runs on every endorsing peer independently and the results must agree byte for byte. So the split
is decided by one question: *is this operation deterministic and secret-free?*

| Operation | Where | Why |
|---|---|---|
| Paillier keygen, encrypt, decrypt | **off-chain** (`packages/crypto`) | needs randomness and secrets |
| **Aggregation** `∏ Enc(x) mod n²` | **on-chain** | pure modular multiplication — every peer recomputes it |
| **Decryption proof check** `c ≟ (1+mn)·rⁿ` | **on-chain** | public values only |
| Threshold comparison in the clear | **on-chain** | integer arithmetic |
| Merkle tree **building** | **off-chain** | needs every leaf |
| Merkle proof **verification** | **on-chain** and in the browser | needs only the proof |

Putting aggregation on-chain matters for the demo: the aggregate is not something one party asserts, it is
something every endorsing peer independently recomputes.

### 2.2 Verifiable decryption — a genuine addition beyond the whitepaper

The ceremony emits the Paillier randomness `r` alongside the total, so anyone with the public key can check

```
c  ≟  (1 + m·n) · rⁿ   (mod n²)
```

That check is deterministic, so **chaincode runs it**. Bangladesh Bank therefore cannot announce a group total
the committed aggregate does not carry.

This tightens §3.5's answer to the sharpest question a judge can ask — *"if the supervisor endorses everything,
isn't it the custodian?"* The paper answers with separation of powers; the prototype adds a cryptographic
limit on top. Worth saying in Act 3b.

### 2.3 The supervisor genuinely cannot decrypt alone

`packages/crypto/ceremony.ts` splits the Paillier λ as

```
λ  =  supervisorShare  +  R      (mod P)
```

with `R` itself (2, 3) Shamir-shared among independent holders. So:

- **all three independents colluding** → they rebuild `R`, learn nothing about λ → `CEREMONY_SUPERVISOR_ABSENT`
- **supervisor alone, or with one independent** → `CEREMONY_QUORUM_SHORT`

Both are tested (`THE §3.5 CLAIM — …`). This is §3.7.2's *"supervisor plus a quorum of independent
participants"*, made mechanical.

**Honest boundary:** this reconstructs λ in memory during the ceremony. Production would use Damgård–Jurik
threshold decryption where each holder emits a *partial* decryption and the key is never assembled. Say that
plainly if asked; what this build does prove is that no single party can produce the plaintext.

### 2.4 Only aggregates can be opened — structurally

`RecordCeremony` takes no "which ciphertext" parameter. It reads the committed **aggregate** for that
(period, groupToken) and checks the proof against that. **There is no code path that opens an individual
bank's submission**, so §3.7.2's *"never which bank holds how much"* is structural, not procedural.

`AggregateGroup` also enforces a **minimum contributor count of 2** — an aggregate over one bank *is* that
bank's position. §4.7 asks for this; it is a refusal, `MINIMUM_CONTRIBUTORS`.

### 2.5 The withdrawn v6 design is guarded by a test

§3.7.2 corrected an earlier design that performed the threshold check **on ciphertext**. Paillier cannot do
that. Two tests assert that no `compareEncrypted` / `thresholdOnCiphertext` export exists, in both
implementations.

**Do not add one.** A technical judge who has read §3.7.2 will check, and the whitepaper's own `[FIX]` notes
call the withdrawn design out by name.

### 2.6 Golden vectors pin the duplicated crypto

The Merkle construction and the Paillier helpers exist **twice** — once off-chain, once in chaincode — because
Fabric cannot resolve workspace symlinks inside the peer's build container (§2.4 of Phase 0).

Duplication is a liability unless something pins the copies together. Two golden vectors do that:

| Pin | Files |
|---|---|
| Merkle sum root, sum and a full inclusion proof | `packages/crypto/test/golden.test.ts` ↔ `chaincode/claims/test/merkle-verify.test.ts` |
| Paillier aggregate and a decryption proof | generated by `packages/crypto` ↔ `chaincode/exposure/test/paillier-verify.test.ts` |

If a domain-separation string or a hash construction changes on one side only, **one of the two suites goes
red**. Without them, the drift would surface as every depositor's inclusion proof silently failing on demo
day, with no obvious cause.

> ⚠ **Never regenerate a golden value to make a test pass.** Find out which side changed, and why.

### 2.7 `ClaimsContract` has no transfer function — deliberately

§7.4 #9: *"We assert no existing legal authority for secondary transfer of tokenised depositor claims."*

There is no transfer path, not even a disabled one. `TransferClaim` exists **only to refuse**, with the legal
position in the message, so a judge asking *"can these be traded?"* hears the answer from the system in the
same words as the paper.

The demo script says it too: **do not show a buy/sell button.**

### 2.8 Negative balances and unsigned leaves are refused at insertion

`buildVerifiedTree` admits a leaf only if the depositor's ed25519 signature verifies over
`(accountRef, balance, period)`. Both halves of the collusion attack in [24] are closed:

- an **unsigned** leaf cannot be inserted by the bank → `UNSIGNED_LEAF`
- a **negative** balance cannot shrink apparent liabilities → `NEGATIVE_BALANCE`
- a signature **replayed from another period** fails, because the period is inside the digest

`buildVerifiedTree` returns `tree: null` when every candidate is rejected. That is a real outcome — a bank
whose depositors all declined has no commitment to publish — and the caller needs the rejection list to know
why. An earlier version threw, which hid the reasons.

---

## 3. Two real bugs the tests caught

Recording these because both would have been extremely expensive to find later.

### 3.1 A hand-transcribed prime that was not prime

`FIELD_PRIME` was first written as a 2048-bit decimal literal typed out in full. At least one digit was wrong,
so the modulus was composite, and `reconstruct()` failed with `no modular inverse: values are not coprime`
whenever a Lagrange denominator happened to share a factor with it — **intermittently**, depending on which
share indices were used.

Fixed by using `(1n << 2203n) - 1n`, the Mersenne prime with exponent 2203: written as an expression, not
transcribed, and large enough for a 2048-bit Paillier λ. A test now asserts the modulus is actually prime.

**Never hand-type a modulus.**

### 3.2 `buildVerifiedTree` threw when everything was rejected

Passing a single replayed-signature leaf rejected all candidates, and `new MerkleSumTree([])` threw
`cannot commit an empty liability set` — hiding the rejection reasons the caller needed. Now returns
`tree: null` with the list intact.

---

## 4. Where I stopped — the exact next steps

```bash
cd network && ./network.sh up && cd ..

./scripts/deploy-cc.sh commitment      # Phase 1
./scripts/deploy-cc.sh exposure        # Module II
./scripts/deploy-cc.sh claims          # Modules III and IV
```

Then Phase 3: `services/api` (Fabric gateway), `services/listener` (block events → read model),
`services/cbs-mock` (the read-only legacy adapter), the EDI engine, and the seed generator.

### 4.1 Module II end to end, once services exist

1. Bangladesh Bank: `SetAggregationKey(period, publicKey)` — 1024-bit, generated by `packages/crypto`
2. Each bank: `SubmitEncryptedExposure(period, "G-0447", ciphertext, ownMsp)`
3. Anyone: `AggregateGroup(period, "G-0447", 2)` → aggregate committed on-ledger
4. Off-chain ceremony: `runCeremony(material, supervisorShare, twoShares, aggregate)` → total + randomness
5. Bangladesh Bank: `RecordCeremony(...)` → **chaincode checks the proof**, then compares in the clear

---

## 5. What will bite you

### 5.1 The two crypto implementations must stay byte-identical

If you change a domain-separation string (`verity:leaf:v1:…`, `verity:node:int:…`) in
`packages/crypto/src/merkle-sum.ts`, change `chaincode/claims/src/domain/merkle-verify.ts` **in the same
commit**. The golden vectors will tell you, but only if you run the tests.

### 5.2 Paillier key size

`generateKeys()` defaults to 1024 bits. Tests use 256 or 512 so the suite stays fast. **The demo must run
1024**, and you should say the number out loud — "1024-bit Paillier in this build" is an honest sentence that
takes two seconds. Real deployments use 3072+.

### 5.3 BigInt does not survive `JSON.stringify`

`JSON.stringify({ x: 1n })` throws. Every interface here passes big numbers as **decimal strings**. Keep it
that way across the API and the UI, and parse at the boundary.

### 5.4 `evaluateThreshold` takes θ pre-scaled by 10,000

Integer arithmetic only — a float entering a chaincode comparison is a determinism hazard. θ = 0.25 is passed
as `2500`. The governance chaincode stores θ as a number; **scale it at the call site**.

### 5.5 The comparison is strictly greater-than

Exposure exactly equal to θ·C_system does **not** alert. That is deliberate — a limit is breached when it is
exceeded — and it is tested. If the domain expert wants ≥, change it in one place and update the test.

### 5.6 Claim issuance is restricted to `BankAMSP`

`ISSUER_MSP` is hard-coded to the resolution entity, matching §6 Phase 1. If a second institution ever issues
claims, that constant becomes a governance parameter — do not just add another MSP string.
