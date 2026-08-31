# Running Verity on your own machine

Written for someone who has never run this before. The [README](README.md) has the short version; this one
has the failures.

**Budget 30–45 minutes for the first run**, almost all of it downloading Fabric images. After that a full
bring-up takes about three minutes.

---

## 0. What you need

| | Version | Check |
|---|---|---|
| Docker Desktop | any current | `docker info` |
| Node | **20 or newer** | `node -v` |
| WSL2 | Windows only | `wsl -l -v` |
| Disk | **~12 GB free** | images ≈ 4 GB, volumes grow with the ledger |
| RAM | 8 GB minimum, 16 GB comfortable | 21 containers |

**On Windows everything runs inside WSL2, not PowerShell.** The Fabric binaries in `network/bin` are Linux
ELF executables. Open an Ubuntu shell and work there.

In Docker Desktop: **Settings → Resources → WSL Integration → enable your distro → Apply & Restart.** If this
is off, every `docker` command inside WSL fails with *"command not found"* even though Docker is clearly
running on Windows.

---

## 1. Clone and set up your shell

```bash
git clone https://github.com/ripWr3ncH/Verity-TeamLogarithm
cd Verity-TeamLogarithm

source network/scripts/wsl-env.sh
```

`wsl-env.sh` installs Node and `jq` into `~/.local` and puts `network/bin` on your `PATH`. **No sudo, nothing
system-wide.** You must `source` it (not execute it) so it can modify your current shell, and you need it
**once per terminal** — a new tab means sourcing it again.

Check it worked:

```bash
node -v        # v20 or newer
which peer     # .../network/bin/peer   (empty until step 2)
```

---

## 2. Download the Fabric binaries — once per machine

```bash
cd network && ./bootstrap.sh && cd ..
```

Pulls `peer`, `orderer`, `configtxgen`, the Fabric CA client and the Docker images. **This is the slow step.**
It is idempotent — safe to re-run if it fails partway.

---

## 3. Bring the stack up

```bash
./scripts/up.sh
```

Six phases: the BFT network and its three channels, four certificate authorities, sixteen enrolled
identities, three chaincode packages, then Postgres, the API, the block listener and the portal. On a clean
clone it runs `npm install` first.

It waits for the API and the portal before returning, so if it exits cleanly they are actually up.

---

## 4. Populate it — order matters

Each step depends on the one before. Run them one at a time and read the output.

```bash
node scripts/register-directors.mjs       # Board for both banks, registered AND confirmed
npm --prefix seed run generate            # deterministic synthetic portfolio
node scripts/seed-ledger.mjs              # 806 loans onto the ledger  (~60s)
node scripts/seed-cbs.mjs                 # the bank's estate + a CL-1 with omissions
node scripts/run-exposure-ceremony.mjs    # Module II end to end
node scripts/run-liability-commitment.mjs # Modules III and IV end to end
```

Open <http://localhost:3000>.

---

## 5. Check it actually works

```bash
curl -s localhost:4000/health              # {"status":"ok","synthetic":true}
./network/network.sh status                # three channels with block heights
npm run test:all                           # 170 tests, 0 failures
node redteam/run.mjs                       # 10 attacks, 10 refusals
```

Or run all of it at once:

```bash
./scripts/smoke.sh     # 54 checks: containers, channels, HTTP, data, a real write, tests, red team
```

That is the one to run before handing the repo to someone else, before a
rehearsal, and at the venue before the judges arrive. It exits non-zero and
names what broke.

`redteam/run.mjs` is the strongest single check — it drives the live ledger end to end. If it reports 10/10,
everything below it is working.

> Attack #8 needs `bash redteam/revoke.sh` to have run against this network first. Without it that attack
> reports `ACCEPTED` and tells you so, rather than quietly testing something weaker.

---

## Stopping and starting

```bash
./scripts/down.sh     # stop everything, keep the ledger
./scripts/up.sh       # bring it back, data intact
```

`down.sh` does **not** delete volumes, so your ledger and read model survive. To wipe and start over, remove
the named volumes as well — you will then need to re-run every step from 3 onward, including
`register-directors.mjs`.

---

# When it goes wrong

These are the failures we actually hit, with what they mean.

### `docker: command not found` inside WSL, but Docker runs on Windows

