#!/usr/bin/env bash
# ==========================================================================
#  VERITY — network control
#
#    ./network.sh up          bring up orderers + peers, create all channels
#    ./network.sh down        stop everything and delete generated material
#    ./network.sh restart     down then up
#    ./network.sh channels    create + join the three channels only
#    ./network.sh status      what is running, and each channel's block height
#    ./network.sh kill-orderer <0-4>    stop one orderer  (Act 5 of the demo)
#    ./network.sh revive-orderer <0-4>  start it again
#
#  Whitepaper §4.1 (BFT ordering, 5 organisations), §4.2 (three channels).
#  Requires: network/bin (Fabric binaries) — run ./bootstrap.sh first.
# ==========================================================================
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT="$(pwd)"

export PATH="${ROOT}/bin:$PATH"
export FABRIC_CFG_PATH="${ROOT}/config"
export VERBOSE=false

FABRIC_VERSION="${FABRIC_VERSION:-3.1}"
export FABRIC_VERSION

COMPOSE_NET="compose/compose-net.yaml"
CHANNELS=(commitment exposure claims)
declare -A PROFILE=(
  [commitment]=VerityCommitment
  [exposure]=VerityExposure
  [claims]=VerityClaims
)
# Which peer orgs join which channel — mirrors the Profiles in configtx.yaml
declare -A CHANNEL_ORGS=(
  [commitment]="banka bankb bb frc"
  [exposure]="banka bankb bb"
  [claims]="banka bb frc"
)

# Peer org -> "MSPID:host:port"
declare -A ORG=(
  [banka]="BankAMSP:peer0.banka.verity.bd:9051"
  [bankb]="BankBMSP:peer0.bankb.verity.bd:9061"
  [bb]="BangladeshBankMSP:peer0.bb.verity.bd:9071"
  [frc]="FRCMSP:peer0.frc.verity.bd:9081"
)
declare -A ORG_DOMAIN=(
  [banka]=banka.verity.bd
  [bankb]=bankb.verity.bd
  [bb]=bb.verity.bd
  [frc]=frc.verity.bd
)

# Orderer index -> "domain:host:generalPort:adminPort"
ORDERERS=(
  "ord-bb.verity.bd:orderer0.ord-bb.verity.bd:7050:8050"
  "ord-bibm.verity.bd:orderer1.ord-bibm.verity.bd:7051:8051"
  "ord-frc.verity.bd:orderer2.ord-frc.verity.bd:7052:8052"
  "ord-seata.verity.bd:orderer3.ord-seata.verity.bd:7053:8053"
  "ord-seatb.verity.bd:orderer4.ord-seatb.verity.bd:7054:8054"
)

C_RESET=$'\033[0m'; C_BLUE=$'\033[34m'; C_GREEN=$'\033[32m'
C_RED=$'\033[31m'; C_YELLOW=$'\033[33m'; C_DIM=$'\033[2m'

