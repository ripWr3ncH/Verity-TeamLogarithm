# Verity — video scripts

Two recordings, both insurance rather than a rules requirement. The prototype round's mandatory criteria are
a front-end and a back-end that writes to a blockchain; the 10-minute pitch video belonged to the proposal
round.

| | Length | Purpose |
|---|---|---|
| **A** | 45 s | Poster QR. A judge watches it standing up, phone in hand, in a noisy hall. |
| **B** | 3 min | Backup. Played if a container dies on stage, narrated live over the top. |

**Record B first.** It is the harder one, and doing it teaches you the timings for A.

---

## Before recording

- [ ] Full bring-up per [DEMO.md](DEMO.md) §0, seeded, `node redteam/run.mjs` → 9/9
- [ ] `./scripts/snapshot.sh` — so you can re-record from identical state
- [ ] Screen at **1920×1080**, browser zoom **125%**, everything else closed
- [ ] Notifications off, Do Not Disturb on, second monitor disconnected
- [ ] Cursor highlighting on if your recorder supports it; clicks should be visible
- [ ] Record **system audio off** — narrate separately or live, never over keyboard clatter
- [ ] OBS or ShareX, MP4, 30 fps, 1080p

**Do not speed up the video.** A judge who sees a transaction commit in real time believes it. A judge who
sees a jump cut wonders what was removed. The one place a cut is honest is the 90-second rebuild replay in
video B — and the script says so on screen.

---

# Video A — 45 seconds

Poster QR. One idea only: **the code refuses an approval that exists only on paper.** No architecture, no
modules, no scrolling.

| Time | On screen | Narration |
|---|---|---|
| 0:00–0:06 | Bank portal, loan open, RS-3 form filled, three director chips **unticked** | Bangladesh Bank already requires Board approval for a third rescheduling. |
| 0:06–0:11 | Click **Submit**. Refusal panel appears. Hold still. | Today that's a field the bank fills in itself. |
| 0:11–0:19 | Zoom the refusal text so it fills a third of frame | *(silent — let them read it)* |
| 0:19–0:26 | Tick two chips, submit. Second refusal: **supplied 2 of 3** | Two real signatures. Still refused. |
| 0:26–0:33 | Tick the third, submit | Three, and it commits. |
| 0:33–0:41 | Receipt panel. Cursor rests on **Endorsed by** | Block height, transaction id — and endorsed by the bank *and* Bangladesh Bank. Without the supervisor it does not commit at all. |
| 0:41–0:45 | Cut to the Verity wordmark, `github.com/ripWr3ncH/Verity-TeamLogarithm` | Verity. Team Logarithm. |

**≈ 95 words.** If you run long, cut the 0:19–0:26 two-signature beat — it is the best detail in the video, so
cut anything else first.

### Framing notes

- The refusal text is the subject of this video. It must be legible on a phone: zoom until
  `BOARD_AUTHORISATION_REQUIRED` is roughly the width of the frame.
- Do not narrate over the 8-second hold at 0:11. Silence makes people read.

---

# Video B — 3 minutes

The backup. Every beat is one you can also narrate live if you end up playing it muted.

### 0:00–0:20 · The return that is accurate and incomplete

| On screen | Narration |
|---|---|
| Supervisor portal. Press **Reconcile against the filed return**. Three stat tiles land: 804 filed, 828 on the ledger, 24 absent. | This is the quarterly return Bangladesh Bank received. Eight hundred and four exposures, and every row in it is accurate. Nothing here is false. But the ledger carries eight hundred and twenty-eight. Twenty-four have committed events and appear nowhere in the return. Nothing inside a return tells you what it leaves out. |

### 0:20–1:05 · An approval level that exists only on paper

| On screen | Narration |
|---|---|
| Bank portal. Cursor rests on the identity chip — `role=reviewing_officer · seniority=3`. | Role and seniority come off this officer's certificate. The page doesn't send them; the chaincode reads them. |
| Two reschedulings submitted, both commit. Cursor brushes the read-only prior-state hash. | Two reschedulings commit. She cannot type that prior-state hash — it comes from committed history. |
| Third reschedule. Panel switches to **BOARD REQUIRED**. Submit with none ticked. **Hold 4 s.** | The third goes to the Board. BRPD 16/2022. Submitted with her signature alone — |
| Refusal fills frame | — and it's refused, by name, citing the circular. |
| Tick two, submit. **supplied 2 of 3** | Two real ed25519 signatures, verified against the registered director set. Counted as two distinct signers, and still refused. This is not a length check on an array. |
| Tick the third, submit. Receipt. | Three, and it commits. Endorsed by the bank and by Bangladesh Bank. |

### 1:05–1:25 · Who decides who the directors are?

