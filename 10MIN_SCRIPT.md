# Verity — 10-minute full walkthrough script

One driver holds the mouse and keyboard for the whole run; anyone else on the team narrates their own
segment over their shoulder. Handing the laptop between speakers costs fifteen seconds and looks
unrehearsed — don't.

This is the **long-form** script: every module, the architecture, the numbers, and the four attacks that
get refused on camera. For the 45-second poster cut and the 3-minute backup, see [VIDEO.md](VIDEO.md). For
the 7-minute live-pitch runbook this expands on, see [DEMO.md](DEMO.md) — this script follows the same
acts, paced and narrated for a fixed 10:00 recording rather than a live jury.

**Total runtime target: 10:00.** Each segment below lists a start time, an end time, and a word-count
budget assuming ~150 words/minute. Read the whole script aloud once, stopwatch running, before you record
anything — trim from the *longest* segment first, never from a refusal beat.

> **Numbers are illustrative.** 806 loans, ~828 exposures, 804 filed, 24 omitted are the figures this
> script and [DEMO.md](DEMO.md) are written against. Your own database will drift after every reseed —
> open the Supervisor reconciliation panel and the queue count **before you record** and swap in whatever
> your instance actually shows. Never say a number the screen doesn't back up.

**No cutaway to README or a slide deck.** The homepage (`/`) now carries every diagram README.md has —
see [`components/HowItWorks.tsx`](web/components/HowItWorks.tsx) — scroll down past the three portal cards:
**How it works** (architecture flow, Act 1 threshold, Act 1b confirmation, Module II ceremony) and then
**Architecture** (BFT topology, on-chain/off-chain, the read model as a cache). Every code and figure on
those diagrams is the real string the chaincode returns, verified against an actual run, not a paraphrase.
If a live take ever misfires mid-Act, the matching homepage diagram is a clean fallback beat to narrate over
instead of re-running the whole ceremony.

Diagram type is sized for the recording, not for a code review — labels and refusal codes read at 125%
browser zoom without a lean-in or a mid-scroll zoom, so treat them like any other on-screen beat: hold the
scroll, don't punch in.

---

## Before recording

- [ ] Full bring-up per [SETUP.md](SETUP.md), fully populated (all six `scripts/*.mjs` steps), `./scripts/smoke.sh` → **54 passed, 0 failed**
- [ ] `bash redteam/revoke.sh` has run against this network — otherwise red-team attack #8 reports `ACCEPTED` on camera instead of a refusal
- [ ] `./scripts/snapshot.sh` — so a bad take can be re-recorded from identical state
- [ ] Open `/` and confirm **How it works** renders below the three portal cards — if the web image predates this script, rebuild it: `docker compose -f services/compose.yaml up -d --build web`
- [ ] Five browser tabs open: `/`, `/bank`, `/supervisor`, `/depositor`, and a terminal
- [ ] Screen at 1920×1080, browser zoom 125–150%, notifications off, second monitor disconnected
- [ ] Record system audio **off** — narrate live or dub in a second pass, never over keyboard clatter
- [ ] Do not speed-ramp any transaction. If it took 423 ms, it's on screen for 423 ms.

---

## 0:00–0:15 · Cold open

| On screen | Narration |
|---|---|
| Title card: **Verity — Team Logarithm**, then cut straight to the Supervisor portal, synthetic-data banner visible | Bangladesh's non-performing loan ratio was measured at over thirty-two percent this year. An independent review of six banks found four times more bad debt than the banks had reported. Verity is a working prototype that makes that gap harder to hide. |

---

## 0:15–0:55 · The problem

| On screen | Narration |
|---|---|
| Stay on the portal home, scroll to the architecture summary or hold on the banner | Bangladesh Bank's rules aren't the problem. Every loan classification already needs two signatures. Rescheduling is already capped at three occasions, and the third already needs Board approval. Those rules exist on paper today. What's missing is the record — it's held by the institution being examined, it can be revised after the fact, and it's read only when an inspector is physically in the building. |

---

## 0:55–1:50 · Architecture, in one pass