WSL integration is off. Docker Desktop → Settings → Resources → WSL Integration → enable your distro →
Apply & Restart. If it still fails, `wsl --shutdown` from PowerShell, then reopen your shell.

### Docker Desktop crashes on startup with `vpnkit-bridge handshake failed`

The error ends with `received bad magic string 'operation timed out because a response was not recei'`.
Your WSL is too old for your Docker Desktop — the new socket forwarder handshakes with a protocol old WSL
does not speak, and the timeout message lands where the handshake bytes should be.

```powershell
wsl --version     # anything below 2.6 with Docker Desktop 4.8x is suspect
wsl --update
```

If `wsl --update` returns **403**, the Microsoft update service is refusing, not your machine. Download the
MSI directly from <https://github.com/microsoft/WSL/releases> and install it. Use `curl -C -` if the download
stalls; a truncated MSI installs and does nothing useful.

### `Bind for 0.0.0.0:3000 failed: port is already allocated`

Something else holds the port. Check both sides — a container **and** a host process are both possible:

```bash
docker ps -a --format "{{.Names}}\t{{.Ports}}" | grep -E "3000|4000"
```

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen | ForEach-Object { Get-Process -Id $_.OwningProcess }
```

A stray `next dev`, or another project's compose stack, will do it.

### `error while creating mount source path '/run/desktop/mnt/host/wsl/...': file exists`

Docker Desktop's WSL2 bind-mount cache is stale. A **stopped** container still owns its mount entry, so
starting it after the source directory changed fails naming a path nobody typed.

```bash
docker compose -f network/compose/compose-net.yaml up -d --force-recreate
```

`--force-recreate`, not `start`. Named volumes are untouched, so the ledger survives.

### `GatewayError: 14 UNAVAILABLE ... ECONNREFUSED 127.0.0.1:9071`

Reads like a dead peer; it is a wrong address. Something is running **inside a container** with a
`localhost` endpoint. compose sets `VERITY_PEER_HOST=dns` for exactly this. If you are running the API or
listener from a shell instead, leave that variable **unset** — `localhost` is correct there.

### `DIRECTOR_NOT_CONFIRMED` on every Board-level event

The directors are registered but not confirmed by the supervisor. Re-run:

```bash
node scripts/register-directors.mjs
```

It registers **and** confirms. This is also what you need after upgrading the chaincode to a new sequence —
directors registered under an older sequence are not carried forward as confirmed, and failing closed is
deliberate.

### `DIRECTORS_NOT_REGISTERED: no director wallet at ...`

The wallet lives at `network/organizations/directors.json`, is gitignored, and is regenerated by
`register-directors.mjs`. If the path in the error is not under `/verity/...`, the API is resolving it from
the wrong place — check `VERITY_DIRECTOR_WALLET` and the `seed/out` mount in `services/compose.yaml`.

### `npm test --workspaces` errors

Use `npm run test:all`. The plain workspace command skips the three chaincode packages (deliberately not
workspaces, so they stay self-contained deploy units) and errors on the three workspaces that have no test
script.

### `access denied: creator org unknown, creator is malformed`

Crypto material and the channel disagree. `network.sh up` regenerates every certificate, so **identities
enrolled before it chain to a root that no longer exists**. Re-run `network/scripts/enroll-users.sh`, then
`register-directors.mjs`. The failure looks like TLS and is actually identity.

### The portal loads but every panel is empty

The API is up and the read model is not. Check the listener:

```bash
docker logs verity-listener --tail 20
```

It should report `following 'commitment' from block N` for all three channels. If it is crash-looping, that
line names the reason.

---

## Things worth knowing before you change anything

- **Chaincode changes need a new sequence.** `CC_SEQUENCE=N ./scripts/deploy-cc.sh commitment`, incrementing
  N. On a *fresh* network you never need this — sequence 1 already carries the collections config.
- **Line endings matter.** `.gitattributes` forces LF. If a `.sh` file gets CRLF, it fails with
  `bad interpreter: /bin/bash^M`.
- **Peers use LevelDB, not CouchDB.** Rich queries live in the PostgreSQL read model, which is a projection
  and can be rebuilt from block 0 — there is a button for it in the supervisor portal.
- **Everything is synthetic.** No real borrower, depositor or institution appears anywhere, and every page
  says so in a banner. Institution names are placeholders.
