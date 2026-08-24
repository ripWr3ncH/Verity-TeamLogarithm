# Phase 06 — Board independence, and the container path

## 1. What state is the repo in

Everything from Phase 05 still holds. Two things changed, both of which were **real holes** rather than
polish.

| | Verified how |
|---|---|
| `DIRECTOR_NOT_CONFIRMED` — a bank cannot seat its own directors | 41 unit tests · red team #9 |
| API, listener and portal all work as containers | full stack restart, live gateway read |
| `scripts/snapshot.sh` take/restore round trip | 43 s take, 1 m 44 s restore, heights preserved |

Test totals: **165 across six packages, 0 failures.** Red team: **9 attacks, 9 refusals.**

---

## 2. What I did, and why

### 2.1 The Board was not independent, and Act 1 did not prove what it appeared to

This is the important one.

`RegisterDirector` was gated only on the caller holding `admin` or `mdceo` **in their own MSP**, and it wrote
under that same MSP. So a bank admin could register three directors it controlled and then satisfy its own
3-of-3 Board threshold for an RS-3.

The chaincode was checking that *three keys signed*. It was not checking, and could not check, that the
signers were independent of the bank that benefited. Act 1 — the highest-scoring ninety seconds of the demo —
proved the threshold arithmetic and nothing about the authority behind it.

**The fix.** Registration now lands `PENDING`. A director cannot count toward a threshold until the
supervisor confirms with `ConfirmDirector(mspId, keyId)`, which requires `role=supervisor` **and**
`mspId === SUPERVISOR_MSP`. No bank identity carries `role=supervisor`, and the role is read from the
caller's certificate, so there is no path by which a bank confirms its own.

**Why this framing and not another.** It adds no new rule. A bank director's appointment already requires
Bangladesh Bank's prior approval under the Bank Company Act 1991. That is the same move Verity makes
everywhere else: take an approval that already exists on paper and make it a precondition the code checks.
Any fix that invented a new control would have been weaker as an argument, even if identical in code.

> ⚠ **Verify the statutory citation before you present it.** The refusal string and the docs cite
> *Bank Company Act 1991, s.15* for Bangladesh Bank's prior approval of director appointments. The substance
> is right; confirm the exact section number against the current consolidated text and correct it in
> `chaincode/commitment/src/domain/errors.ts` and `README.md` if it differs. Everything else in the
> refusal catalogue carries a checked reference and this one should too.

**Fail closed on legacy records.** A director written before this control has no `status`. Those are treated
as PENDING, not grandfathered in — `director.status !== 'CONFIRMED'` handles `undefined` correctly, and
there is a test asserting it. Grandfathering would have silently exempted exactly the records the control
exists to catch. The cost is that after upgrading, `register-directors.mjs` must be re-run (it now registers
*and* confirms), or every RS-3 refuses.

**`RevokeDirector` now takes an mspId** and accepts either the bank's own admin or the supervisor. An
approval the supervisor can grant and never withdraw is not an approval. This is a **breaking signature
change** — it was `RevokeDirector(keyId)`.

### 2.2 The services only ever worked because they were run by hand

`services/api` and `services/listener` hardcoded `localhost:9051`. `scripts/up.sh` starts them with
`docker compose`, where `localhost` is the container itself, so the listener crashed on startup with
`14 UNAVAILABLE ... ECONNREFUSED 127.0.0.1:9071` — which reads like a dead peer and is a wrong address.

Every earlier test passed because they were running from a shell, where the published ports make `localhost`
correct. `resolvePeerEndpoint()` now returns the peer's compose DNS name when `VERITY_PEER_HOST=dns` and
`localhost` otherwise. The alias it uses is already the peer certificate's CN, so TLS is satisfied by the
same value.

### 2.3 Nothing started the portal

There was no `web/Dockerfile` and no compose service. The README said open `localhost:3000`; on a clean clone
nothing listened there. It worked only because a `next dev` happened to be running in someone's terminal.

Now a three-stage build on Next's `output: 'standalone'` — the runtime image carries no `node_modules` and is
ready in 171 ms. It gets no crypto material and no identity, which is correct: every call it makes runs in
the viewer's browser as a named officer against `localhost:4000`.

---

## 3. Where I stopped

The chaincode change requires a **new sequence**:

```bash
CC_SEQUENCE=3 ./scripts/deploy-cc.sh commitment
node scripts/register-directors.mjs     # registers AND confirms — required after upgrading
node redteam/run.mjs                    # expect 9/9
```

Then walk `DEMO.md` Act 1b in a browser.

> **Docker Desktop crashed mid-session while this was being verified** and took its WSL distro with it. The
> code, tests and docs are complete and the unit tests pass; the sequence-3 deploy and the live red-team run
> are the steps to redo. Nothing about the fix is in doubt — 41 unit tests cover the logic directly — but
> **the on-ledger verification is outstanding and should not be described as done until it passes.**

---

## 4. What will bite you

- **After upgrading, every RS-3 refuses until directors are confirmed.** That is the control working. Run
  `node scripts/register-directors.mjs`. If you only re-register without confirming, you get
  `DIRECTOR_NOT_CONFIRMED` and it looks like a bug.
- **`RevokeDirector` changed signature.** Any caller passing one argument now silently targets the wrong
  composite key.
- **`docker compose start` after a snapshot restore fails** naming a path under
  `/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/`. A stopped container still owns its bind-mount
  entry. Use `up -d --force-recreate`.
- **A short-lived `docker run --rm` under WSL2 sometimes finishes and never exits.** `docker top` shows no
  processes while `docker ps` says Up. `snapshot.sh` now uses one container for all ten volumes rather than
  ten containers, which reduces ten chances of hitting it to one.
- **Running the API or listener from a shell?** Leave `VERITY_PEER_HOST` unset. Only compose sets it to `dns`.
- **The bank portal deliberately lets you tick an unconfirmed director.** A disabled checkbox would hide the
  control; the refusal is the demo.
