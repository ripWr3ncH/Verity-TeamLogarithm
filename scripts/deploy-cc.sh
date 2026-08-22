#!/usr/bin/env bash
# ==========================================================================
#  VERITY — chaincode deployment
#
#    ./scripts/deploy-cc.sh commitment
#    ./scripts/deploy-cc.sh exposure
#    ./scripts/deploy-cc.sh claims
#
#  One chaincode per channel (HANDOFF/PHASE_00_FOUNDATION.md §2.3).
#  The network stays UP — redeploying one chaincode takes 2-5 minutes and does
#  not require tearing anything down. Reach for network.sh down only when the
#  network's SHAPE changes.
#
#  Endorsement policies below are the point of the whole design: a lifecycle
#  event needs the bank's peer AND Bangladesh Bank's, so regulatory endorsement
#  is a precondition of commitment rather than a review afterwards (§3.8 step 4).
# ==========================================================================
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$(pwd)"
NET="${ROOT}/network"

export PATH="${NET}/bin:$PATH"
export FABRIC_CFG_PATH="${NET}/config"

CC_NAME="${1:?usage: ./scripts/deploy-cc.sh <commitment|exposure|claims>}"
CC_VERSION="${CC_VERSION:-1.0}"
CC_SEQUENCE="${CC_SEQUENCE:-1}"
CC_PATH="${ROOT}/chaincode/${CC_NAME}"

# channel + endorsement policy + which orgs install
case "$CC_NAME" in
  commitment)
    CHANNEL=commitment
    # bank AND supervisor
    POLICY="AND(OR('BankAMSP.peer','BankBMSP.peer'),'BangladeshBankMSP.peer')"
    ORGS="banka bankb bb frc"
    ;;
  exposure)
    CHANNEL=exposure
    POLICY="AND(OR('BankAMSP.peer','BankBMSP.peer'),'BangladeshBankMSP.peer')"
    ORGS="banka bankb bb"
    ;;
  claims)
    CHANNEL=claims
    POLICY="AND('BankAMSP.peer','BangladeshBankMSP.peer')"
    ORGS="banka bb frc"
    ;;
  *) echo "unknown chaincode '$CC_NAME'" >&2; exit 1 ;;
esac

declare -A ORG_MSP=(
  [banka]=BankAMSP [bankb]=BankBMSP [bb]=BangladeshBankMSP [frc]=FRCMSP
)
declare -A ORG_DOMAIN=(
  [banka]=banka.verity.bd [bankb]=bankb.verity.bd [bb]=bb.verity.bd [frc]=frc.verity.bd
)
declare -A ORG_PORT=(
  [banka]=9051 [bankb]=9061 [bb]=9071 [frc]=9081
)

ORDERER=localhost:7050
ORDERER_CA="${NET}/organizations/ordererOrganizations/ord-bb.verity.bd/orderers/orderer0.ord-bb.verity.bd/msp/tlscacerts/tlsca.ord-bb.verity.bd-cert.pem"

