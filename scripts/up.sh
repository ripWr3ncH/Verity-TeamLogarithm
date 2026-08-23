#!/usr/bin/env bash
# ==========================================================================
#  VERITY — bring everything up, in order.
#
#      ./scripts/up.sh
#
#  Six phases, and the thing to understand is which of them REPEAT. A Fabric
#  network that has been torn down comes back EMPTY — no channels, no
#  contracts, no data — which is why this script exists rather than a list of
#  commands in a README.
#
#      1. network containers      every session
#      2. three channels          every fresh network
#      3. CA containers           every session
#      4. enrol identities        every fresh network
#      5. three chaincodes        every fresh network, or when a contract changes
#      6. services + seed         every session
#
#  If you have only changed a contract, do NOT run this. Run:
#      CC_SEQUENCE=2 ./scripts/deploy-cc.sh commitment
#  The network stays up and it takes two minutes instead of twenty.
# ==========================================================================
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$(pwd)"

C_RESET=$'\033[0m'; C_BLUE=$'\033[34m'; C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_DIM=$'\033[2m'
phase() { printf "\n%s==>%s %s\n" "$C_BLUE" "$C_RESET" "$*"; }
ok()    { printf "%s  ok%s %s\n" "$C_GREEN" "$C_RESET" "$*"; }
step()  { printf "%s     %s%s\n" "$C_DIM" "$*" "$C_RESET"; }
die()   { printf "%sfail%s %s\n" "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

START=$(date +%s)

command -v docker >/dev/null || die "docker not found"
docker info >/dev/null 2>&1 || die "the Docker daemon is not running — start Docker Desktop and wait for the whale icon to settle"
[[ -x network/bin/peer ]] || die "Fabric binaries missing — run: cd network && ./bootstrap.sh"

# ---------------------------------------------------------------------------
phase "1/6  Fabric network — 5 BFT orderers, 4 peers"
( cd network && ./network.sh up )

# network.sh up already creates the three channels (phase 2).
ok "network up, channels live"

# ---------------------------------------------------------------------------
phase "3/6  Certificate authorities"
docker compose -f network/compose/compose-ca.yaml up -d
step "waiting for the CAs to accept connections"
sleep 6
ok "four CAs running"

# ---------------------------------------------------------------------------
phase "4/6  Enrolling identities with role attributes"
( cd network && ./scripts/enroll-users.sh )

# ---------------------------------------------------------------------------
phase "5/6  Chaincode"
for cc in commitment exposure claims; do
  ./scripts/deploy-cc.sh "$cc"
done

# ---------------------------------------------------------------------------
phase "6/6  Services, portal and seed data"
# Postgres, the API, the block listener and the Next.js portal. All four are
# containers on purpose: a portal that only exists while somebody remembers to
# run `npm run dev` in a second terminal is a portal that will be missing when a
# judge walks up to the table.
docker compose -f services/compose.yaml up -d --build
step "waiting for Postgres"
for _ in $(seq 1 30); do
  docker exec verity-postgres pg_isready -U verity -d verity >/dev/null 2>&1 && break
  sleep 2
done
step "waiting for the API"
for _ in $(seq 1 30); do
  curl -fsS -m 2 http://localhost:4000/health >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS -m 3 http://localhost:4000/health >/dev/null 2>&1   || die "the API never answered on :4000 — check: docker logs verity-api --tail 40"
step "waiting for the portal"
for _ in $(seq 1 30); do
  curl -fsS -m 2 -o /dev/null http://localhost:3000/ >/dev/null 2>&1 && break
  sleep 2
done

step "generating the synthetic portfolio (deterministic)"
npm --prefix seed run generate --silent

ELAPSED=$(( $(date +%s) - START ))
printf "\n"
ok "Verity is up  (${ELAPSED}s)"
printf "\n"
step "portal      http://localhost:3000"
step "api         http://localhost:4000/health"
step "topology    ./network/network.sh status"
step "identities  curl -s localhost:4000/identities | jq"
printf "\n"
step "All data is synthetic. No real borrower, depositor or institution appears."
printf "\n"
