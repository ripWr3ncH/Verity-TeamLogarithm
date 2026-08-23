#!/usr/bin/env bash
# ==========================================================================
#  RED TEAM #8 — certificate revocation by MSP CRL.
#
#  Whitepaper §4.4:
#    "Revocation is by MSP CRL, so A DEPARTED OFFICER CANNOT SIGN A LATER
#     EVENT WHILE THEIR EARLIER SIGNATURES REMAIN VALID."
#
#  Both halves of that sentence matter and this script demonstrates both:
#    · the officer's next submission is refused
#    · every event they already committed is still readable and still valid
#
#  ── WHY THIS IS MORE THAN `fabric-ca-client revoke` ──────────────────────
#
#  Revoking at the CA stops RE-ENROLMENT. It does not, by itself, stop an
#  already-issued certificate from being accepted by a peer — the peer
#  validates against the MSP in the CHANNEL CONFIG, and that MSP has no
#  revocation list until one is put there.
#
#  So the real work is a channel configuration update that writes the CRL into
#  BankA's MSP. Modifying an organisation's own MSP values needs that
#  organisation's admin signature and no one else's, which is itself worth
#  pointing at: Bangladesh Bank cannot revoke a bank's officer, and a bank
#  cannot revoke another bank's.
#
#    bash redteam/revoke.sh [officer-id]
# ==========================================================================
set -o pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
source network/scripts/wsl-env.sh >/dev/null

OFFICER="${1:-officer-kamal}"
ORG=banka
DOMAIN=banka.verity.bd
MSPID=BankAMSP
CHANNEL=commitment
CA_NAME=ca-banka
CA_PORT=10054

NET="$PWD/network"
export FABRIC_CFG_PATH="$NET/config"
export CORE_PEER_TLS_ENABLED=true
export CORE_PEER_LOCALMSPID="$MSPID"
export CORE_PEER_TLS_ROOTCERT_FILE="$NET/organizations/peerOrganizations/$DOMAIN/peers/peer0.$DOMAIN/tls/ca.crt"
export CORE_PEER_MSPCONFIGPATH="$NET/organizations/peerOrganizations/$DOMAIN/users/Admin@$DOMAIN/msp"
export CORE_PEER_ADDRESS=localhost:9051

ORDERER=localhost:7050
OCA="$NET/organizations/ordererOrganizations/ord-bb.verity.bd/orderers/orderer0.ord-bb.verity.bd/msp/tlscacerts/tlsca.ord-bb.verity.bd-cert.pem"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# The API is on the Windows host; from WSL that is not 127.0.0.1.
resolveApi() {
  [[ -n "${VERITY_API:-}" ]] && { echo "$VERITY_API"; return; }
  if grep -qi microsoft /proc/version 2>/dev/null; then
    local h
    h=$(ip route show default 2>/dev/null | awk '/default/ {print $3; exit}')
    echo "http://${h:-127.0.0.1}:4000"
  else
    echo "http://127.0.0.1:4000"
  fi
}
API="$(resolveApi)"
Z=$(printf '0%.0s' {1..64})

# --------------------------------------------------------------------------
# Try to originate a loan as the officer. Returns 0 if it commits.
attempt() {
  local id="BD-REV-$RANDOM"
  local out
  out=$(curl -s --max-time 90 -X POST "$API/loans" \
    -H 'Content-Type: application/json' -H "X-Verity-Identity: $OFFICER" \
    -d "$(jq -nc --arg l "$id" --arg z "$Z" '{commitmentId:$l,initialTier:"STANDARD",outstandingBand:"Tk 1-10 crore",groupToken:"G-0447",payloadHash:$z,originationDate:"2027-02-01"}')")
  local block
  block=$(printf '%s' "$out" | jq -r '.receipt.blockNumber // empty')
  if [[ -n "$block" ]]; then
    printf '    committed at block %s\n' "$block"
    printf '%s' "$id" > "$WORK/last-loan"
    return 0
  fi
  printf '    refused: %s\n' "$(printf '%s' "$out" | jq -r '.message // .error // .' | head -c 200)"
  return 1
}

echo "=================================================================="
echo " 1. ${OFFICER} commits an event — before revocation"
echo "=================================================================="
attempt || { echo "  cannot establish a baseline; is the API up?"; exit 1; }
BEFORE=$(cat "$WORK/last-loan")

echo
echo "=================================================================="
echo " 2. Revoke the certificate at ${CA_NAME}"
echo "=================================================================="
ADMIN_HOME="$NET/organizations/peerOrganizations/$DOMAIN/ca-admin"
FABRIC_CA_CLIENT_HOME="$ADMIN_HOME" fabric-ca-client revoke \
  -u "http://localhost:${CA_PORT}" --caname "$CA_NAME" \
  --revoke.name "$OFFICER" --revoke.reason "cessationofoperation" 2>&1 | tail -2 | sed 's/^/    /'