| On screen | Narration |
|---|---|
| Stay on the homepage. Scroll down past the three portal cards to **How it works** — the architecture flow diagram | Verity commits those same signatures to a Hyperledger Fabric ledger — not a new rule, the existing one, enforced in code instead of self-reported. A bank's core banking system stays exactly where it is. A read-only adapter — read-only at the database grant, not by convention — feeds a bank officer's signed event into chaincode. Chaincode checks the signer's role and seniority off their certificate, and the transaction only commits if it's endorsed by both the bank's peer **and** Bangladesh Bank's. Every block feeds a read model the supervisor's dashboard queries — and that read model is disposable; the ledger is the only thing that matters, and we'll prove that in a minute. |
| *(optional — cut first if running long)* Point at the two dashed branches below the flow — the depositor's inclusion proof, the CL-1 return still filed unchanged | Two things never touch the ledger directly: the depositor's balance is checked against a root, not stored raw, and the bank's quarterly return keeps going out exactly as it always has. Nothing here replaces a filing — it catches what a filing leaves out. |
| Cut to terminal: `docker ps --format "{{.Names}}"` scrolled past, or `./network/network.sh status` | This is real infrastructure, not a mockup: five BFT ordering nodes across five organisations — Bangladesh Bank, BIBM, the Financial Reporting Council, and two rotating bank seats — four peers, three channels, three chaincode packages. Twenty-one containers, all running on one laptop. |

---

## 1:50–2:35 · Act 0 — a return that is accurate and incomplete

**Supervisor tab.** The reconciliation panel is the first thing on the page.

| On screen | Narration |
|---|---|
| Press **Reconcile against the filed return**. Stat tiles land: filed / on-ledger / absent | This is the CL-1 return Bangladesh Bank actually received this quarter. Eight hundred and four exposures — and every row in it is accurate. Nothing here is false. But the ledger carries more. Some exposures have committed events on-chain and appear nowhere in the filed return. Nothing inside a quarterly return tells you what it leaves out. Only the comparison does. |
| Point at the adapter panel | And Verity couldn't have written any of this itself even if it wanted to — the adapter holds SELECT and nothing else. That's a database grant refusing us, not our own code being polite. |

---

## 2:35–4:00 · Act 1 — an approval level that exists only on paper

**Bank tab.** Rehearse this stretch more than any other — it's the strongest few minutes in the demo.

| On screen | Narration |
|---|---|
| Identity switcher: **Nasrin Akhter — reviewing officer, seniority 3**. Point at the certificate chip | Role and seniority come off her X.509 certificate. This page doesn't send them to the chaincode — the chaincode reads them itself. |
| Originate a fresh exposure as **Rahim Uddin**, sanctioning officer, seniority 2. Switch to Nasrin | Two officers, two roles. Approval has to move one level up the chain — that's Bangladesh Bank's rule, not ours. |
| Submit two reschedulings. Both commit. Point at the read-only prior-state hash field | Two reschedulings commit clean. That prior-state hash — she can't type it. It comes from committed history. |
| Third reschedule. Panel switches to **BOARD REQUIRED**, three director chips, none ticked. **Submit.** Hold the refusal 3–4 seconds | Third rescheduling, same loan. BRPD 16/2022 already reserves this to the Board. *(hold, let them read `BOARD_AUTHORISATION_REQUIRED`)* |
| Tick two chips. Submit. **supplied 2 of 3** | Two real ed25519 signatures, checked against the registered director set, counted as two distinct signers — and still refused. That's not a length check on an array. |
| Tick the third. Submit. Receipt panel, cursor rests on **Endorsed by** | Three, and it commits. Look at the endorsers — the bank's peer and Bangladesh Bank's. Without the supervisor, this transaction does not exist. Regulatory approval is a precondition here, not a review that happens afterward. |

---

## 4:00–4:45 · Act 1b — who decides who the directors are?