say()  { printf "%s==>%s %s\n" "$C_BLUE"  "$C_RESET" "$*"; }
ok()   { printf "%s  ok%s %s\n" "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf "%s warn%s %s\n" "$C_YELLOW" "$C_RESET" "$*"; }
die()  { printf "%sfail%s %s\n" "$C_RED"  "$C_RESET" "$*" >&2; exit 1; }
step() { printf "%s     %s%s\n" "$C_DIM" "$*" "$C_RESET"; }

# ---------------------------------------------------------------------------
checkPrereqs() {
  command -v docker >/dev/null || die "docker not found"
  docker info >/dev/null 2>&1 || die "the Docker daemon is not running — start Docker Desktop"
  [[ -x "${ROOT}/bin/peer" ]] || die "Fabric binaries missing. Run:  ./bootstrap.sh"
  [[ -f "${ROOT}/config/core.yaml" ]] || die "Fabric config missing. Run:  ./bootstrap.sh"
  command -v jq >/dev/null || die "jq not found — sudo apt install jq"
}

# cryptogen names signcerts <CN>-cert.pem on some versions and cert.pem on
# others. configtx.yaml's ConsenterMapping needs a deterministic path, so
# normalise to cert.pem everywhere. Costs nothing and removes a whole class of
# "file not found" failures on day 0.
normaliseSigncerts() {
  local f
  while IFS= read -r -d '' d; do
    [[ -f "$d/cert.pem" ]] && continue
    f="$(find "$d" -maxdepth 1 -name '*.pem' | head -1)"
    [[ -n "$f" ]] && cp "$f" "$d/cert.pem"
  done < <(find organizations -type d -name signcerts -print0)
}

generateCrypto() {
  say "Generating X.509 material for 5 ordering and 4 peer organisations"
  rm -rf organizations/ordererOrganizations organizations/peerOrganizations
  cryptogen generate --config=./crypto-config.yaml --output=./organizations \
    || die "cryptogen failed"
  normaliseSigncerts
  ok "crypto material written to organizations/"
}

generateGenesisBlocks() {
  say "Generating channel genesis blocks"
  mkdir -p channel-artifacts
  for ch in "${CHANNELS[@]}"; do
    configtxgen -profile "${PROFILE[$ch]}" \
      -outputBlock "./channel-artifacts/${ch}.block" \
      -channelID "$ch" \
      || die "configtxgen failed for channel '$ch' (profile ${PROFILE[$ch]})"
    step "channel-artifacts/${ch}.block"
  done
  ok "three genesis blocks"
}

startContainers() {
  say "Starting orderers and peers"
  docker compose -f "$COMPOSE_NET" up -d
  step "waiting for the ordering service to settle"
  sleep 8
  ok "containers up"
}

# ---------------------------------------------------------------------------
#  Channel creation — Fabric v3 has no system channel; every orderer joins
#  each application channel through the admin (osnadmin) endpoint.
# ---------------------------------------------------------------------------
joinOrderersToChannel() {
  local ch="$1" entry domain host admin
  for entry in "${ORDERERS[@]}"; do
    IFS=: read -r domain host _ admin <<<"$entry"
    local tlsdir="${ROOT}/organizations/ordererOrganizations/${domain}/orderers/${host}/tls"
    osnadmin channel join \
      --channelID "$ch" \
      --config-block "./channel-artifacts/${ch}.block" \
      -o "localhost:${admin}" \
      --ca-file "${tlsdir}/ca.crt" \
      --client-cert "${tlsdir}/server.crt" \
      --client-key "${tlsdir}/server.key" >/dev/null \
      || die "orderer ${host} failed to join channel '${ch}'"
    step "${host} joined ${ch}"
  done
}

# Export the peer CLI environment for one organisation.
setOrgContext() {
  local org="$1" mspid host port domain
  IFS=: read -r mspid host port <<<"${ORG[$org]}"
  domain="${ORG_DOMAIN[$org]}"
  export CORE_PEER_TLS_ENABLED=true
  export CORE_PEER_LOCALMSPID="$mspid"
  export CORE_PEER_TLS_ROOTCERT_FILE="${ROOT}/organizations/peerOrganizations/${domain}/peers/peer0.${domain}/tls/ca.crt"
  export CORE_PEER_MSPCONFIGPATH="${ROOT}/organizations/peerOrganizations/${domain}/users/Admin@${domain}/msp"
  export CORE_PEER_ADDRESS="localhost:${port}"
}

joinPeersToChannel() {
  local ch="$1" org
  for org in ${CHANNEL_ORGS[$ch]}; do
    setOrgContext "$org"
    peer channel join -b "./channel-artifacts/${ch}.block" >/dev/null \
      || die "peer0.${ORG_DOMAIN[$org]} failed to join '${ch}'"
    step "peer0.${ORG_DOMAIN[$org]} joined ${ch}"
  done
}

createChannels() {
  local ch
  for ch in "${CHANNELS[@]}"; do
    say "Channel '${ch}'"
    joinOrderersToChannel "$ch"
    joinPeersToChannel "$ch"
    ok "channel '${ch}' live"
  done
}

# ---------------------------------------------------------------------------
networkUp() {
  checkPrereqs
  generateCrypto
  generateGenesisBlocks
  startContainers
  createChannels
  printf "\n"
  ok "Network up — 5 orderers (BFT, tolerates f=1), 4 peers, 3 channels"
  step "next:  ../scripts/deploy-cc.sh commitment"
  step "check: ./network.sh status"
}

networkDown() {
  say "Stopping containers"
  docker compose -f "$COMPOSE_NET" down --volumes --remove-orphans 2>/dev/null || true
  # Chaincode containers are launched by the peers, not by compose.
  local cc
  cc="$(docker ps -aq --filter name='dev-peer0' || true)"
  [[ -n "$cc" ]] && docker rm -f $cc >/dev/null 2>&1 || true
  local ccimg
  ccimg="$(docker images -q --filter reference='dev-peer0*' || true)"
  [[ -n "$ccimg" ]] && docker rmi -f $ccimg >/dev/null 2>&1 || true
  say "Removing generated material"
  rm -rf organizations/ordererOrganizations organizations/peerOrganizations \
         channel-artifacts *.tar.gz
  ok "down and clean"
}

networkStatus() {
  say "Containers"
  docker ps --filter label=service=hyperledger-fabric \
    --format 'table {{.Names}}\t{{.Status}}' || true
  printf "\n"
  say "Channel heights (as seen by peer0.banka)"
  if [[ ! -d organizations/peerOrganizations ]]; then
    warn "no crypto material — network is down"
    return
  fi
  setOrgContext banka
  local ch
  for ch in "${CHANNELS[@]}"; do
    local h
    h="$(peer channel getinfo -c "$ch" 2>/dev/null | sed -n 's/.*"height":\([0-9]*\).*/\1/p')" || true
    printf "     %-12s height %s\n" "$ch" "${h:-unreachable}"
  done
}

killOrderer() {
  local i="${1:?usage: ./network.sh kill-orderer <0-4>}"
  local entry="${ORDERERS[$i]}" host
  IFS=: read -r _ host _ _ <<<"$entry"
  docker stop "$host" >/dev/null
  warn "stopped ${host} — BFT tolerates f=1, the network should keep committing"
  step "prove it:  ./network.sh status"
}

reviveOrderer() {
  local i="${1:?usage: ./network.sh revive-orderer <0-4>}"
  local entry="${ORDERERS[$i]}" host
  IFS=: read -r _ host _ _ <<<"$entry"
  docker start "$host" >/dev/null
  ok "started ${host}"
}

# ---------------------------------------------------------------------------
case "${1:-help}" in
  up)             networkUp ;;
  down)           networkDown ;;
  restart)        networkDown; networkUp ;;
  channels)       checkPrereqs; createChannels ;;
  status)         networkStatus ;;
  kill-orderer)   killOrderer "${2:-}" ;;
  revive-orderer) reviveOrderer "${2:-}" ;;
  *)              sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
