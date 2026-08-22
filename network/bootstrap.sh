#!/usr/bin/env bash
# ==========================================================================
#  VERITY — one-time toolchain bootstrap
#
#  Downloads the Fabric binaries (peer, orderer, configtxgen, cryptogen,
#  osnadmin, discover, fabric-ca-client) into network/bin, the default
#  configuration into network/config, and pulls the Docker images.
#
#  Run once per machine. Needs internet. Takes 15-30 minutes the first time,
#  almost all of it image download.
#
#    ./bootstrap.sh              # binaries + config + docker images
#    ./bootstrap.sh --no-images  # binaries only (images already pulled)
# ==========================================================================
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

FABRIC_VERSION="${FABRIC_VERSION:-3.1.1}"
CA_VERSION="${CA_VERSION:-1.5.15}"

C_RESET=$'\033[0m'; C_BLUE=$'\033[34m'; C_GREEN=$'\033[32m'; C_RED=$'\033[31m'
say() { printf "%s==>%s %s\n" "$C_BLUE" "$C_RESET" "$*"; }
ok()  { printf "%s  ok%s %s\n" "$C_GREEN" "$C_RESET" "$*"; }
die() { printf "%sfail%s %s\n" "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

command -v curl >/dev/null || die "curl not found — sudo apt install curl"
command -v jq   >/dev/null || die "jq not found — sudo apt install jq"
command -v docker >/dev/null || die "docker not found"
docker info >/dev/null 2>&1 || die "the Docker daemon is not running — start Docker Desktop"

say "Fabric ${FABRIC_VERSION}, Fabric CA ${CA_VERSION}"

if [[ -x bin/peer && -f config/core.yaml ]]; then
  ok "binaries and config already present — skipping download"
else
  say "Downloading install-fabric.sh"
  curl -sSLO https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh
  chmod +x install-fabric.sh

  # `binary` fetches bin/ and config/ into the current directory.
  say "Fetching binaries and default config"
  ./install-fabric.sh --fabric-version "${FABRIC_VERSION}" --ca-version "${CA_VERSION}" binary \
    || die "binary download failed"
  ok "network/bin and network/config ready"
fi

if [[ "${1:-}" != "--no-images" ]]; then
  say "Pulling Docker images (this is the slow part)"
  for img in \
    "hyperledger/fabric-peer:${FABRIC_VERSION}" \
    "hyperledger/fabric-orderer:${FABRIC_VERSION}" \
    "hyperledger/fabric-tools:${FABRIC_VERSION}" \
    "hyperledger/fabric-nodeenv:${FABRIC_VERSION}" \
    "hyperledger/fabric-ca:${CA_VERSION}"
  do
    printf "     %s\n" "$img"
    docker pull -q "$img" >/dev/null || die "could not pull $img"
  done

  # network.sh and compose default to the 2-part tag (e.g. 3.1)
  SHORT="${FABRIC_VERSION%.*}"
  docker tag "hyperledger/fabric-peer:${FABRIC_VERSION}"    "hyperledger/fabric-peer:${SHORT}"
  docker tag "hyperledger/fabric-orderer:${FABRIC_VERSION}" "hyperledger/fabric-orderer:${SHORT}"
  docker tag "hyperledger/fabric-tools:${FABRIC_VERSION}"   "hyperledger/fabric-tools:${SHORT}"
  docker tag "hyperledger/fabric-nodeenv:${FABRIC_VERSION}" "hyperledger/fabric-nodeenv:${SHORT}"
  ok "images pulled and tagged :${SHORT}"
fi

printf "\n"
ok "Bootstrap complete."
printf "     Record this in the benchmark annexe — 'latest' is not an answer:\n"
printf "       Fabric %s · Fabric CA %s\n" "${FABRIC_VERSION}" "${CA_VERSION}"
printf "\n     next:  ./network.sh up\n"
