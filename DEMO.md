# Verity — demo runbook

**Written against the system as it actually is**, not as it was planned. Every command here has been run,
every number has been observed. Where something is not yet verified, it says so.

Supersedes `WinningProjects/10_Prototype_Plan/02_DEMO_SCRIPT.md`, which predates the chaincode-as-a-service
switch and refers to commands that no longer exist.

**Target: 7 minutes.** One driver holds the mouse for the whole demo; the others narrate their act. Handing
the laptop between speakers costs fifteen seconds and looks unrehearsed.

---

## 0. Before you start

Twenty minutes before, every time, including at the venue.

```bash
# 1. Bring everything up
source network/scripts/wsl-env.sh
cd network && ./network.sh up && cd ..
docker compose -f network/compose/compose-ca.yaml up -d
cd network && ./scripts/enroll-users.sh && cd ..
for cc in commitment exposure claims; do ./scripts/deploy-cc.sh "$cc"; done
CC_SEQUENCE=2 ./scripts/deploy-cc.sh commitment      # private data collections

# 2. Services — Postgres, API, listener and portal, all containers
docker compose -f services/compose.yaml up -d --build

# 3. Populate. Order matters.
node scripts/register-directors.mjs
npm --prefix seed run generate
node scripts/seed-ledger.mjs
node scripts/seed-cbs.mjs
node scripts/run-exposure-ceremony.mjs
node scripts/run-liability-commitment.mjs
```

> `network.sh up` regenerates all crypto material, so **`enroll-users.sh` must be re-run after it** — old
> certificates chain to a root that no longer exists, and the failure looks like TLS rather than identity.

### Pre-flight checklist

- [ ] `curl -s localhost:4000/health` returns `{"status":"ok","synthetic":true}`
- [ ] `curl -s localhost:4000/queue?limit=1 -H 'X-Verity-Identity: supervisor-1'` shows a total near 830
- [ ] `docker ps --filter label=service=hyperledger-fabric -q | wc -l` → 17
- [ ] `node redteam/run.mjs` → 9/9
- [ ] Four browser tabs open: `/`, `/bank`, `/supervisor`, `/depositor`
- [ ] Zoom 125–150%, notifications off, mains power
- [ ] Backup video cued in a fifth tab, muted
- [ ] Second machine on standby

**If a container is unhealthy, play the recorded video and narrate it live.** A confident narrated recording
scores far better than four minutes of debugging in front of a jury.

---

## Act 0 — the return that is accurate and incomplete · 45 s

**Supervisor tab.** The reconciliation panel is the first thing on the page.

Press **Reconcile against the filed return**.

> "This is the CL-1 return Bangladesh Bank received for March 2029. Eight hundred and four exposures.
> Every single row in it is accurate — nothing here is false.
>
> But the ledger carries eight hundred and twenty-eight. Twenty-four exposures have committed events and do
> not appear in the return at all. Ranked by index, the first one is BD-4471.
>
> Nothing inside a quarterly return tells you what it leaves out. Only the comparison does."

Point at the adapter panel on the right:

> "And Verity cannot have written any of this. It reads the bank's core system as a role that holds SELECT
> and nothing else. That's a database grant refusing us, not our own code being polite."

---

## Act 1 — an approval level that exists only on paper · 100 s

**Bank tab.** This is the highest-scoring stretch of the demo. Rehearse it more than anything else.

1. Identity switcher shows **Nasrin Akhter — reviewing officer**. Point at the certificate chip:
   > "Role and seniority come off her X.509. This page does not send them; the chaincode reads them."

2. Open a fresh exposure. Type any unused id, e.g. `BD-DEMO-1`, and originate it as **Rahim Uddin**
   (sanctioning officer, seniority 2).

3. Switch to **Nasrin**. Submit two reschedulings — 2027-06-18 and 2027-12-20. Both commit.
   Point at the **prior-state hash** field:
   > "Read-only. It comes from committed history. She cannot type it."

4. Third reschedule. The panel changes to **BOARD REQUIRED** with three director chips.
   **Submit with none ticked.**

   > ⛔ `BOARD_AUTHORISATION_REQUIRED: RS-3 requires Board approval under BRPD 16/2022; supplied 0 of 3 director signatures`

   > "Bangladesh Bank already requires this. BRPD 16/2022, third rescheduling, Board approval. Today it's a
   > field the bank fills in itself. Here it's a condition the code checks."

5. **Tick two directors. Submit.**

   > ⛔ `supplied 2 of 3`

   > "Those are real ed25519 signatures, verified against the registered director set. It counted two
   > distinct valid signers and still refused. This is not a length check on an array."

6. **Tick the third. Submit.** Receipt appears.

   > "Committed. Transaction id, block height — and look at the endorsers: the bank's peer **and** Bangladesh
   > Bank's. Without the supervisor's endorsement this transaction does not commit at all. Regulatory
   > approval is a precondition, not a review afterwards."

---

## Act 1b — who decides who the directors are? · 60 s

**Only run this if Act 1 went well and you have time.** If a judge asks the question first, this is the
answer, and answering it from the screen is worth more than answering it from the podium.

