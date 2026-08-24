# HANDOFF

One file per phase. **Read the highest-numbered one before you start working.**

Each file answers the same four questions, in this order:

1. **What state is the repo in** — what works right now, verified how
2. **What I did** — the decisions, and *why*, so you do not undo them by accident
3. **Where I stopped** — the exact next command to run
4. **What will bite you** — traps found the hard way, so you do not find them again

| Phase | File | Covers |
|---|---|---|
| 0 | [`PHASE_00_FOUNDATION.md`](PHASE_00_FOUNDATION.md) | Repo scaffolding, Fabric v3 BFT network, channels |
| 1 | `PHASE_01_LIFECYCLE.md` | Module I chaincode + governance chaincode |
| 2 | `PHASE_02_MODULES.md` | Exposure, liability, claims chaincode |
| 3 | `PHASE_03_SERVICES.md` | API gateway, listener, read model, mock CBS, EDI engine, seed |
| 4 | `PHASE_04_PORTALS.md` | Bank officer, supervisor, depositor portals |
| 5 | [`PHASE_05_SERVICES_LIVE.md`](PHASE_05_SERVICES_LIVE.md) | Benchmark, red-team suite, demo assets |
| 6 | [`PHASE_06_BOARD_INDEPENDENCE.md`](PHASE_06_BOARD_INDEPENDENCE.md) | Supervisory confirmation of directors; containerised services and portal |

## House rules

- **Update the phase file in the same commit as the work.** A handoff written three days later is fiction.
- **Never break Gate A** — a click in the UI producing a real transaction ID. Once it passes, it stays passing.
- **`README.md` → "What is built, and what is not" is updated every phase.** It is the first thing a judge
  reads, and the last thing anyone remembers to change.
- Commit under your own GitHub account with your real name. The commit history is authorship evidence.
