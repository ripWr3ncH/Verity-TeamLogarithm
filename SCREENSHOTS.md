# Verity — screenshot guide for slides 15, 16 and 17

10 screenshots, all taken from the running prototype. Nothing here is a mockup,
a Figma frame or a staged error. Every refusal in these images is one the
chaincode actually produced, and every transaction ID and block number is real.

| Shot | Slide | What it shows |
|---|---|---|
| 1 | 15 | Bank officer — refused, 0 signatures |
| 2 | 15 | Bank officer — refused, 2 signatures |
| 3 | 15 | Bank officer — committed, receipt |
| 4 | 15 | Supervisor — CL-1 reconciliation + read-only adapter |
| 5 | 15 | Supervisor — BD-4471, return vs ledger |
| 6 | 15 | Supervisor — Board confirmations |
| 7 | 16 / 17 | Depositor — sign |
| 8 | 16 / 17 | Depositor — verify |
| 9 | 16 / 17 | Depositor — claim |
| 10 | 16 / 17 | Depositor — same screen in Bangla |

---

## Slide 15 — Bank officer

Use shots **1, 2, 3** in that order, left to right. They are one continuous
sequence on one loan.

**Shot 1 — refused, 0 signatures.**
An officer tries to reschedule alone. Red panel:
`BOARD_AUTHORISATION_REQUIRED — supplied 0 of 3 director signatures`.

**Shot 2 — refused, 2 signatures.**
Two directors have signed. The counter reads `2 of 3`. **Still refused.**

> This is the most important of the three. It proves the system counts real
> signatures rather than checking a box. One signature short is still short.

**Shot 3 — committed.**
The third director signs and it goes through. Green receipt with transaction
ID, **block 411**, and:

```
ENDORSED BY   originating bank peer + BangladeshBankMSP peer
```

**Suggested caption for the three:** *Refused. Still refused. Then committed.*

**The one line to point at** is `ENDORSED BY`. It shows the transaction cannot
commit without Bangladesh Bank's peer. The regulator is a precondition, not
someone who reviews it afterwards.

---

## Slide 15 — Supervisor

**Shot 4 — the reconciliation.**
`804 filed · 843 on the ledger · 39 absent from the return`.

The right-hand panel shows PostgreSQL refusing our write:
`permission denied for table loan_master`. That is the **database** blocking
us, not our own code choosing to behave. It answers "how do we know Verity
cannot alter bank records?"

> **Crop this one to the top 2 rows** (BD-AE0003 and BD-4471). The rows below
> are artefacts from our own security testing and read as clutter on a slide.

**Shot 5 — BD-4471, the two columns.**

| Left — what the CL-1 recorded | Right — what the ledger recorded |
|---|---|
| STANDARD | RS-1, 12 days before quarter-end, E 0.698 |
| STANDARD | RS-2, 11 days, E 2.136 |
| STANDARD | RS-3, 15 days, E 4.048 |
| STANDARD | RS-4, 23 days, E 6.055 |

> **This is the single best image in the deck.** Same loan, two records.
> Nothing in the left column is false — it is simply incomplete.

**Shot 6 — Board confirmations.**
All six directors CONFIRMED by Bangladesh Bank. Answers the obvious follow-up
to shots 1–3: *who decides who the directors are?* The bank proposes; it
cannot seat them.

---

## Slides 16 and 17 — Depositor

Phone-sized, use shots **7, 8, 9** in sequence, then **10** for the language.

| Shot | Screen |
|---|---|
| 7 | Sign — balance Tk 1,146,240.15, signed on the device |
| 8 | Verify — "Included in the commitment", 8 steps among 250 depositors |
| 9 | Claim — face value, ordinary depositor, payout within 17 working days |
| 10 | The same screen in Bangla |

### Use the wording from the screenshots, not the slide draft

The slide draft says *"Confirm balance / Verify inclusion / View claim."* The
app actually says:

1. *Review and sign the balance your bank reported*
2. *Verify it is inside the bank's published commitment*
3. *Your claim*

Both slides ask for "exact interface microcopy", so let's use what is really
on screen.

### Two lines in shot 8 worth keeping visible

```
RECOMPUTED IN THIS BROWSER        ✓
CHECKED AGAINST THE COMMITTED ROOT ✓
```

That pair is the whole argument: the depositor does not have to trust the bank
**or** us. The proof is recomputed on their own device and checked against the
ledger.

### Shot 9 already carries the boundary line

> *"This claim cannot be sold or transferred. No legal authority for a
> secondary market in resolution claims exists, and Verity does not assert
> one."*

Slide 17 asks for exactly this. It is already in the image — no caption needed.

---

## Numbers for slide 15's `[MEASURED VALUE]` boxes

```
Confirmation latency:   443 ms (5 orderers) · 423 ms with one stopped
Sustained throughput:   20.4 tx/s, 0 failures
Test volume and setup:  1,219 transactions, concurrency 16, 59.8 s,
                        full stack end to end
```

Add underneath: *Single laptop, 21 containers on 12 cores. A floor, not a
projection.*

Measured, not quoted from a published benchmark. Full method in
[bench/RESULTS.md](bench/RESULTS.md).

---

## Three things not to do

1. **Do not blur anything.** All data is synthetic and the yellow banner at the
   top of every page says so. Blurring fake data makes judges wonder whether it
   is real.
2. **No QR code yet.** The backup demo video is not recorded. A QR that goes
   nowhere is worse than no QR.
3. **Do not restage any refusal.** Every red panel here is one the chaincode
   produced. If a frame needs redoing, redo it against the running system.

---

## One correction to the slide text

Shots 1–3 say **RS-4**, not RS-3.

Both a third and a fourth rescheduling require Board approval, so the argument
is identical — but if the slide text says "third rescheduling", change it to
**"a third or fourth rescheduling"** so it matches what is on screen. The app's
own wording does exactly that.

---

## If you need to retake any of these

The prototype has to be running. From the repo root:

```bash
source network/scripts/wsl-env.sh
./scripts/up.sh
```

Then open <http://localhost:3000>. Step-by-step click paths for every shot are
in [DEMO.md](DEMO.md). Take the depositor shots with the browser at **390 × 844**
(Chrome: F12, then Ctrl+Shift+M, pick iPhone 14 Pro); everything else at desktop
width and 125% zoom.