7. Scroll down the Bank tab to **Your Board, as Bangladesh Bank sees it**. Three directors, all
   `CONFIRMED`.

   > "Three signatures cleared that. But who decides who the three directors are? If the bank does, I have
   > just watched it approve itself."

8. Switch to **Supervisor**, scroll to **Board confirmations**. Both banks' boards, each director's state,
   and who confirmed them.

   > "A bank registers a director. It cannot seat one. Until Bangladesh Bank confirms, that key's signature
   > does not count."

9. The proof, from the terminal:

   ```bash
   node redteam/run.mjs --only=9
   ```

   It registers three fresh directors as the bank's own MD/CEO, signs an RS-3 with all three, and is
   refused:

   > ⛔ `DIRECTOR_NOT_CONFIRMED: <key> (bank-appointed-0) was registered by BankAMSP on <date> but has
   > not been confirmed by Bangladesh Bank. A bank cannot constitute its own Board`

   > "Every signature there is cryptographically valid. Every key is in the bank's registered set. The
   > threshold is met exactly. The only thing missing is the supervisor."

   The script then confirms them and replays the **same three signatures**, which commit.

   > "And this is not a new rule either. A director's appointment already needs Bangladesh Bank's approval
   > under the Bank Company Act. We made an approval that exists on paper into a precondition the code
   > checks."

---

## Act 2 — what the return records, and what the ledger records · 100 s

**Supervisor tab.** Scroll to **The book**.

> "Eight hundred and twenty-eight exposures, ranked for attention. This is a queue, not an accusation."

Click **BD-4471**.

> "Opening this costs a block. A supervisory read is a submit transaction, because §4.7 says supervisory
> queries leave a permanent trace. Oversight is watched too."

The split screen:

> "Left column, what the CL-1 recorded: Unclassified. Unclassified. Unclassified. Unclassified.
>
> Right column, the same loan: four reschedulings, twelve days before quarter-end, eleven days, fifteen,
> twenty-three. The index climbs 0.698 to 6.055.
>
> Every quarterly return in that sequence reports this exposure as unclassified. The right-hand column is the
> same loan."

Now the honest half — point at the **base-rate histogram**:

> "The obvious objection is that this flags everyone at quarter-end. Thirty-five per cent of all reschedulings
> in this population fall within thirty days of a reference date. Ordinary forbearance clusters there too, for
> real operational reasons.
>
> Which is exactly why E-star is calibrated against this curve and not against zero. A control loan over the
> same period scores 0.534 — an eleven-fold separation the return does not carry."

Read the disclaimer aloud. Do not skip it:

> "A screening indicator that ranks exposures for supervisory attention. Not a finding of misconduct."

---

## Act 3 — privacy · 90 s

**a. Two identities, one query.** Terminal:

```bash
bash redteam/act3a.sh
```

> "Bangladesh Bank gets the borrower reference, the exact amount, the justification memo.
> A competing bank's officer runs the identical query and gets the hash — the same hash.
>
> That is not our application deciding to withhold. The payload was never disseminated to Meghna's peer.
> Fabric stops it at the gossip layer; the chaincode could not reveal it if it wanted to."

**b. Cross-bank exposure.** Terminal:

```bash
node scripts/run-exposure-ceremony.mjs
```

> "Two banks encrypt their exposure to the same borrower group. Five hundred and twenty crore, four hundred
> and thirty. Each is comfortably below the twenty-five per cent single-borrower limit — six hundred and
> twenty-five crore. Neither bank breaches anything.
>
> Chaincode multiplies the ciphertexts. Nothing is decrypted, and the aggregation runs on-ledger so every
> endorsing peer recomputes the same product.
>
> Watch the two refusals: the supervisor alone cannot open it. All three independent holders together, without
> the supervisor, cannot open it either.
>
> Supervisor plus two of three: nine hundred and fifty crore. Over the system limit, while sitting under every
> single-bank limit.
>
> And Paillier adds — it does not compare. So the total is decrypted to the supervisor and compared in the
> clear, and the chaincode verifies the announced total against the ciphertext it holds before believing it."

---

## Act 4 — the depositor · 45 s

**Depositor tab.** Mobile-shaped. Toggle to **বাংলা** and back.

1. **Sign the balance.** Key generated on the device, never sent.
2. **Verify inclusion.** Two ticks appear:
   > "Recomputed in this browser, and checked against the root committed on the ledger. Two independent
   > answers. The depositor is not asked to trust the bank, and not asked to trust us either."
3. **The claim.** Face value, priority class, schedule.
   > "This balance is above the two-lakh protection ceiling — which covers about ninety-three per cent of
   > accounts but a minority of deposit value. This is the money that Act leaves open.
   >
   > There is no sell button, and there never will be. We assert no legal authority for a secondary market in
   > resolution claims, and we say so in the paper."

---

## Act 5 — governance, and four attempts to cheat · 110 s

**Supervisor tab**, governance panel.

