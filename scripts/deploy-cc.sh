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
# Private data collections. §4.2: a collection per institution, shared with
# Bangladesh Bank and that institution's auditor. Without --collections-config
# every channel member can read every payload, and Act 3a's two-identity
# comparison is a claim rather than a demonstration.
COLLECTIONS=""

case "$CC_NAME" in
  commitment)
    CHANNEL=commitment
    # bank AND supervisor
    POLICY="AND(OR('BankAMSP.peer','BankBMSP.peer'),'BangladeshBankMSP.peer')"
    ORGS="banka bankb bb frc"
    COLLECTIONS="${ROOT}/chaincode/commitment/collections.json"
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

COLLECTION_FLAG=""
if [[ -n "$COLLECTIONS" ]]; then
  [[ -f "$COLLECTIONS" ]] || die "collections config not found: $COLLECTIONS"
  COLLECTION_FLAG="--collections-config $COLLECTIONS"
fi

say "Building ${CC_NAME}"
( cd "$CC_PATH" && npm install --silent --no-audit --no-fund && npm run build ) \
  || die "chaincode build failed — fix it before deploying"
ok "compiled"

# ---------------------------------------------------------------------------
#  Package from a CLEAN STAGING DIRECTORY, never from the source tree.
#
#  `peer lifecycle chaincode package --path X` archives everything under X,
#  node_modules included. With dependencies installed for the local build that
#  is 150 MB+, and the peer then streams the whole thing to the Docker daemon
#  to build a chaincode image. It does not survive the trip:
#
#      could not build chaincode: docker build failed:
#      docker image build failed: write unix @->/var/run/docker.sock:
#      write: broken pipe
#
#  which names Docker rather than the package size and sends you hunting in the
#  wrong place entirely.
#
#  The peer runs `npm install` itself inside fabric-nodeenv, so the package
#  needs only package.json, the lockfile and dist/. Staging those keeps it
#  around 100 KB and makes chaincode container start-up markedly faster.
# ---------------------------------------------------------------------------
CC_SERVICE="cc-${CC_NAME}"
CC_PORT=9999

say "Packaging as a chaincode service"
step "the peer never builds an image; it dials ${CC_SERVICE}:${CC_PORT}"

PKG="${ROOT}/${CC_NAME}.tar.gz"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# A ccaas package carries only how to REACH the chaincode. The code itself
# ships in the container image built below.
mkdir -p "${STAGE}/src"
cat > "${STAGE}/src/connection.json" <<EOF
{
  "address": "${CC_SERVICE}:${CC_PORT}",
  "dial_timeout": "10s",
  "tls_required": false
}
EOF
cat > "${STAGE}/metadata.json" <<EOF
{
  "type": "ccaas",
  "label": "${CC_NAME}_${CC_VERSION}"
}
EOF

rm -f "$PKG"
tar -czf "${STAGE}/code.tar.gz" -C "${STAGE}/src" connection.json
tar -czf "$PKG" -C "$STAGE" code.tar.gz metadata.json
ok "$(basename "$PKG") ($(du -h "$PKG" | cut -f1))"

say "Installing on: ${ORGS}"
for org in $ORGS; do
  setOrg "$org"
  if peer lifecycle chaincode queryinstalled 2>/dev/null | grep -q "${CC_NAME}_${CC_VERSION}"; then
    step "${org} already has it"
  else
    # Do NOT swallow this. The peer builds a chaincode image here, and when it
    # fails the reason is in the last line of its output — "broken pipe" for an
    # oversized package, an npm error for a bad dependency, a timeout for a
    # slow first build. Hiding it turns a five-minute fix into an hour.
    if ! install_log="$(peer lifecycle chaincode install "$PKG" 2>&1)"; then
      printf '%s\n' "$install_log" | grep -avE 'INFO |grpc|^\s*[]{}[]|Addr"|ServerName|Attributes|Metadata|Endpoints|ServiceConfig|shuffleAddressList|^\s*$' | tail -5 >&2
      die "install failed on ${org}"
    fi
    step "${org} installed"
  fi
done

setOrg banka
PKG_ID="$(peer lifecycle chaincode queryinstalled | sed -n "s/^Package ID: \(.*\), Label: ${CC_NAME}_${CC_VERSION}$/\1/p" | head -1)"
[[ -n "$PKG_ID" ]] || die "could not determine the package id"
step "package id ${PKG_ID:0:24}…"

# ---------------------------------------------------------------------------
#  Start the chaincode service.
#
#  CHAINCODE_ID must be exactly the package id the peer computed at install.
#  If they differ the peer rejects the registration with a mismatched-id error
#  that does not say which side is wrong — so it is passed through, never
#  retyped.
# ---------------------------------------------------------------------------
say "Starting the chaincode service"
docker build -q \
  -f "${ROOT}/chaincode/Dockerfile" \
  --build-arg "CC_NAME=${CC_NAME}" \
  -t "verity/${CC_NAME}-cc:${CC_VERSION}" \
  "$ROOT" >/dev/null || die "could not build the ${CC_NAME} chaincode image"
step "image verity/${CC_NAME}-cc:${CC_VERSION}"

docker rm -f "$CC_SERVICE" >/dev/null 2>&1 || true
docker run -d \
  --name "$CC_SERVICE" \
  --network verity_net \
  --label service=hyperledger-fabric \
  --label verity.role=chaincode \
  -e "CHAINCODE_ID=${PKG_ID}" \
  -e "CHAINCODE_SERVER_ADDRESS=0.0.0.0:${CC_PORT}" \
  "verity/${CC_NAME}-cc:${CC_VERSION}" >/dev/null \
  || die "could not start ${CC_SERVICE}"

