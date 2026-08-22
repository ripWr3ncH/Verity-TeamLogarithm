#!/usr/bin/env bash
# ==========================================================================
#  ACT 3a — privacy, enforced by the platform.
#
#  The same query, run from two identities. Bangladesh Bank gets the payload.
#  A competing bank's officer gets the hash.
#
#  The point to make on stage: this is NOT the application deciding to withhold
#  data. The payload was never disseminated to BankB's peer at all — Fabric's
#  private data collections stop it at the gossip layer. The chaincode could
#  not reveal it if it wanted to.
#
#  Both callers see the same hash, so both can verify a payload exists and has
#  not been altered. Confidentiality without giving up integrity.
#
#  Usage:  bash redteam/act3a.sh
# ==========================================================================
set -o pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
source network/scripts/wsl-env.sh >/dev/null

NET="$PWD/network"
export FABRIC_CFG_PATH="$NET/config"
export CORE_PEER_TLS_ENABLED=true
ORDERER=localhost:7050
OCA="$NET/organizations/ordererOrganizations/ord-bb.verity.bd/orderers/orderer0.ord-bb.verity.bd/msp/tlscacerts/tlsca.ord-bb.verity.bd-cert.pem"
PEERS="--peerAddresses localhost:9051 --tlsRootCertFiles $NET/organizations/peerOrganizations/banka.verity.bd/peers/peer0.banka.verity.bd/tls/ca.crt --peerAddresses localhost:9071 --tlsRootCertFiles $NET/organizations/peerOrganizations/bb.verity.bd/peers/peer0.bb.verity.bd/tls/ca.crt"

as() {
  export CORE_PEER_LOCALMSPID="$3"
  export CORE_PEER_TLS_ROOTCERT_FILE="$NET/organizations/peerOrganizations/$2/peers/peer0.$2/tls/ca.crt"
  export CORE_PEER_MSPCONFIGPATH="$NET/organizations/peerOrganizations/$2/users/$1@$2/msp"
  export CORE_PEER_ADDRESS="localhost:$4"
}
# Take the JSON line, not whatever gRPC logged last. `tail -1` grabs an INFO
# line often enough to be worth guarding against — an empty $HASH here shows up
# later as STATE_DIVERGENCE, which points at the chaincode rather than the shell.
qry() { peer chaincode query -C commitment -n commitment -c "$1" 2>/dev/null | grep -a '^[{[]' | tail -1; }

LOAN="BD-PDC-$RANDOM"
Z=$(printf '0%.0s' {1..64})

# The sensitive payload. In production: the para 11(c) justification memo, the
# borrower reference, the exact amounts. Never in the arguments — always
# transient, so it is not written into a transaction the channel can read.
PAYLOAD=$(jq -nc '{
  borrowerRef: "CIB-SUBJ-88213",
  borrowerName: "Meghna Textiles Ltd (SYNTHETIC)",
  exactOutstandingPoisha: "10450000000000",
  justification: "Cash-flow disruption following buyer default; security revalued 12 Jan.",
  collateralValuation: "Tk 62.4 crore, BB-enlisted valuer #114"
}')
PHASH=$(printf '%s' "$PAYLOAD" | sha256sum | cut -d' ' -f1)
B64=$(printf '%s' "$PAYLOAD" | base64 -w0)

echo "=================================================================="
echo " Setup — BankA originates ${LOAN} with a PRIVATE payload"
echo "=================================================================="
as officer-rahim banka.verity.bd BankAMSP 9051
peer chaincode invoke -o "$ORDERER" --ordererTLSHostnameOverride orderer0.ord-bb.verity.bd \
  --tls --cafile "$OCA" -C commitment -n commitment $PEERS \
  -c "$(jq -nc --arg l "$LOAN" --arg h "$PHASH" '{Args:["LifecycleContract:OriginateLoan",$l,"STANDARD","Tk 100-150 crore","G-0447",$h,"2027-01-15"]}')" \
  2>&1 | grep -aoE 'payload:"[^"]*"|message:"[^"]*"' | sed 's/^/    /' | tail -1