| On screen | Narration |
|---|---|
| Scroll the Bank tab to **Your Board, as Bangladesh Bank sees it**. Three rows, `CONFIRMED` | Three signatures cleared that approval. But who decided those were the three directors? If the bank did, I've just watched it approve itself. |
| Switch to Supervisor, **Board confirmations** panel | A bank can register a director. It cannot seat one. Until Bangladesh Bank confirms, that key's signature doesn't count toward anything. |
| Terminal: `node redteam/run.mjs --only=9`. Hold on the refusal line | Watch this: register three directors as the bank's own chief executive, sign an RS-3 with all three. Every signature is valid, every key is in the bank's own registered set, the threshold is met exactly — and it's still refused, because Bangladesh Bank never confirmed them. |
| Next line: same three signatures, now confirmed, commit | Confirm them, replay the *same* three signatures — now they commit. A director's appointment already needs Bangladesh Bank's approval under the Bank Company Act. We just made it a precondition the code checks instead of a formality on file. |

---

## 4:45–6:00 · Act 2 — what the return records, what the ledger records

**Supervisor tab**, scroll to the queue.

| On screen | Narration |
|---|---|
| Queue visible, ranked. Click the top-ranked loan | Every exposure here is ranked for supervisory attention — this is a queue, not an accusation. Opening one costs a block; a supervisory read is itself a submit transaction, because oversight gets watched too. |
| Split screen — CL-1 column on the left, ledger column on the right | Left column: what the quarterly return recorded for this loan. Unclassified, unclassified, unclassified, unclassified. Right column, same loan: four reschedulings, each filed days before quarter-end. The index climbs from under one to over six. |
| Scroll to the base-rate histogram, amber bars visible | The obvious objection: doesn't this flag everyone at quarter-end? A third of all reschedulings in this population fall within thirty days of a reference date — ordinary forbearance clusters there too, for real reasons. Which is exactly why the threshold is calibrated against this measured curve, not against zero. A control loan over the same period scores nearly eleven times lower. |
| Read the on-screen disclaimer aloud | This is a screening indicator that ranks exposures for attention. It is not a finding of misconduct, and the page says so. |

---

## 6:00–7:25 · Act 3 — privacy: what stays off-chain, and what two banks never see of each other

| On screen | Narration |
|---|---|
| Terminal: run the private-data query script (or the equivalent redteam act3 helper) | Bangladesh Bank's query on this loan returns the borrower reference, the exact amount, the justification memo. A competing bank's officer runs the identical query — and gets the hash. The same hash. That's not our application choosing to withhold it. The payload was never gossiped to that peer in the first place. Fabric enforces it at the network layer; the chaincode couldn't leak it if it tried. |
| *(optional lead-in)* Before the terminal, a two-second cut to the homepage's **On-chain and off-chain** diagram | Three columns: what sits on the ledger in the open, what sits in a private data collection, what never leaves the bank at all — and the ledger only ever reaches the other two by hash. |
| Terminal: `node scripts/run-exposure-ceremony.mjs`, scrolling live | Now cross-bank exposure. Two banks encrypt what they're each owed by the same borrower group — five hundred twenty crore, four hundred thirty. Each is comfortably under its own single-borrower limit. Neither bank has done anything wrong on its own. |
| The two refusal lines highlight, then the ALERT line | The chaincode multiplies the ciphertexts together — nothing is decrypted, and every endorsing peer recomputes the identical product. Watch the refusals: the supervisor alone can't open it. All three independent key-holders together, *without* the supervisor, can't either. Only supervisor plus two of three. Opened: nine hundred fifty crore combined — over the system-wide limit, while sitting under every single bank's own limit. That's an exposure no single institution's own books would ever surface. |

---

## 7:25–8:05 · Act 4 — the depositor

**Depositor tab.** Mobile-shaped. Toggle বাংলা and back once.

| On screen | Narration |
|---|---|
| Sign the balance — key generated on-device | The depositor signs their own balance. The key is generated on their device and never leaves it. |
| Verify inclusion — two ticks appear | Verification runs twice: recomputed right here in the browser, and checked again against the root committed on the ledger. Two independent answers. The depositor isn't asked to trust the bank — and isn't asked to trust us either. |
| The claim panel — face value, priority class, schedule | This balance sits above the deposit protection ceiling — the portion the law leaves genuinely at risk. There's no sell button here, and there won't be one. We assert no legal authority for a secondary market in resolution claims, and we say so in the documentation, not just out loud. |

