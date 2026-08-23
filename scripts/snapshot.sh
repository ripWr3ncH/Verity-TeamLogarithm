#!/usr/bin/env bash
# ==========================================================================
#  VERITY — freeze and restore the whole demo state.
#
#    ./scripts/snapshot.sh            take a snapshot
#    ./scripts/snapshot.sh restore    put it back
#    ./scripts/snapshot.sh list       what snapshots exist
#
#  ── WHY THIS EXISTS ──────────────────────────────────────────────────────
#
#  A demo that cannot be run twice will be run once, badly.
#
#  Rehearsing burns state: every run originates loans, commits events, moves
#  parameters. By the fourth rehearsal the queue looks different from the
#  screenshots on the poster, BD-4471 has extra events, and the reconciliation
#  count has drifted. Re-seeding from scratch takes twenty minutes.
#
#  This takes about a minute and puts everything back exactly: ledger blocks,
#  identities, the read model, the core banking mock, the director wallet.
#
#  Run it once when the demo is exactly right, then restore before every
#  rehearsal and before recording each video take.
# ==========================================================================
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$(pwd)"
SNAP_DIR="${ROOT}/.snapshots"
NAME="${2:-demo}"
DEST="${SNAP_DIR}/${NAME}"

C_RESET=$'\033[0m'; C_BLUE=$'\033[34m'; C_GREEN=$'\033[32m'
C_RED=$'\033[31m'; C_DIM=$'\033[2m'; C_YELLOW=$'\033[33m'
say()  { printf "%s==>%s %s\n" "$C_BLUE" "$C_RESET" "$*"; }
ok()   { printf "%s  ok%s %s\n" "$C_GREEN" "$C_RESET" "$*"; }
step() { printf "%s     %s%s\n" "$C_DIM" "$*" "$C_RESET"; }
warn() { printf "%s warn%s %s\n" "$C_YELLOW" "$C_RESET" "$*"; }
die()  { printf "%sfail%s %s\n" "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

# Ledger state lives in named volumes, one per node.
VOLUMES=(
  orderer0.ord-bb.verity.bd orderer1.ord-bibm.verity.bd orderer2.ord-frc.verity.bd
  orderer3.ord-seata.verity.bd orderer4.ord-seatb.verity.bd
  peer0.banka.verity.bd peer0.bankb.verity.bd peer0.bb.verity.bd peer0.frc.verity.bd
)
COMPOSE_NET="network/compose/compose-net.yaml"
COMPOSE_CA="network/compose/compose-ca.yaml"
COMPOSE_SVC="services/compose.yaml"

volumeName() { docker volume ls --format '{{.Name}}' | grep -E "_${1}$|^${1}$" | head -1; }

# --------------------------------------------------------------------------
takeSnapshot() {
  command -v docker >/dev/null || die "docker not found"
  docker info >/dev/null 2>&1 || die "the Docker daemon is not running"
  mkdir -p "$DEST"

  say "Stopping containers so the ledger is quiesced"
  # A volume copied mid-write is a volume you cannot trust. Stop first.
  docker compose -f "$COMPOSE_SVC" stop >/dev/null 2>&1 || true
  docker compose -f "$COMPOSE_CA" stop >/dev/null 2>&1 || true
  docker stop cc-commitment cc-exposure cc-claims >/dev/null 2>&1 || true
  docker compose -f "$COMPOSE_NET" stop >/dev/null 2>&1 || true
  ok "quiesced"

  say "Archiving ledger volumes"
  mkdir -p "${DEST}/volumes"
  for v in "${VOLUMES[@]}"; do
    real="$(volumeName "$v")"
    [[ -z "$real" ]] && { warn "no volume for ${v} — skipping"; continue; }
    docker run --rm -v "${real}:/from:ro" -v "${DEST}/volumes:/to" alpine \
      tar -czf "/to/${v}.tar.gz" -C /from . >/dev/null 2>&1 \
      || die "could not archive ${v}"
    step "$v"
  done

  say "Archiving Postgres"
  pgvol="$(volumeName verity-pgdata)"
  if [[ -n "$pgvol" ]]; then
    docker run --rm -v "${pgvol}:/from:ro" -v "${DEST}/volumes:/to" alpine \
      tar -czf "/to/verity-pgdata.tar.gz" -C /from . >/dev/null 2>&1
    step "verity-pgdata"
  else
    warn "no Postgres volume found"
  fi

  say "Archiving identities and generated fixtures"
  # organizations/ holds every MSP, every enrolled officer, and directors.json.
  # Without it the restored ledger would be readable by nobody.
  tar -czf "${DEST}/organizations.tar.gz" -C network organizations 2>/dev/null \
    || die "could not archive network/organizations"
  step "network/organizations  $(du -h "${DEST}/organizations.tar.gz" | cut -f1)"

  [[ -d seed/out ]] && { tar -czf "${DEST}/seed-out.tar.gz" -C seed out; step "seed/out"; }
  [[ -d network/channel-artifacts ]] && {
    tar -czf "${DEST}/channel-artifacts.tar.gz" -C network channel-artifacts; step "channel-artifacts"; }

  date -u +%Y-%m-%dT%H:%M:%SZ > "${DEST}/taken-at"
  printf '%s\n' "$(docker ps -aq --filter label=service=hyperledger-fabric | wc -l) containers" >> "${DEST}/taken-at"

  printf "\n"
  ok "snapshot '${NAME}' — $(du -sh "$DEST" | cut -f1)"
  step "restore with:  ./scripts/snapshot.sh restore ${NAME}"
  step "containers are STOPPED; bring them back with ./scripts/up.sh or restore"
}

# --------------------------------------------------------------------------
restoreSnapshot() {
  [[ -d "$DEST" ]] || die "no snapshot '${NAME}' — try: ./scripts/snapshot.sh list"

  say "Restoring snapshot '${NAME}' from $(cat "${DEST}/taken-at" | head -1)"

  docker compose -f "$COMPOSE_SVC" stop >/dev/null 2>&1 || true
  docker compose -f "$COMPOSE_CA" stop >/dev/null 2>&1 || true
  docker stop cc-commitment cc-exposure cc-claims >/dev/null 2>&1 || true
  docker compose -f "$COMPOSE_NET" stop >/dev/null 2>&1 || true

  say "Restoring ledger volumes"
  for v in "${VOLUMES[@]}"; do
    [[ -f "${DEST}/volumes/${v}.tar.gz" ]] || continue
    real="$(volumeName "$v")"
    [[ -z "$real" ]] && { warn "volume ${v} missing — run ./scripts/up.sh once first"; continue; }
    docker run --rm -v "${real}:/to" -v "${DEST}/volumes:/from:ro" alpine \
      sh -c 'rm -rf /to/* /to/..?* 2>/dev/null; tar -xzf /from/'"${v}"'.tar.gz -C /to' >/dev/null 2>&1 \
      || die "could not restore ${v}"
    step "$v"
  done

  pgvol="$(volumeName verity-pgdata)"
  if [[ -n "$pgvol" && -f "${DEST}/volumes/verity-pgdata.tar.gz" ]]; then
    docker run --rm -v "${pgvol}:/to" -v "${DEST}/volumes:/from:ro" alpine \
      sh -c 'rm -rf /to/* /to/..?* 2>/dev/null; tar -xzf /from/verity-pgdata.tar.gz -C /to' >/dev/null 2>&1
    step "verity-pgdata"
  fi

  say "Restoring identities and fixtures"
  # Replace the CONTENTS, never the directory itself.
  #
  # The peers and orderers bind-mount paths under network/organizations. On
  # Docker Desktop with the WSL2 backend, deleting and recreating that directory
  # invalidates the daemon's bind-mount cache, and starting the containers then
  # fails with
  #
  #   error while creating mount source path '/run/desktop/mnt/host/wsl/
  #   docker-desktop-bind-mounts/...': file exists
  #
  # which names a path nobody has ever typed. Keeping the directory inode stable
  # avoids it entirely.
  local stage
  stage="$(mktemp -d)"
  tar -xzf "${DEST}/organizations.tar.gz" -C "$stage" || die "could not unpack organizations"
  mkdir -p network/organizations
  find network/organizations -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  cp -a "${stage}/organizations/." network/organizations/
  rm -rf "$stage"
  step "network/organizations"

  [[ -f "${DEST}/seed-out.tar.gz" ]] && { rm -rf seed/out; tar -xzf "${DEST}/seed-out.tar.gz" -C seed; step "seed/out"; }
  [[ -f "${DEST}/channel-artifacts.tar.gz" ]] && {
    rm -rf network/channel-artifacts; tar -xzf "${DEST}/channel-artifacts.tar.gz" -C network; step "channel-artifacts"; }

  say "Starting everything back up"
  # `up -d` rather than `start`: the containers are recreated, so their bind
  # mounts are resolved fresh against the restored directory. `start` reuses the
  # daemon's cached mount source and fails after a restore.
  docker compose -f "$COMPOSE_NET" up -d >/dev/null 2>&1 || die "could not start the network"
  docker start cc-commitment cc-exposure cc-claims >/dev/null 2>&1 || true
  docker compose -f "$COMPOSE_CA" up -d >/dev/null 2>&1 || true
  docker compose -f "$COMPOSE_SVC" up -d postgres >/dev/null 2>&1 || true
  sleep 14

  printf "\n"
  ok "restored"
  step "the API and listener are separate processes — restart them yourself:"
  step "  (cd services/api && node dist/server.js &)"
  step "  (cd services/listener && node dist/listener.js &)"
  step "then check:  ./network/network.sh status"
}

# --------------------------------------------------------------------------
listSnapshots() {
  [[ -d "$SNAP_DIR" ]] || { echo "  no snapshots yet"; return; }
  for d in "$SNAP_DIR"/*/; do
    [[ -d "$d" ]] || continue
    printf "  %-16s %-22s %s\n" \
      "$(basename "$d")" "$(head -1 "${d}taken-at" 2>/dev/null || echo '?')" "$(du -sh "$d" | cut -f1)"
  done
}

case "${1:-take}" in
  take|"")  takeSnapshot ;;
  restore)  restoreSnapshot ;;
  list)     listSnapshots ;;
  *)        sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
