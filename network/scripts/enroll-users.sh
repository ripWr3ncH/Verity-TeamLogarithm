#!/usr/bin/env bash
# ==========================================================================
#  VERITY — enrol the demo identities with role attributes.
#
#  Whitepaper §4.4: officers carry role attributes that CHAINCODE READS. This
#  script is what makes that true rather than asserted — every identity below
#  gets `role`, `seniority` and `institution` burned into its X.509 by the
#  organisation's own CA. A client cannot set them.
#
#  Run AFTER ./network.sh up, and after the CA containers are running:
#      docker compose -f compose/compose-ca.yaml up -d
#      ./scripts/enroll-users.sh
#
#  ── THE RULE THIS ENFORCES ───────────────────────────────────────────────
#  ONE IDENTITY PER PERSON. No shared admin identity anywhere in the demo path.
#  If the API ever signs on behalf of "the bank" rather than a named officer,
#  Act 1's refusal and Act 3a's two-identity comparison both become theatre.
# ==========================================================================
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$(pwd)"
export PATH="${ROOT}/bin:$PATH"

C_RESET=$'\033[0m'; C_BLUE=$'\033[34m'; C_GREEN=$'\033[32m'; C_RED=$'\033[31m'
C_DIM=$'\033[2m'; C_YELLOW=$'\033[33m'
say()  { printf "%s==>%s %s\n" "$C_BLUE" "$C_RESET" "$*"; }
ok()   { printf "%s  ok%s %s\n" "$C_GREEN" "$C_RESET" "$*"; }
step() { printf "%s     %s%s\n" "$C_DIM" "$*" "$C_RESET"; }
die()  { printf "%sfail%s %s\n" "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

command -v fabric-ca-client >/dev/null || die "fabric-ca-client missing — run ./bootstrap.sh"

# org -> "domain:caPort:caName"
declare -A ORG=(
  [banka]="banka.verity.bd:10054:ca-banka"
  [bankb]="bankb.verity.bd:10064:ca-bankb"
  [bb]="bb.verity.bd:10074:ca-bb"
  [frc]="frc.verity.bd:10084:ca-frc"
)

# ---------------------------------------------------------------------------
#  The cast. "org|user|role|seniority|display name"
#
#  Seniority is the scale ONE_LEVEL_ABOVE compares against (Phase 1 §2.4):
#    sanctioning_officer 2 · reviewing_officer 3 · mdceo 5 · director 5
#
#  TWO officers sit at seniority 2 alongside officer-rahim: officer-kamal and
#  officer-farhana. Equal-seniority approval is red-team #2 and needs a real
#  identity to fail with, and kamal is the standing subject of the revocation
#  demo — so farhana exists to keep the two attacks from colliding.
# ---------------------------------------------------------------------------
USERS=(
  # Sammilito Islami Bank — the originating institution in Act 1
  "banka|officer-rahim|sanctioning_officer|2|Rahim Uddin"
  "banka|officer-nasrin|reviewing_officer|3|Nasrin Akhter"
  "banka|officer-kamal|sanctioning_officer|2|Kamal Hossain"
  # A SECOND officer at seniority 2. officer-kamal is the standing subject of
  # the revocation demo (redteam/revoke.sh), so once that has run he can no
  # longer be used to test equal-seniority approval — the two attacks would
  # collide and red-team #2 would fail for the wrong reason.
  "banka|officer-farhana|sanctioning_officer|2|Farhana Islam"
  "banka|md-banka|mdceo|5|Managing Director"
  "banka|director-1|director|5|Director One"
  "banka|director-2|director|5|Director Two"
  "banka|director-3|director|5|Director Three"
  "banka|adapter-banka|adapter|1|CBS read-only adapter"

  # Meghna Bank — needed for Act 3a's two-identity privacy comparison
  "bankb|officer-shirin|sanctioning_officer|2|Shirin Sultana"
  "bankb|officer-tanvir|reviewing_officer|3|Tanvir Ahmed"
  "bankb|md-bankb|mdceo|5|Managing Director"
  "bankb|adapter-bankb|adapter|1|CBS read-only adapter"

  # Bangladesh Bank — endorses every lifecycle event, and its reads are logged
  "bb|supervisor-1|supervisor|5|Supervisory officer"
  "bb|supervisor-2|supervisor|5|Supervisory officer"

  # Financial Reporting Council — read all, borrower identity never
  "frc|frc-analyst|frc|4|FRC analyst"
)

# ---------------------------------------------------------------------------
enrolCaAdmin() {
  local org="$1" domain caPort caName
  IFS=: read -r domain caPort caName <<<"${ORG[$org]}"

  local home="${ROOT}/organizations/peerOrganizations/${domain}/ca-admin"
  mkdir -p "$home"
  FABRIC_CA_CLIENT_HOME="$home" fabric-ca-client enroll \
    -u "http://admin:adminpw@localhost:${caPort}" \
    --caname "$caName" >/dev/null 2>&1 \
    || die "could not enrol the CA admin for ${org} — is ${caName} running on ${caPort}?"
}

registerAndEnrol() {
  local org="$1" user="$2" role="$3" seniority="$4" display="$5"
  local domain caPort caName
  IFS=: read -r domain caPort caName <<<"${ORG[$org]}"

  local adminHome="${ROOT}/organizations/peerOrganizations/${domain}/ca-admin"
  local userHome="${ROOT}/organizations/peerOrganizations/${domain}/users/${user}@${domain}"

  # Attributes with :ecert are copied into the certificate itself, which is what
  # ClientIdentity.getAttributeValue() reads inside chaincode.
  FABRIC_CA_CLIENT_HOME="$adminHome" fabric-ca-client register \
    --caname "$caName" \
    --id.name "$user" --id.secret "${user}pw" --id.type client \
    --id.attrs "role=${role}:ecert,seniority=${seniority}:ecert,institution=${org}:ecert,displayName=${display}:ecert" \
    >/dev/null 2>&1 || true   # already registered is fine

  mkdir -p "$userHome"

  # ── Enrol into a STAGING directory, then swap. ──────────────────────────
  #
  # fabric-ca-client ADDS a key to keystore/ on every enrolment; it never
  # removes the old ones. Re-running this script three times leaves four keys
  # beside one certificate, and any client that picks "the first file in
  # keystore" then signs with a key the certificate does not match. The peer
  # rejects it as
  #
  #     access denied: channel [commitment] creator org [BankAMSP]
  #
  # which looks exactly like a revoked identity and is not one. Staging keeps
  # the invariant that matters: one key, one certificate.
  local stage="${userHome}/.enrol"
  rm -rf "$stage"
  if ! FABRIC_CA_CLIENT_HOME="$userHome" fabric-ca-client enroll \
    -u "http://${user}:${user}pw@localhost:${caPort}" \
    --caname "$caName" \
    --enrollment.attrs "role,seniority,institution,displayName" \
    -M "$stage" >/dev/null 2>&1
  then
    rm -rf "$stage"
    # A REVOKED identity cannot re-enrol, and that is the CA working correctly.
    # officer-kamal is the standing subject of redteam/revoke.sh, so after that
    # demo has run this script would otherwise die here and take the remaining
    # identities with it. Keep the material already on disk and carry on.
    if [[ -s "${userHome}/msp/signcerts/cert.pem" ]] || compgen -G "${userHome}/msp/signcerts/*.pem" >/dev/null; then
      step "${user}@${domain}  ${C_YELLOW}revoked or unenrollable — keeping existing credentials${C_RESET}"
      return 0
    fi
    die "could not enrol ${user}, and no existing credentials to fall back on"
  fi

  # Success: replace the old MSP wholesale so exactly one key survives.
  rm -rf "${userHome}/msp"
  mv "$stage" "${userHome}/msp"

  # Fabric expects config.yaml in the MSP for NodeOU-based role resolution.
  local caCertFile
  caCertFile="$(basename "$(find "${userHome}/msp/cacerts" -name '*.pem' | head -1)")"
  cat > "${userHome}/msp/config.yaml" <<EOF
NodeOUs:
  Enable: true
  ClientOUIdentifier:
    Certificate: cacerts/${caCertFile}
    OrganizationalUnitIdentifier: client
  PeerOUIdentifier:
    Certificate: cacerts/${caCertFile}
    OrganizationalUnitIdentifier: peer
  AdminOUIdentifier:
    Certificate: cacerts/${caCertFile}
    OrganizationalUnitIdentifier: admin
  OrdererOUIdentifier:
    Certificate: cacerts/${caCertFile}
    OrganizationalUnitIdentifier: orderer
EOF

  step "${user}@${domain}  role=${role} seniority=${seniority}"
}

# ---------------------------------------------------------------------------
say "Enrolling CA administrators"
for org in "${!ORG[@]}"; do
  enrolCaAdmin "$org"
done
ok "four CA admins"

say "Registering and enrolling ${#USERS[@]} identities with role attributes"
for entry in "${USERS[@]}"; do
  IFS='|' read -r org user role seniority display <<<"$entry"
  registerAndEnrol "$org" "$user" "$role" "$seniority" "$display"
done

printf "\n"
ok "${#USERS[@]} identities enrolled — each with its own key, none shared"
step "wallet: network/organizations/peerOrganizations/<domain>/users/<user>@<domain>/msp"
step "verify an attribute landed in the certificate:"
step "  openssl x509 -in .../users/officer-rahim@banka.verity.bd/msp/signcerts/cert.pem -noout -text | grep -A2 1.2.3.4.5.6.7.8.1"