# Give the server a moment to bind before the peers are told to dial it.
for _ in $(seq 1 20); do
  docker logs "$CC_SERVICE" 2>&1 | grep -q "Starting chaincode\|server started\|Listening" && break
  sleep 1
done
ok "${CC_SERVICE} listening on ${CC_PORT}"

# ---------------------------------------------------------------------------
#  --waitForEvent=false, then verify by querying STATE.
#
#  The lifecycle commands default to waiting on each peer's deliver-filtered
#  stream. On Docker Desktop with the WSL2 backend that stream is unreliable:
#
#      Error: timed out waiting for txid on all peers
#
#  and the result is ambiguous — sometimes the transaction committed anyway,
#  sometimes it genuinely did not. Waiting on an event we cannot trust tells us
#  nothing either way.
#
#  So: do not wait for the event, and confirm the outcome by reading the state
#  the transaction was supposed to produce. That is the thing we actually care
#  about, and it is unambiguous.
# ---------------------------------------------------------------------------
readiness() {
  setOrg banka
  peer lifecycle chaincode checkcommitreadiness \
    --channelID "$CHANNEL" --name "$CC_NAME" --version "$CC_VERSION" \
    --sequence "$CC_SEQUENCE" --signature-policy "$POLICY" $COLLECTION_FLAG \
    --output json 2>/dev/null
}

alreadyCommitted() {
  setOrg banka
  peer lifecycle chaincode querycommitted --channelID "$CHANNEL" --name "$CC_NAME" 2>/dev/null \
    | grep -q "Sequence: ${CC_SEQUENCE},"
}

# If this sequence is already live, approving it again is an error, not a
# no-op ("attempted to redefine the current committed sequence"). Re-running a
# deploy has to be safe — the chaincode service was rebuilt and restarted
# above, which is the part that actually needed doing.
if alreadyCommitted; then
  say "Sequence ${CC_SEQUENCE} is already committed"
  step "chaincode service rebuilt and reconnected; nothing to approve"
  rm -f "$PKG"
  printf "\n"
  ok "${CC_NAME} live on channel '${CHANNEL}' at sequence ${CC_SEQUENCE}"
  exit 0
fi

say "Approving for each organisation"
step "policy: ${POLICY}"
[[ -n "$COLLECTION_FLAG" ]] && step "collections: $(basename "$COLLECTIONS")"
for org in $ORGS; do
  setOrg "$org"

  # Re-running a deploy must be safe. An approval that already landed comes
  # back as:
  #
  #   attempted to redefine uncommitted sequence (N) for namespace X
  #   with unchanged content
  #
  # which is not a failure — it is the state we wanted. Treating it as an error
  # is what turns "the event wait timed out but the transaction committed" into
  # a deploy that can never be retried.
  approve_log="$(peer lifecycle chaincode approveformyorg \
    -o "$ORDERER" --ordererTLSHostnameOverride orderer0.ord-bb.verity.bd \
    --tls --cafile "$ORDERER_CA" \
    --channelID "$CHANNEL" --name "$CC_NAME" --version "$CC_VERSION" \
    --package-id "$PKG_ID" --sequence "$CC_SEQUENCE" \
    --signature-policy "$POLICY" $COLLECTION_FLAG \
    --waitForEvent=false 2>&1)" || {
      if grep -q "unchanged content" <<<"$approve_log"; then
        step "${org} had already approved this definition"
      else
        printf '%s\n' "$approve_log" | grep -aE 'Error:' | tail -3 >&2
        die "approve failed for ${org}"
      fi
    }

  # Confirm this org's approval actually landed, rather than trusting the call.
  msp="${ORG_MSP[$org]}"
  approved=false
  for _ in $(seq 1 20); do
    if readiness | jq -e --arg m "$msp" '.approvals[$m] == true' >/dev/null 2>&1; then
      approved=true
      break
    fi
    sleep 2
  done
  [[ "$approved" == true ]] || die "approval from ${org} (${msp}) never committed"
  step "${org} approved"
done

say "Commit readiness"
readiness | jq -c '.approvals' | sed 's/^/     /'

say "Committing to channel '${CHANNEL}'"
# shellcheck disable=SC2046
peer lifecycle chaincode commit \
  -o "$ORDERER" --ordererTLSHostnameOverride orderer0.ord-bb.verity.bd \
  --tls --cafile "$ORDERER_CA" \
  --channelID "$CHANNEL" --name "$CC_NAME" --version "$CC_VERSION" \
  --sequence "$CC_SEQUENCE" --signature-policy "$POLICY" $COLLECTION_FLAG \
  --waitForEvent=false \
  $(peerFlags) >/dev/null 2>&1 || true

# The commit call's exit status is deliberately ignored: like approve, it can
# report a timeout on a transaction that committed, and it errors outright if
# the definition is already live. The querycommitted poll below is the real
# answer — verify by state, never by exit code.
setOrg banka
committed=false
for _ in $(seq 1 20); do
  if peer lifecycle chaincode querycommitted --channelID "$CHANNEL" --name "$CC_NAME" 2>/dev/null \
     | grep -q "Sequence: ${CC_SEQUENCE},"; then
    committed=true
    break
  fi
  sleep 2
done
[[ "$committed" == true ]] || die "commit never took effect at sequence ${CC_SEQUENCE}"
ok "committed at sequence ${CC_SEQUENCE}"

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
    --waitForEvent=false \n    -c '{"Args":["GovernanceContract:InitParameters"]}' 2>&1 | grep -aoE 'payload:"[^"]*"|message:"[^"]*"' | tail -1
fi

rm -f "$PKG"
printf "\n"
ok "${CC_NAME} live on channel '${CHANNEL}'"
step "verify: peer chaincode query -C ${CHANNEL} -n ${CC_NAME} -c '{\"Args\":[\"GovernanceContract:ListParameters\"]}'"