echo
echo "  generating the CRL"
FABRIC_CA_CLIENT_HOME="$ADMIN_HOME" fabric-ca-client gencrl \
  -u "http://localhost:${CA_PORT}" --caname "$CA_NAME" 2>&1 | tail -1 | sed 's/^/    /'

CRL_FILE="$ADMIN_HOME/msp/crls/crl.pem"
[[ -f "$CRL_FILE" ]] || { echo "    no CRL produced at $CRL_FILE"; exit 1; }
CRL_B64=$(base64 -w0 < "$CRL_FILE")
printf '    CRL %s bytes\n' "$(wc -c < "$CRL_FILE")"

echo
echo "=================================================================="
echo " 3. Write the CRL into ${MSPID}'s MSP, by channel config update"
echo "=================================================================="
echo "    only ${MSPID}'s own admin can do this — a supervisor cannot revoke"
echo "    a bank's officer, and no bank can revoke another's"
echo

peer channel fetch config "$WORK/config_block.pb" \
  -o "$ORDERER" --ordererTLSHostnameOverride orderer0.ord-bb.verity.bd \
  -c "$CHANNEL" --tls --cafile "$OCA" >/dev/null 2>&1 \
  || { echo "    could not fetch the channel config"; exit 1; }

configtxlator proto_decode --input "$WORK/config_block.pb" --type common.Block \
  --output "$WORK/block.json" 2>/dev/null
jq '.data.data[0].payload.data.config' "$WORK/block.json" > "$WORK/config.json"

jq --arg crl "$CRL_B64" --arg msp "$MSPID" \
  '.channel_group.groups.Application.groups[$msp].values.MSP.value.config.revocation_list = [$crl]' \
  "$WORK/config.json" > "$WORK/modified.json"

configtxlator proto_encode --input "$WORK/config.json"   --type common.Config --output "$WORK/config.pb" 2>/dev/null
configtxlator proto_encode --input "$WORK/modified.json" --type common.Config --output "$WORK/modified.pb" 2>/dev/null
configtxlator compute_update --channel_id "$CHANNEL" \
  --original "$WORK/config.pb" --updated "$WORK/modified.pb" --output "$WORK/update.pb" 2>/dev/null \
  || { echo "    no config delta — is the CRL already applied?"; exit 1; }

configtxlator proto_decode --input "$WORK/update.pb" --type common.ConfigUpdate \
  --output "$WORK/update.json" 2>/dev/null
jq -n --slurpfile u "$WORK/update.json" --arg ch "$CHANNEL" \
  '{payload:{header:{channel_header:{channel_id:$ch,type:2}},data:{config_update:$u[0]}}}' \
  > "$WORK/envelope.json"
configtxlator proto_encode --input "$WORK/envelope.json" --type common.Envelope \
  --output "$WORK/envelope.pb" 2>/dev/null

peer channel update -f "$WORK/envelope.pb" -c "$CHANNEL" \
  -o "$ORDERER" --ordererTLSHostnameOverride orderer0.ord-bb.verity.bd \
  --tls --cafile "$OCA" 2>&1 | grep -aiE "Successfully submitted|Error" | head -2 | sed 's/^/    /'

echo "    waiting for peers to apply the new config"
sleep 12

echo
echo "=================================================================="
echo " 4. ${OFFICER} tries again — EXPECT a refusal"
echo "=================================================================="
if attempt; then
  echo
  echo "    ⚠ STILL ACCEPTED. The CRL did not take effect — do not present"
  echo "      this as the revocation demo until it does."
  REVOKED=no
else
  echo
  echo "    The departed officer can no longer write."
  REVOKED=yes
fi

echo
echo "=================================================================="
echo " 5. Their EARLIER event is still valid and still readable"
echo "=================================================================="
STILL=$(curl -s --max-time 30 "$API/loans/$BEFORE" -H 'X-Verity-Identity: supervisor-1' \
  | jq -r 'if .commitmentId then "  \(.commitmentId) — committed by an officer since revoked, still on the ledger" else "  could not read \($ENV.BEFORE)" end' 2>/dev/null)
echo "  $STILL"

echo
echo "=================================================================="
if [[ "$REVOKED" == yes ]]; then
  echo " §4.4 demonstrated: a departed officer cannot sign a later event,"
  echo " while their earlier signatures remain valid."
else
  echo " NOT demonstrated. See step 4."
fi
echo "=================================================================="
[[ "$REVOKED" == yes ]] || exit 1