---

## 8:05–9:35 · Act 5 — nobody is above the ledger

**Supervisor tab**, governance panel.

| On screen | Narration |
|---|---|
| As **BankA**, propose a parameter change, then **Activate** immediately. Refusal: **1 of 3** | A bank reaching for the very parameter that governs its own alert threshold. Refused, by name, with the count — one of three approvals in. |
| Switch to **supervisor-1**, approve. Switch to **frc-analyst**, approve, then Activate. It commits | Bangladesh Bank approves, then the Financial Reporting Council. Now it moves — and it's recorded with the name of every organisation that signed off. No single participant can tune this system to its own advantage. |
| Terminal: `node redteam/run.mjs` — let the full ten-attack run scroll, land on the summary line | This is the full red-team suite against the live ledger, not a mock: equal-seniority approval, a signature from outside the registered director set, a stale prior-state hash, a revoked certificate signing a new event, a bank trying to seat its own Board. Ten attacks. Ten refusals. |
| *(optional — cut with the orderer-fault beat if tight)* Flash the homepage's **Why Fabric, and why BFT** diagram | Five orderers, three channels, four peer organisations — the topology the terminal is about to attack. |
| Terminal: `bash redteam/orderer-fault.sh` | Five ordering nodes across five organisations, Byzantine fault tolerant — this tolerates one node that doesn't just fail, but actively lies. Kill one. *(pause on the commit line)* It commits anyway, in under half a second. We didn't pick Raft, because Raft assumes nodes fail — our threat model assumes some of them might collude. |
| Press **Rebuild from block 0**, confirm. The queue empties, then refills | Everything on this dashboard is a projection — watch. I've just deleted the entire read model. *(on-screen caption: "replay in progress, footage cut")* The listener is replaying every block from genesis. It comes back with the same rankings, same scores. Nothing was lost, because the dashboard was never the record. The ledger is. That's the same diagram as the homepage's **read model is a cache** — this is it happening live. |

---

## 9:35–10:00 · Close

| On screen | Narration |
|---|---|
| Cut to the Verity wordmark, `github.com/ripWr3ncH/Verity-TeamLogarithm` | Verity adds no new rule. Bangladesh Bank already requires two signatures on every classification, already caps rescheduling at three, already reserves the third to the Board. What was missing was a record the reporting institution couldn't quietly revise. On this laptop: over twenty transactions a second sustained, under half a second with an ordering node down. It doesn't make anyone honest. It makes dishonesty something you have to do deliberately, in your own name, in a record you can't afterward edit. Verity — Team Logarithm. |

---

## Word-budget check

| Segment | Seconds | ~Words @150wpm |
|---|---:|---:|
| Cold open | 15 | 35 |
| The problem | 40 | 100 |
| Architecture | 55 | 135 |
| Act 0 | 45 | 110 |
| Act 1 | 85 | 210 |
| Act 1b | 45 | 110 |
| Act 2 | 75 | 185 |
| Act 3 | 85 | 210 |
| Act 4 | 40 | 100 |
| Act 5 | 90 | 220 |
| Close | 25 | 60 |
| **Total** | **600** | **~1,475** |

Read the script aloud once with a stopwatch before recording. If you land over 10:15, cut from **Act 5**
first (the orderer-fault beat can drop to a single sentence citing the number without the live kill), then
**Architecture** (the container count is expendable, the endorsement rule is not). Never cut a refusal
line — those are the moments judges remember.

## Honesty rules

Same rules as every other recording in this repo — see [VIDEO.md § Honesty rules for the edit](VIDEO.md#honesty-rules-for-the-edit).
No speed-ramping a transaction, label the one cut (block-0 replay), never stage a refusal, keep the
synthetic-data banner in frame, and never call officer signatures cryptographic — only director threshold
signatures are real ed25519.
