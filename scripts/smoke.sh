#!/usr/bin/env bash
# ==========================================================================
#  VERITY — end-to-end smoke test.
#
#    ./scripts/smoke.sh
#
#  ── WHAT THIS IS FOR ─────────────────────────────────────────────────────
#
#  Run it before handing the repository to someone else, before a rehearsal,
#  and at the venue before the judges arrive.
#
#  It checks the things a demo actually depends on, in the order the demo
#  needs them, and it FAILS LOUDLY. A check that cannot be performed is
#  reported as a failure rather than skipped quietly — a green run that
#  skipped half its checks is worse than no run at all, and this project has
#  already shipped one command that exited 0 having done nothing.
#
#  It does not replace `npm run test:all` (unit tests) or `redteam/run.mjs`
#  (adversarial). It runs both, and adds the wiring between them: containers,
#  channels, HTTP surface, the read model, and a real write to the ledger.
# ==========================================================================
set -uo pipefail   # NOT -e: a failing check must be recorded, not fatal.

cd "$(dirname "${BASH_SOURCE[0]}")/.."
API="${VERITY_API:-http://localhost:4000}"
WEB="${VERITY_WEB:-http://localhost:3000}"
SUP="X-Verity-Identity: supervisor-1"

C_RESET=$'\033[0m'; C_GREEN=$'\033[32m'; C_RED=$'\033[31m'
C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'; C_BLUE=$'\033[34m'

PASS=0; FAIL=0; FAILED_NAMES=()

section() { printf "\n%s── %s %s\n" "$C_BLUE" "$*" "$C_RESET"; }
ok()   { PASS=$((PASS+1)); printf "  %sPASS%s  %s\n" "$C_GREEN" "$C_RESET" "$1"; }
bad()  { FAIL=$((FAIL+1)); FAILED_NAMES+=("$1"); printf "  %sFAIL%s  %s\n" "$C_RED" "$C_RESET" "$1"
         [[ -n "${2:-}" ]] && printf "        %s%s%s\n" "$C_DIM" "$2" "$C_RESET"; }

# check <name> <expected> <actual>
check() { [[ "$2" == "$3" ]] && ok "$1" || bad "$1" "expected '$2', got '$3'"; }

# contains <name> <needle> <haystack>
contains() { [[ "$3" == *"$2"* ]] && ok "$1" || bad "$1" "did not contain '$2'"; }

# --------------------------------------------------------------------------
section "1. Containers"

for c in orderer0.ord-bb.verity.bd orderer1.ord-bibm.verity.bd orderer2.ord-frc.verity.bd \
         orderer3.ord-seata.verity.bd orderer4.ord-seatb.verity.bd \
         peer0.banka.verity.bd peer0.bankb.verity.bd peer0.bb.verity.bd peer0.frc.verity.bd \
         ca-banka ca-bankb ca-bb ca-frc \
         cc-commitment cc-exposure cc-claims \
         verity-postgres verity-api verity-listener verity-web; do
  state="$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo missing)"
  [[ "$state" == "running" ]] && ok "$c" || bad "$c" "state=$state"
done

# The listener restart-loops if it cannot reach a peer, which looks "up".
restarts="$(docker inspect -f '{{.RestartCount}}' verity-listener 2>/dev/null || echo '?')"
[[ "$restarts" == "0" ]] && ok "listener has not restarted" \
  || bad "listener has not restarted" "RestartCount=$restarts — check: docker logs verity-listener"

# --------------------------------------------------------------------------
section "2. Ledger"

heights="$(./network/network.sh status 2>/dev/null | grep -E 'commitment|exposure|claims' || true)"
for ch in commitment exposure claims; do
  h="$(printf '%s\n' "$heights" | grep -oP "${ch}\s+height \K[0-9]+" | head -1)"
  if [[ -n "$h" && "$h" -gt 0 ]]; then ok "channel '${ch}' at height ${h}"
  else bad "channel '${ch}' reachable" "no height reported"; fi
done

# --------------------------------------------------------------------------
section "3. HTTP surface"

code() { curl -s -o /dev/null -w '%{http_code}' -m 30 "$@"; }

check "API /health"              200 "$(code "$API/health")"
check "GET /queue"               200 "$(code -H "$SUP" "$API/queue?limit=5")"
check "GET /base-rate"           200 "$(code -H "$SUP" "$API/base-rate")"
check "GET /portfolios"          200 "$(code -H "$SUP" "$API/portfolios")"
check "GET /parameters"          200 "$(code -H "$SUP" "$API/parameters")"
check "GET /cbs/adapter"         200 "$(code -H "$SUP" "$API/cbs/adapter")"
check "GET /reconciliation"      200 "$(code -H "$SUP" "$API/reconciliation/2029-03-31")"
check "GET /loans/BD-4471"       200 "$(code -H "$SUP" "$API/loans/BD-4471")"
check "GET /board/BankAMSP"      200 "$(code -H "$SUP" "$API/board/BankAMSP")"
check "GET /depositor/session"   200 "$(code "$API/depositor/session")"
check "GET /admin/replay-status" 200 "$(code -H "$SUP" "$API/admin/replay-status")"
check "GET /access-log"          200 "$(code -H "$SUP" "$API/access-log")"

# An unauthenticated request must be REFUSED, not defaulted to a service account.
check "missing identity is rejected" 400 "$(code "$API/queue?limit=1")"

for r in / /bank /supervisor /depositor; do
  check "portal ${r}" 200 "$(code "$WEB$r")"
done
check "favicon served" 200 "$(code "$WEB/icon.svg")"

# --------------------------------------------------------------------------
section "4. Data the demo depends on"

q="$(curl -s -m 30 -H "$SUP" "$API/queue?limit=1")"
total="$(printf '%s' "$q" | grep -oP '"total":\K[0-9]+' | head -1)"
if [[ -n "$total" && "$total" -gt 500 ]]; then ok "read model carries ${total} exposures"
else bad "read model populated" "total=${total:-none} — run scripts/seed-ledger.mjs"; fi

loan="$(curl -s -m 30 -H "$SUP" "$API/loans/BD-4471")"
contains "BD-4471 reads live from the ledger" '"commitmentId":"BD-4471"' "$loan"
contains "BD-4471 is at RS-4"                 '"rsSequence":4'           "$loan"

adapter="$(curl -s -m 30 -H "$SUP" "$API/cbs/adapter")"
contains "adapter can read the core system"   '"canRead":true'   "$adapter"
contains "adapter CANNOT write (DB grant)"    '"canWrite":false' "$adapter"

# Count SEATED directors, not every CONFIRMED record ever written.
#
# Revocation is forward-only, so a retired director keeps status CONFIRMED on
# the ledger forever. Grepping the raw JSON counted 44 records and reported
# "33 confirmed directors" for a board of three -- a green check carrying a
# number that was plainly wrong, which is worse than a red one.
board="$(curl -s -m 30 -H "$SUP" "$API/board/BankAMSP")"
seated="$(printf '%s' "$board" | python3 -c '
import json,sys
try:
    b = json.load(sys.stdin)
except Exception:
    print(-1); raise SystemExit
print(len([d for d in b if not d.get("revokedAt") and d.get("status") == "CONFIRMED"]))
' 2>/dev/null || echo -1)"
if [[ "$seated" == "3" ]]; then ok "BankA has exactly 3 seated directors"
elif [[ "$seated" == "-1" ]]; then bad "BankA board is seated" "could not parse /board/BankAMSP"
else bad "BankA board is seated" "${seated} seated, expected 3 — run scripts/register-directors.mjs"; fi

dep="$(curl -s -m 30 "$API/depositor/session")"
contains "depositor fixture has a proof" '"path"' "$dep"

recon="$(curl -s -m 30 -H "$SUP" "$API/reconciliation/2029-03-31")"
contains "reconciliation finds omissions" 'ON_LEDGER_NOT_IN_CL1' "$recon"

# --------------------------------------------------------------------------
section "5. A real write, end to end"

# Two halves, and both matter.
#
# A write must COMMIT, or nothing else in the demo is real. And an
# unauthorised write must be REFUSED, because that is the entire claim. A
# smoke test that only proved the happy path would pass on a system that had
# stopped enforcing anything at all.
subject="BD-SMOKE-$RANDOM"
created="$(curl -s -m 60 -X POST -H 'Content-Type: application/json' \
  -H 'X-Verity-Identity: officer-rahim' "$API/loans" -d "{
    \"commitmentId\":\"$subject\",\"initialTier\":\"STANDARD\",
    \"outstandingBand\":\"Tk 1-10 crore\",\"groupToken\":\"G-0447\",
    \"payloadHash\":\"$(printf '0%.0s' {1..64})\",\"originationDate\":\"2027-01-15\"}")"
contains "originate a new exposure" '"blockNumber"' "$created"

# Now the refusal.
#
# The event below carries placeholder officer signatures that do not bind to
# this event hash, so PARA_11C fires before the seniority check ever runs.
# That is the correct order -- para 11(c) asks whether the two signatures are
# real before asking whose they are -- and it is what this probe asserts.
#
# It deliberately does NOT claim to test AUTHORITY_INSUFFICIENT. Red team #2
# does that properly, with signatures built over the actual event hash. An
# earlier version of this check asserted the wrong code, passed on
# STATE_DIVERGENCE, and would have gone on passing while the control it named
# was broken.
sleep 4
# Read prevStateHash back from the committed loan, exactly as the portal does.
# Deriving it from the originate response used a field name that does not
# exist, so the probe sent an empty hash and was refused with
# STATE_DIVERGENCE -- a refusal, but of the wrong control. A test that passes
# for the wrong reason is not a passing test.
prev="$(curl -s -m 30 -H "$SUP" "$API/loans/$subject"   | grep -oP '"prevStateHash":"\K[0-9a-f]{64}' | head -1)"
if [[ -z "$prev" ]]; then
  bad "an unauthorised event is refused" "could not read prevStateHash for $subject"
  prev="deadbeef"
fi
refused="$(curl -s -m 60 -X POST -H 'Content-Type: application/json'   -H 'X-Verity-Identity: officer-farhana' "$API/events" -d "{
    \"commitmentId\":\"$subject\",\"eventType\":\"RESCHEDULE\",
    \"tierAfter\":\"STANDARD\",\"eventDate\":\"2027-06-18\",
    \"prevStateHash\":\"$prev\",
    \"payloadHash\":\"$(printf '0%.0s' {1..64})\",
    \"signatures\":{\"assigning\":{\"officerId\":\"officer-rahim\",\"signature\":\"x\"},
                    \"reviewing\":{\"officerId\":\"officer-farhana\",\"signature\":\"x\"}},
    \"authorityEvidence\":{\"kind\":\"ONE_LEVEL_ABOVE\"},\"note\":\"\"}")"
code_name="$(printf '%s' "$refused" | grep -oP '"code":"\K[A-Z_0-9]+' | head -1)"
if [[ "$code_name" == PARA_11C* || "$code_name" == PARA_* ]]; then
  ok "unbound officer signatures refused (${code_name})"
elif [[ "$refused" == *'"refused":true'* ]]; then
  bad "unbound officer signatures refused"       "refused with ${code_name}, expected PARA_11C -- the refusal ORDER changed, check domain/authority.ts"
else
  bad "unbound officer signatures refused" "chaincode did NOT refuse: ${refused:0:160}"
fi

# --------------------------------------------------------------------------
section "6. Unit tests"

if npm run test:all >/tmp/verity-smoke-tests.log 2>&1; then
  t="$(grep -oP '^# tests \K[0-9]+' /tmp/verity-smoke-tests.log | paste -sd+ | bc)"
  f="$(grep -oP '^# fail \K[0-9]+' /tmp/verity-smoke-tests.log | paste -sd+ | bc)"
  [[ "$f" == "0" ]] && ok "${t} unit tests, 0 failures" || bad "unit tests" "${f} failed"
else
  bad "npm run test:all" "exited non-zero — see /tmp/verity-smoke-tests.log"
fi

# --------------------------------------------------------------------------
section "7. Red team"

if node redteam/run.mjs >/tmp/verity-smoke-redteam.log 2>&1; then
  line="$(grep -oP '\d+/\d+ attacks refused' /tmp/verity-smoke-redteam.log | head -1)"
  if [[ "$line" =~ ^([0-9]+)/([0-9]+) ]] && [[ "${BASH_REMATCH[1]}" == "${BASH_REMATCH[2]}" ]]; then
    ok "$line"
  else
    bad "red team" "${line:-no result line} — see /tmp/verity-smoke-redteam.log"
  fi
else
  bad "redteam/run.mjs" "exited non-zero — see /tmp/verity-smoke-redteam.log"
fi

# --------------------------------------------------------------------------
printf "\n%s%d passed, %d failed%s\n" "$C_BOLD" "$PASS" "$FAIL" "$C_RESET"
if [[ "$FAIL" -gt 0 ]]; then
  printf "%sFailed:%s\n" "$C_RED" "$C_RESET"
  for n in "${FAILED_NAMES[@]}"; do printf "  - %s\n" "$n"; done
  printf "\n%sDo NOT hand this to anyone until these are green.%s\n" "$C_RED" "$C_RESET"
  exit 1
fi
printf "%sEverything the demo depends on is working.%s\n" "$C_GREEN" "$C_RESET"
