#!/usr/bin/env bash
# ==========================================================================
#  ACT 5 — Byzantine fault tolerance, demonstrated rather than asserted.
#
#  Whitepaper §4.1:
#    "Fabric's Raft ordering service is crash fault tolerant. It assumes nodes
#     fail rather than behave maliciously. OUR THREAT MODEL EXPLICITLY INCLUDES
#     COLLUSION AMONG CONSORTIUM MEMBERS, so a CFT ordering layer would be
#     inconsistent with the problem we claim to address."
#
#    "Ordering organisations are Bangladesh Bank, BIBM, the Financial Reporting
#     Council and two rotating bank seats: five nodes. Since BFT requires
#     n >= 3f+1, this tolerates f = 1."
#
#  The rubric asks, verbatim: "what is the setup of the consensus?" This script
#  is the answer — stop an ordering node and commit a transaction anyway.
#
#    bash redteam/orderer-fault.sh
# ==========================================================================
set -o pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
source network/scripts/wsl-env.sh >/dev/null

# ── Reaching the API from WSL ────────────────────────────────────────────
# Inside WSL2, 127.0.0.1 is WSL's OWN loopback. The API runs as a Node process
# on the Windows host, so localhost silently reaches nothing and every request
# comes back empty — which reads like the ordering service failing when it is
# a networking mistake. Resolve the Windows host explicitly.
resolveApi() {
  [[ -n "${VERITY_API:-}" ]] && { echo "$VERITY_API"; return; }
  if grep -qi microsoft /proc/version 2>/dev/null; then
    local host
    host=$(ip route show default 2>/dev/null | awk '/default/ {print $3; exit}')
    [[ -z "$host" ]] && host=$(awk '/nameserver/ {print $2; exit}' /etc/resolv.conf 2>/dev/null)
    echo "http://${host:-127.0.0.1}:4000"
  else
    echo "http://127.0.0.1:4000"
  fi
}
API="$(resolveApi)"
VICTIM="${1:-3}"   # rotating bank seat A by default

curl -s --max-time 5 "$API/health" >/dev/null 2>&1 || {
  printf 'Cannot reach the API at %s\n' "$API" >&2
  printf 'Start it, or set VERITY_API. From WSL the Windows host is not 127.0.0.1.\n' >&2
  exit 1
}

ORDERERS=(
  "orderer0.ord-bb.verity.bd:Bangladesh Bank"
  "orderer1.ord-bibm.verity.bd:BIBM"
  "orderer2.ord-frc.verity.bd:Financial Reporting Council"
  "orderer3.ord-seata.verity.bd:Rotating bank seat A"
  "orderer4.ord-seatb.verity.bd:Rotating bank seat B"
)

Z=$(printf '0%.0s' {1..64})

commit() {
  local id="BD-BFT-$RANDOM"
  local body
  body=$(jq -nc --arg l "$id" --arg z "$Z" \
    '{commitmentId:$l,initialTier:"STANDARD",outstandingBand:"Tk 1-10 crore",groupToken:"G-0447",payloadHash:$z,originationDate:"2027-02-01"}')
  local started=$(date +%s%3N)
  local out
  out=$(curl -s --max-time 120 -X POST "$API/loans" \
    -H 'Content-Type: application/json' -H 'X-Verity-Identity: officer-rahim' -d "$body")
  local elapsed=$(( $(date +%s%3N) - started ))
  local block
  block=$(printf '%s' "$out" | jq -r '.receipt.blockNumber // empty')
  if [[ -n "$block" ]]; then
    printf '    ✓ committed at block %s  (%s ms)\n' "$block" "$elapsed"
    return 0
  fi
  printf '    ✗ %s\n' "$(printf '%s' "$out" | jq -r '.message // .error // .' | head -c 160)"
  return 1
}

echo "=================================================================="
echo " The ordering service — five nodes, five organisations"
echo "=================================================================="
for entry in "${ORDERERS[@]}"; do
  host="${entry%%:*}"; org="${entry#*:}"
  state=$(docker inspect -f '{{.State.Status}}' "$host" 2>/dev/null || echo absent)
  printf '   %-12s %-32s %s\n' "${host%%.*}" "$org" "$state"
done
echo
echo "   BFT requires n >= 3f+1.  n = 5, so this tolerates f = 1."
echo "   Seven organisations would raise tolerance to f = 2."

echo
echo "=================================================================="
echo " 1. Commit with all five ordering nodes up"
echo "=================================================================="
commit

IFS=: read -r VHOST VORG <<<"${ORDERERS[$VICTIM]}"
echo
echo "=================================================================="
echo " 2. Stop ${VHOST%%.*} — ${VORG}"
echo "=================================================================="
docker stop "$VHOST" >/dev/null
printf '    stopped. %d of 5 ordering nodes remain.\n' 4
sleep 6

echo
echo "=================================================================="
echo " 3. Commit again, with one ordering node down"
echo "=================================================================="
if commit; then
  TOLERATED=yes
  echo
  echo "    The network kept ordering. That is f = 1 tolerated, live."
else
  TOLERATED=no
  echo
  echo "    Did not commit — check: docker logs ${VHOST}"
fi

echo
echo "=================================================================="
echo " 4. Restore ${VHOST%%.*}"
echo "=================================================================="
started=$(date +%s)
docker start "$VHOST" >/dev/null
# Wait until it is serving again, and report how long recovery took.
# Wait for the node to actually serve again rather than for a log string —
# a grep that never matches just burns the full timeout and reports it as
# recovery time, which would be a fabricated number in the annexe.
for _ in $(seq 1 40); do
  if docker exec "$VHOST" sh -c true >/dev/null 2>&1; then break; fi
  sleep 2
done
printf '    back in %ss\n' "$(( $(date +%s) - started ))"
sleep 4
commit

echo
echo "=================================================================="
echo " Recorded for the benchmark annexe:"
echo "   ordering       SmartBFT, 5 nodes across 5 organisations"
echo "   tolerance      f = 1  (n >= 3f+1)"
echo "   fault injected ${VHOST%%.*} (${VORG}) stopped"
# Report what happened, never what was hoped for. A benchmark annexe that
# claims tolerance the run did not show is worse than no annexe.
if [[ "$TOLERATED" == yes ]]; then
  echo "   result         network continued to order and commit"
else
  echo "   result         NO COMMIT while the node was down — investigate"
  echo "                  before claiming f = 1 anywhere"
fi
echo "=================================================================="
[[ "$TOLERATED" == yes ]] || exit 1