# Poll for the commit rather than guessing at a sleep. Block cutting is 2s, but
# a laptop running seventeen containers is not always that prompt, and a fixed
# sleep that is one second short surfaces later as STATE_DIVERGENCE with an
# empty hash — which reads like a chaincode bug and is not one.
HASH=""
for _ in $(seq 1 20); do
  HASH=$(qry "$(jq -nc --arg l "$LOAN" '{Args:["LifecycleContract:GetLoan",$l]}')" | jq -r '.prevStateHash // empty')
  [[ -n "$HASH" ]] && break
  sleep 2
done
[[ -n "$HASH" ]] || { echo "  ${LOAN} never committed — aborting"; exit 1; }
echo "  committed head: ${HASH:0:24}…"
SIG=$(jq -nc '{assigning:{officerId:"officer-rahim",signature:"x"},reviewing:{officerId:"officer-nasrin",signature:"x"}}')

# The chaincode requires the para 11(c) signatures to embed the event-hash
# prefix, so build the event hash exactly as domain/hash.ts does.
EV=$(jq -nc --arg c "$LOAN" --arg d "2027-06-30" --arg p "$HASH" --arg z "$PHASH" \
  '{classificationRefDate:$d,commitmentId:$c,daysToNextRefDate:12,payloadHash:$z,prevStateHash:$p,rsSeq:1,seq:1,tierAfter:"STANDARD",tierBefore:"STANDARD",type:"RESCHEDULE"}')
EVHASH=$(printf '%s' "$EV" | sha256sum | cut -d' ' -f1)
SIG=$(jq -nc --arg s "sig:${EVHASH:0:8}" '{assigning:{officerId:"officer-rahim",signature:$s},reviewing:{officerId:"officer-nasrin",signature:$s}}')

echo "  appending a RESCHEDULE carrying the payload in TRANSIENT"
as officer-nasrin banka.verity.bd BankAMSP 9051
peer chaincode invoke -o "$ORDERER" --ordererTLSHostnameOverride orderer0.ord-bb.verity.bd \
  --tls --cafile "$OCA" -C commitment -n commitment $PEERS \
  --transient "{\"payload\":\"${B64}\"}" \
  -c "$(jq -nc --arg l "$LOAN" --arg h "$HASH" --arg z "$PHASH" --arg s "$SIG" --arg a '{"kind":"ONE_LEVEL_ABOVE"}' \
     '{Args:["LifecycleContract:AppendEvent",$l,"RESCHEDULE","STANDARD","2027-06-18",$h,$z,$s,$a,""]}')" \
  2>&1 | grep -aoE 'payload:"[^"]*"|message:"[^"]*"' | sed 's/^/    /' | tail -1

# Same again: wait for the event to be readable, do not assume.
for _ in $(seq 1 20); do
  qry "$(jq -nc --arg l "$LOAN" '{Args:["LifecycleContract:GetLoan",$l]}')" | jq -e '.eventCount > 1' >/dev/null 2>&1 && break
  sleep 2
done

echo
echo "=================================================================="
echo " 1. Bangladesh Bank (supervisor) reads the payload"
echo "=================================================================="
as supervisor-1 bb.verity.bd BangladeshBankMSP 9071
qry "$(jq -nc --arg l "$LOAN" '{Args:["LifecycleContract:ReadEventPayload",$l,"1"]}')" \
  | jq '{authorised, callerMsp, collection, payloadHash: .payloadHash[0:20], payload}' 2>/dev/null | sed 's/^/  /'

echo
echo "=================================================================="
echo " 2. A COMPETING BANK's officer runs the identical query"
echo "=================================================================="
as officer-shirin bankb.verity.bd BankBMSP 9061
qry "$(jq -nc --arg l "$LOAN" '{Args:["LifecycleContract:ReadEventPayload",$l,"1"]}')" \
  | jq '{authorised, callerMsp, collection, payloadHash: .payloadHash[0:20], reason}' 2>/dev/null | sed 's/^/  /'

echo
echo "=================================================================="
echo " Both saw the SAME hash. Only one saw the payload."
echo "=================================================================="
