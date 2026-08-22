#!/usr/bin/env bash
# ==========================================================================
#  VERITY — WSL2 environment shim.
#
#  Source this before running anything on a machine where WSL2 has no Node and
#  no passwordless sudo:
#
#      source network/scripts/wsl-env.sh
#
#  Two things a fresh WSL2 Ubuntu is missing that the toolchain needs, and
#  neither can be installed with `sudo apt` when sudo wants a password:
#
#    node   — deploy-cc.sh builds the chaincode before packaging it.
#             Installed to ~/.local/node by this script (no sudo required).
#    jq     — install-fabric.sh parses GitHub API responses with it.
#             bootstrap.sh fetches the static binary into network/bin.
#
#  Both live in user space. Nothing here touches the system.
# ==========================================================================

VERITY_NODE_VERSION="${VERITY_NODE_VERSION:-22.14.0}"
VERITY_NODE_HOME="${HOME}/.local/node"

if [[ ! -x "${VERITY_NODE_HOME}/bin/node" ]]; then
  printf '==> installing Node %s into %s (no sudo needed)\n' "$VERITY_NODE_VERSION" "$VERITY_NODE_HOME"
  mkdir -p "$VERITY_NODE_HOME"
  curl -sSL "https://nodejs.org/dist/v${VERITY_NODE_VERSION}/node-v${VERITY_NODE_VERSION}-linux-x64.tar.xz" \
    | tar -xJ -C "$VERITY_NODE_HOME" --strip-components=1 \
    || { printf 'failed to install Node\n' >&2; return 1 2>/dev/null || exit 1; }
fi

export PATH="${VERITY_NODE_HOME}/bin:$PATH"

# network/bin holds the Fabric binaries and the jq bootstrap.sh fetched.
_verity_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="${_verity_root}/bin:$PATH"
unset _verity_root

printf '    node %s · npm %s · jq %s\n' \
  "$(node --version 2>/dev/null || echo missing)" \
  "$(npm --version 2>/dev/null || echo missing)" \
  "$(jq --version 2>/dev/null || echo missing)"