C_RESET=$'\033[0m'; C_BLUE=$'\033[34m'; C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_DIM=$'\033[2m'
say()  { printf "%s==>%s %s\n" "$C_BLUE" "$C_RESET" "$*"; }
ok()   { printf "%s  ok%s %s\n" "$C_GREEN" "$C_RESET" "$*"; }
step() { printf "%s     %s%s\n" "$C_DIM" "$*" "$C_RESET"; }
die()  { printf "%sfail%s %s\n" "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

setOrg() {
  local org="$1" domain="${ORG_DOMAIN[$1]}"
  export CORE_PEER_TLS_ENABLED=true
  export CORE_PEER_LOCALMSPID="${ORG_MSP[$org]}"
  export CORE_PEER_TLS_ROOTCERT_FILE="${NET}/organizations/peerOrganizations/${domain}/peers/peer0.${domain}/tls/ca.crt"
  export CORE_PEER_MSPCONFIGPATH="${NET}/organizations/peerOrganizations/${domain}/users/Admin@${domain}/msp"
  export CORE_PEER_ADDRESS="localhost:${ORG_PORT[$org]}"
}

peerFlags() {
  local org domain flags=""
  for org in $ORGS; do
    domain="${ORG_DOMAIN[$org]}"
    flags+=" --peerAddresses localhost:${ORG_PORT[$org]}"
    flags+=" --tlsRootCertFiles ${NET}/organizations/peerOrganizations/${domain}/peers/peer0.${domain}/tls/ca.crt"
  done
  echo "$flags"
}

# ---------------------------------------------------------------------------
[[ -d "$CC_PATH" ]] || die "no chaincode at ${CC_PATH}"
[[ -x "${NET}/bin/peer" ]] || die "Fabric binaries missing — run network/bootstrap.sh"
[[ -f "$ORDERER_CA" ]] || die "orderer TLS CA not found — is the network up?"

say "Building ${CC_NAME}"
( cd "$CC_PATH" && npm install --silent --no-audit --no-fund && npm run build ) \
  || die "chaincode build failed — fix it before deploying"
ok "compiled"

say "Packaging"
PKG="${ROOT}/${CC_NAME}.tar.gz"
rm -f "$PKG"
peer lifecycle chaincode package "$PKG" \
  --path "$CC_PATH" --lang node --label "${CC_NAME}_${CC_VERSION}" \
  || die "package failed"
PKG_ID=""
ok "$(basename "$PKG")"

say "Installing on: ${ORGS}"
for org in $ORGS; do
  setOrg "$org"
  if peer lifecycle chaincode queryinstalled 2>/dev/null | grep -q "${CC_NAME}_${CC_VERSION}"; then
    step "${org} already has it"
  else
    peer lifecycle chaincode install "$PKG" >/dev/null 2>&1 || die "install failed on ${org}"
    step "${org} installed"
  fi
done

setOrg banka
PKG_ID="$(peer lifecycle chaincode queryinstalled | sed -n "s/^Package ID: \(.*\), Label: ${CC_NAME}_${CC_VERSION}$/\1/p" | head -1)"
[[ -n "$PKG_ID" ]] || die "could not determine the package id"
step "package id ${PKG_ID:0:24}…"

say "Approving for each organisation"
step "policy: ${POLICY}"
for org in $ORGS; do
  setOrg "$org"
  peer lifecycle chaincode approveformyorg \
    -o "$ORDERER" --ordererTLSHostnameOverride orderer0.ord-bb.verity.bd \
    --tls --cafile "$ORDERER_CA" \
    --channelID "$CHANNEL" --name "$CC_NAME" --version "$CC_VERSION" \
    --package-id "$PKG_ID" --sequence "$CC_SEQUENCE" \
    --signature-policy "$POLICY" >/dev/null \
    || die "approve failed for ${org}"
  step "${org} approved"
done

say "Checking commit readiness"
setOrg banka
peer lifecycle chaincode checkcommitreadiness \
  --channelID "$CHANNEL" --name "$CC_NAME" --version "$CC_VERSION" \
  --sequence "$CC_SEQUENCE" --signature-policy "$POLICY" --output json \
  || die "commit readiness check failed"

say "Committing to channel '${CHANNEL}'"
# shellcheck disable=SC2046
peer lifecycle chaincode commit \
  -o "$ORDERER" --ordererTLSHostnameOverride orderer0.ord-bb.verity.bd \
  --tls --cafile "$ORDERER_CA" \
  --channelID "$CHANNEL" --name "$CC_NAME" --version "$CC_VERSION" \
  --sequence "$CC_SEQUENCE" --signature-policy "$POLICY" \
  $(peerFlags) >/dev/null \
  || die "commit failed"
ok "committed"

if [[ "$CC_NAME" == "commitment" ]]; then
  say "Writing the genesis calibration (λ, E*, θ, k, quorum)"
  step "illustrative values — Council-set at calibration (§3.7.1, §4.6)"
  sleep 3
  # shellcheck disable=SC2046
  peer chaincode invoke \
    -o "$ORDERER" --ordererTLSHostnameOverride orderer0.ord-bb.verity.bd \
    --tls --cafile "$ORDERER_CA" \
    -C "$CHANNEL" -n "$CC_NAME" \
    $(peerFlags) \
    -c '{"Args":["GovernanceContract:InitParameters"]}' 2>&1 | tail -1
fi

rm -f "$PKG"
printf "\n"
ok "${CC_NAME} live on channel '${CHANNEL}'"
step "verify: peer chaincode query -C ${CHANNEL} -n ${CC_NAME} -c '{\"Args\":[\"GovernanceContract:ListParameters\"]}'"