| On screen | Narration |
|---|---|
| Bank tab, scroll to **Your Board, as Bangladesh Bank sees it**. Three rows, all CONFIRMED. | Three signatures cleared that. But who decides who the three directors are? |
| Switch to Supervisor, **Board confirmations**. Both banks' boards, confirmers named. | A bank registers a director. It cannot seat one. |
| Terminal, `node redteam/run.mjs --only=9`. Hold on the refusal. | So: register three directors as the bank's own chief executive, and sign an RS-3 with all three. Every signature valid, every key in the bank's registered set, the threshold met exactly — and refused, because the supervisor never confirmed them. |
| The next line, where the same signatures commit after confirmation | Confirmed, and the same three signatures commit. A director's appointment already needs Bangladesh Bank's approval. We made it a precondition the code checks. |

### 1:25–2:05 · What the return records, and what the ledger records

| On screen | Narration |
|---|---|
| Supervisor. Queue visible, 828 rows. Click **BD-4471**. | Eight hundred and twenty-eight exposures ranked for attention. Opening one costs a block — a supervisory read is a submit transaction, because oversight is watched too. |
| Split screen. Cursor down the left column, then the right. | Left: what the CL-1 recorded. Unclassified, unclassified, unclassified, unclassified. Right: the same loan. Four reschedulings — twelve days before quarter-end, eleven, fifteen, twenty-three. The index climbs to 6.055. |
| Scroll to the base-rate histogram. Amber bars visible. | The obvious objection is that this flags everyone at quarter-end. Thirty-five per cent of all reschedulings here fall within thirty days of a reference date — ordinary forbearance clusters there too. Which is why the threshold is set against this curve and not against zero. A control loan scores 0.534. |

### 2:05–2:30 · Cross-bank exposure without disclosure

| On screen | Narration |
|---|---|
| Terminal, `run-exposure-ceremony.mjs`, scrolling live | Two banks encrypt their exposure to one borrower group. Five hundred and twenty crore, four hundred and thirty. Each below the twenty-five per cent single-borrower limit. Neither breaches anything. |
| The two refusal lines highlight | The chaincode multiplies the ciphertexts — nothing is decrypted. The supervisor alone cannot open the result. All three independent holders without the supervisor cannot either. |
| ALERT line | Together: nine hundred and fifty crore. Over the system limit, while sitting under every single-bank limit. |

### 2:30–2:50 · Governance, and a node going down

| On screen | Narration |
|---|---|
| Governance panel. BankA activates → refusal. | A bank reaching for the parameter that governs its own alerts. Refused at one of three. |
| Two more approvals, then activation with named approvers | Bangladesh Bank, then the FRC. It moves, recorded with the names of everyone who approved it. |
| Terminal, `orderer-fault.sh` | Five ordering nodes across five organisations. Stop one. It commits anyway — four hundred and twenty-three milliseconds. |

### 2:50–3:05 · Delete the database

| On screen | Narration |
|---|---|
| Supervisor. Press **Rebuild from block 0**, confirm. Queue empties. | Everything on this dashboard is a projection. I've just deleted it. |
| **On-screen caption: “90 seconds of replay, cut”** — then the queue full again, BD-4471 at 6.055 | The listener replays every committed block. They come back with the same scores. Nothing was lost, because nothing here was ever the record. |
| Wordmark | Verity adds no rule. It makes dishonesty something you have to do deliberately, in your own name, in a record you cannot afterwards edit. |

**≈ 520 words at 145 wpm, landing near 3:05.** Time your first read-through before recording. If you run
over 3:15, cut the histogram sentence in the 1:25 block — never a refusal beat. If you are badly over,
drop the 1:05 board section entirely and keep it in your pocket for Q&A: it answers a question judges ask
more often than they ask anything about the histogram.

---

## Recording order

1. **Silent screen capture of B**, start to finish, no talking. Redo until the clicks are clean.
2. **Narrate over it** in a second pass. Far easier than performing both at once, and you can re-record a
   single sentence without redoing the screen work.
3. **Cut A out of B's footage.** The Act 1 beats are already there.
4. Export both. Keep the source project — you will want to re-cut after the first rehearsal.

## Honesty rules for the edit

These are not stylistic. A judge who catches one of these stops believing the rest.

- **No speed-ramping a transaction.** If it took 400 ms, show 400 ms.
- **Label the one cut.** The 90-second replay is the only place footage is removed, and the caption says so.
- **Do not stage a refusal.** Every refusal in these scripts is one the chaincode actually produced; none is
  a mockup or a screenshot.
- **The synthetic-data banner stays in frame.** It is at the top of every portal page. Do not crop it out.
- **Do not call the officer signatures cryptographic.** Director threshold signatures are real ed25519;
  officer signatures are a prototype binding. The narration above is careful about this — keep it that way.
