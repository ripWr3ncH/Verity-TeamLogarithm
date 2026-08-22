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

# ── THE VERSION MATRIX IS NOT UNIFORM. Learned the hard way. ──────────────
#
# Only fabric-peer and fabric-orderer publish 3.x tags. fabric-tools and
# fabric-nodeenv stop at 2.5, and pulling them at 3.1.1 fails with
#   "docker.io/hyperledger/fabric-tools:3.1.1: not found"
#
# This is not a workaround. Fabric 3.1.1's OWN config/core.yaml pins
#   node.runtime: $(DOCKER_NS)/fabric-nodeenv:2.5
# so a 3.1.1 peer is designed to launch Node chaincode on the 2.5 runtime.
# Verify it yourself after bootstrap:  grep nodeenv config/core.yaml
#
# fabric-ccenv (Go chaincode builder) is deliberately NOT pulled — our
# chaincode is Node/TypeScript, so nothing ever asks for it.
FABRIC_VERSION="${FABRIC_VERSION:-3.1.1}"      # peer, orderer
NODEENV_VERSION="${NODEENV_VERSION:-2.5}"      # Node chaincode runtime, per core.yaml
TOOLS_VERSION="${TOOLS_VERSION:-2.5}"          # optional cli container only
CA_VERSION="${CA_VERSION:-1.5.22}"             # 1.5.15 does not exist on Docker Hub

C_RESET=$'\033[0m'; C_BLUE=$'\033[34m'; C_GREEN=$'\033[32m'; C_RED=$'\033[31m'
say() { printf "%s==>%s %s\n" "$C_BLUE" "$C_RESET" "$*"; }
ok()  { printf "%s  ok%s %s\n" "$C_GREEN" "$C_RESET" "$*"; }
die() { printf "%sfail%s %s\n" "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

command -v curl >/dev/null || die "curl not found — sudo apt install curl"
command -v docker >/dev/null || die "docker not found"
docker info >/dev/null 2>&1 || die "the Docker daemon is not running — start Docker Desktop"

# jq is needed by install-fabric.sh. A fresh WSL2 Ubuntu does not have it, and
# `sudo apt install` is no help on a machine where sudo wants a password you do
# not have to hand. jq is a single static binary, so fetch it into bin/ (which
# is gitignored and already on the scripts' PATH) rather than blocking.
mkdir -p bin
export PATH="${PWD}/bin:$PATH"
if ! command -v jq >/dev/null; then
  say "jq not found — fetching the static binary into network/bin"
  curl -sSL -o bin/jq https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-linux-amd64 \
    || die "could not download jq"
  chmod +x bin/jq
  ok "jq $(jq --version 2>/dev/null || echo installed)"
fi

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
    "hyperledger/fabric-nodeenv:${NODEENV_VERSION}" \
    "hyperledger/fabric-ca:${CA_VERSION}" \
    "hyperledger/fabric-tools:${TOOLS_VERSION}"
  do
    printf "     %s\n" "$img"
    docker pull -q "$img" >/dev/null || die "could not pull $img"
  done

  # compose defaults to the 2-part tag (e.g. 3.1) for peer and orderer.
  SHORT="${FABRIC_VERSION%.*}"
  docker tag "hyperledger/fabric-peer:${FABRIC_VERSION}"    "hyperledger/fabric-peer:${SHORT}"
  docker tag "hyperledger/fabric-orderer:${FABRIC_VERSION}" "hyperledger/fabric-orderer:${SHORT}"
  ok "images pulled; peer and orderer also tagged :${SHORT}"
fi

printf "\n"
ok "Bootstrap complete."
printf "     Record this in the benchmark annexe — 'latest' is not an answer:\n"
printf "       Fabric %s · Fabric CA %s\n" "${FABRIC_VERSION}" "${CA_VERSION}"
printf "\n     next:  ./network.sh up\n"