1. As **BankA**, propose E\* → 1.117, then **Activate**.
   > ⛔ `GOVERNANCE_QUORUM_REQUIRED: 'eStar' has 1 of 3 required approvals`
   > "A bank reaching for the parameter that governs its own alerts. Refused, by name, with the count."

2. Switch to **supervisor-1**, **Approve**. Activate again → **2 of 3**.

3. Switch to **frc-analyst**, **Approve**, then **Activate**. It commits.
   > "Recorded with the names of everyone who approved it. No participant can tune this system to its own
   > advantage — that sentence is in our paper, and that is it executing."

4. Terminal — **the whole red team**:
   ```bash
   node redteam/run.mjs
   ```
   > "Eight attacks. Eight refusals. Equal seniority approving, a signature from outside the director set, a
   > stale prior-state hash, a revoked certificate."

5. Terminal — **kill an orderer**:
   ```bash
   bash redteam/orderer-fault.sh
   ```
   > "Five ordering nodes across five organisations. Bangladesh Bank, BIBM, the Financial Reporting Council,
   > two rotating bank seats. BFT, so n ≥ 3f+1 — this tolerates one Byzantine node.
   >
   > Stop one. It commits anyway, four hundred and twenty-three milliseconds. Not Raft, because Raft assumes
   > nodes fail rather than lie, and our threat model includes collusion among the members themselves."

6. **Rebuild from block 0** — the strongest thirty seconds available:
   > "Everything on this dashboard is a projection. Watch."

   Press it, confirm. The queue empties.

   > "I have just deleted the entire database. Eight hundred and thirty exposures, gone.
   >
   > The listener is replaying every committed block. In about a minute they come back, with the same scores —
   > BD-4471 at 6.055 again. Nothing was lost, because nothing there was ever the record. The ledger is."

---

## Close · 20 s

> "Verity adds no rule. Bangladesh Bank already requires two signatures on every classification, already caps
> rescheduling at three occasions, already reserves the third to the Board.
>
> What was missing was a record the reporting institution could not quietly revise.
>
> Measured on this laptop: twenty point four transactions a second sustained, four hundred and twenty-three
> milliseconds with an ordering node down.
>
> It does not make bankers honest. It makes dishonesty something you have to do deliberately, in your own
> name, in a record you cannot afterwards edit."

---

## Judge Q&A — what to click

| Question | Answer | Click |
|---|---|---|
| *Is this really a blockchain?* | Real Fabric v3, BFT ordering | **Rebuild from block 0** — delete the database and replay |
| *Who are your orderers?* | BB, BIBM, FRC, two rotating bank seats. n ≥ 3f+1, f = 1 | `redteam/orderer-fault.sh` |
| *What's on-chain vs off?* | Hashes, signed events, authority evidence, roots. PII off-chain | Act 3a — payload vs hash |
| *Isn't Bangladesh Bank the custodian?* | Endorsement and ordering are separate powers; it cannot decrypt alone; its reads are logged | The ceremony refusals, then the access log |
| *Can a bank delete an event?* | No. Red team #5 and #6 | `node redteam/run.mjs --only=6` |
| *What if the CBS data is a lie?* | **It can be.** §7.4 #6. The defence is attribution and reconciliation, not prevention | Act 0's omission finding |
| *Won't the index flag everyone?* | It would if E\* were set against zero. It is set against the measured base rate | The histogram |
| *A bank could move its reschedulings.* | Yes, and the index weakens — but repetition still counts, the cap flags separately, and **the shift itself is on the ledger** | The queue's median-days column |
| *Who appoints the directors?* | The bank proposes, **Bangladesh Bank confirms**, and an unconfirmed key's signature does not count | Supervisor → **Board confirmations**, or `redteam/run.mjs --only=9` |
| *Key management?* | SoftHSM2 over PKCS#11 here; **FIPS 140-3 Level 3 is the production target, same interface** | Act 1's Board ceremony |
| *Does it scale?* | 20.4 tx/s sustained on this laptop, everything on one host | [bench/RESULTS.md](bench/RESULTS.md) |
| *What doesn't it do?* | Eleven things, §7.4. It recovers nothing, and it cannot prevent coordinated internal falsification | Hand them the dossier |

**The last row is the strongest answer you have.** Nearly every team overclaims under questioning. Volunteering
your own limits, precisely, from a numbered list, is what makes everything else you said credible.

---

## Known rough edges

Say these before a judge finds them.

- **The reconciliation shows 24 omissions, not 2.** Two are the deliberate ones. The other 22 are exposures
  created during development that were never in the filed return. Sorting by index puts the real ones first.
  For a clean run, reseed against a fresh network.
- **λ and E\* are illustrative.** The 95th percentile of this population is 2.331; E\* currently sits at 1.117.
  Both are Council-set and would be calibrated properly before deployment.
- **Officer signatures are a prototype binding**, not ed25519 — the signature embeds the event-hash prefix.
  **Director threshold signatures are real ed25519.** Do not blur the two.
- **The ceremony reconstructs the key in memory.** Production would use Damgård–Jurik partial decryption where
  the key is never assembled. What this build does prove is that no single party can open the aggregate.
