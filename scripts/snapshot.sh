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

  say "Archiving ledger volumes and Postgres"
  mkdir -p "${DEST}/volumes"

  # ONE container mounting every volume, not one container per volume.
  #
  # Not a micro-optimisation. On Docker Desktop with the WSL2 backend a
  # short-lived `docker run --rm` occasionally finishes its work and then never
  # exits: `docker top` shows no processes while `docker ps` still says Up, and
  # the calling script blocks forever. Ten containers is ten chances to hit
  # that; one is one, and it is also several times faster.
  local mounts=() present=()
  for v in "${VOLUMES[@]}" verity-pgdata; do
    real="$(volumeName "$v")"
    [[ -z "$real" ]] && { warn "no volume for ${v} — skipping"; continue; }
    mounts+=(-v "${real}:/vol/${v}:ro")
    present+=("$v")
  done
  [[ ${#present[@]} -eq 0 ]] && die "no Verity volumes — has ./scripts/up.sh ever run?"

  docker run --rm "${mounts[@]}" -v "${DEST}/volumes:/to" alpine \
    sh -c 'for d in /vol/*; do tar -czf "/to/$(basename "$d").tar.gz" -C "$d" . ; done' \
    >/dev/null 2>&1 || die "could not archive the volumes"
  for v in "${present[@]}"; do step "$v"; done

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

  say "Restoring snapshot '${NAME}' from $(head -1 "${DEST}/taken-at")"

  docker compose -f "$COMPOSE_SVC" stop >/dev/null 2>&1 || true
  docker compose -f "$COMPOSE_CA" stop >/dev/null 2>&1 || true
  docker stop cc-commitment cc-exposure cc-claims >/dev/null 2>&1 || true
  docker compose -f "$COMPOSE_NET" stop >/dev/null 2>&1 || true

  say "Restoring ledger volumes and Postgres"
  # One container again — see the note in takeSnapshot.
  local mounts=() present=()
  for v in "${VOLUMES[@]}" verity-pgdata; do
    [[ -f "${DEST}/volumes/${v}.tar.gz" ]] || continue
    real="$(volumeName "$v")"
    [[ -z "$real" ]] && { warn "volume ${v} missing — run ./scripts/up.sh once first"; continue; }
    mounts+=(-v "${real}:/vol/${v}")
    present+=("$v")
  done
  [[ ${#present[@]} -eq 0 ]] && die "nothing to restore into — run ./scripts/up.sh once first"

  docker run --rm "${mounts[@]}" -v "${DEST}/volumes:/from:ro" alpine sh -c '
    for d in /vol/*; do
      n=$(basename "$d")
      rm -rf "$d"/* "$d"/..?* 2>/dev/null
      tar -xzf "/from/${n}.tar.gz" -C "$d"
    done' >/dev/null 2>&1 || die "could not restore the volumes"
  for v in "${present[@]}"; do step "$v"; done

  say "Restoring identities and fixtures"
  # Replace the CONTENTS, never the directory itself — see the --force-recreate
  # note below for what goes wrong when the directory inode changes.
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
  # --force-recreate, and it is not optional.
  #
  # The peers bind-mount paths under network/organizations. Docker Desktop's
  # WSL2 backend shims each bind mount through a hashed directory under
  # /run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/, and a container that
  # is merely STOPPED still owns its entry. Starting it again after the source
  # directory has been rewritten fails with
  #
  #   error while creating mount source path '/run/desktop/mnt/host/wsl/
  #   docker-desktop-bind-mounts/Ubuntu/08cd289e...': file exists
  #
  # naming a path nobody has ever typed. Recreating the container releases the
  # stale entry first and everything resolves. A recreate does not touch named
  # volumes, so the ledger survives it.
  docker compose -f "$COMPOSE_NET" up -d --force-recreate >/dev/null 2>&1 \
    || die "could not start the network"
  docker start cc-commitment cc-exposure cc-claims >/dev/null 2>&1 || true
  docker compose -f "$COMPOSE_CA" up -d --force-recreate >/dev/null 2>&1 || true
  # The WHOLE services stack, not just Postgres. The API, the listener and the
  # portal are all containers; restoring Postgres alone leaves a dashboard with
  # nothing behind it.
  docker compose -f "$COMPOSE_SVC" up -d --force-recreate >/dev/null 2>&1 || true

  step "waiting for the API"
  for _ in $(seq 1 30); do
    curl -fsS -m 2 http://localhost:4000/health >/dev/null 2>&1 && break
    sleep 2
  done

  printf "\n"
  if curl -fsS -m 3 http://localhost:4000/health >/dev/null 2>&1; then
    ok "restored — portal http://localhost:3000"
  else
    warn "restored, but the API did not answer within 60s"
    step "check:  docker logs verity-api --tail 30"
  fi
  step "verify:  ./network/network.sh status"
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
