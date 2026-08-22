#!/usr/bin/env bash
# VERITY — stop everything and clean generated material.
#
# Use this ONLY when the network's shape has changed (orgs, channels, configtx).
# For a contract change, redeploy that one chaincode instead — the network stays
# up and it takes two minutes rather than twenty.
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

printf "\033[34m==>\033[0m stopping services\n"
docker compose -f services/compose.yaml down --volumes --remove-orphans 2>/dev/null || true

printf "\033[34m==>\033[0m stopping certificate authorities\n"
docker compose -f network/compose/compose-ca.yaml down --remove-orphans 2>/dev/null || true

printf "\033[34m==>\033[0m stopping the network\n"
( cd network && ./network.sh down )

printf "\033[32m  ok\033[0m everything down and clean\n"
