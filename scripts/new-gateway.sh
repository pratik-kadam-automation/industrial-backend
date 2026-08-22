#!/usr/bin/env bash
#
# new-gateway.sh — provision one VPN gateway end to end.
#
# Creates the client certificate, allocates the next free static IP,
# writes the ccd/ entry, and emits a ready-to-import .ovpn bundle.
# Doing all four in one command is the point: a cert without a ccd
# entry is invisible to the fleet dashboard and lands on a random
# pool IP, which is exactly the drift this script exists to prevent.
#
#   ./new-gateway.sh --client gloster      # auto-names gloster<next>
#   ./new-gateway.sh gloster13             # explicit name
#   ./new-gateway.sh gloster13 10.8.0.71   # explicit name + IP
#   ./new-gateway.sh --ccd-only gloster10  # cert already exists
#
set -euo pipefail

# ---------------------------------------------------------------- config
EASYRSA_DIR="${EASYRSA_DIR:-/home/ubuntu/openvpn-ca}"
CCD_DIR="${CCD_DIR:-/etc/openvpn/server/ccd}"
CCD_TCP_DIR="${CCD_TCP_DIR:-/etc/openvpn/server/ccd-tcp}"
OUT_DIR="${OUT_DIR:-/home/ubuntu/gateway-configs}"

SERVER_HOST="${SERVER_HOST:-slogic-iiot.duckdns.org}"
UDP_SUBNET_GW="10.8.0.1"          # tun0 gateway, UDP/1194
UDP_POOL_START=40                 # first host octet this script hands out
UDP_POOL_END=250

# ta.key sits at the easy-rsa root here, NOT under pki/ — check with
# `ls /home/ubuntu/openvpn-ca/` if a bundle ever fails TLS handshake.
TA_KEY="${TA_KEY:-$EASYRSA_DIR/ta.key}"

# Server config uses `tls-auth ta.key 0`, so every client must use 1.
CLIENT_KEY_DIRECTION=1

# ------------------------------------------------------------------ args
CCD_ONLY=0
CLIENT_MODE=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --ccd-only) CCD_ONLY=1; shift ;;
        --client)   CLIENT_MODE=1; shift ;;
        -h|--help)
            sed -n '3,15p' "$0" | sed 's/^# \?//'
            exit 0 ;;
        *) break ;;
    esac
done

ARG1="${1:-}"
WANT_IP="${2:-}"

if [[ -z "$ARG1" ]]; then
    echo "usage: $0 [--client|--ccd-only] <name-or-prefix> [static-ip]" >&2
    exit 1
fi

# ------------------------------------------------- resolve gateway name
if [[ "$CLIENT_MODE" -eq 1 ]]; then
    PREFIX="$ARG1"
    # Find the highest existing <prefix><number> across both ccd dirs and
    # the issued-cert folder, then take the next one. Checking certs too
    # matters: a cert can exist without a ccd entry (that is the bug this
    # whole script exists to close), and reusing its name would collide.
    HIGHEST=0
    while read -r n; do
        [[ -n "$n" && "$n" -gt "$HIGHEST" ]] && HIGHEST="$n"
    done < <(
        {
            ls "$CCD_DIR" "$CCD_TCP_DIR" 2>/dev/null || true
            ls "$EASYRSA_DIR/pki/issued" 2>/dev/null | sed 's/\.crt$//' || true
        } | grep -oE "^${PREFIX}[0-9]+$" | grep -oE '[0-9]+$' | sort -n
    )
    NAME="${PREFIX}$((HIGHEST + 1))"
    echo "→ client  : $PREFIX (highest existing: ${HIGHEST:-none})"
else
    NAME="$ARG1"
fi

# The ccd/ filename must equal the certificate Common Name exactly --
# OpenVPN looks the file up by CN, so any mismatch means the client
# connects but silently gets a pool IP instead of its static one.
if [[ ! "$NAME" =~ ^[a-zA-Z0-9_-]+$ ]]; then
    echo "ERROR: '$NAME' has characters that will not survive as a CN or filename." >&2
    exit 1
fi

# --------------------------------------------------------- sanity checks
[[ -d "$EASYRSA_DIR" ]] || { echo "ERROR: easy-rsa dir not found: $EASYRSA_DIR" >&2; exit 1; }
[[ -d "$CCD_DIR"     ]] || { echo "ERROR: ccd dir not found: $CCD_DIR" >&2; exit 1; }
[[ -f "$TA_KEY"      ]] || { echo "ERROR: ta.key not found at $TA_KEY" >&2; exit 1; }

if [[ -e "$CCD_DIR/$NAME" ]]; then
    echo "ERROR: $CCD_DIR/$NAME already exists — $(cat "$CCD_DIR/$NAME")" >&2
    exit 1
fi

# --------------------------------------------------- allocate static IP
# Scan every ifconfig-push line on disk so an address is never handed out
# twice. Collisions are miserable to diagnose: two gateways fight over one
# IP and both appear to flap.
mapfile -t USED < <(
    grep -rhoE 'ifconfig-push[[:space:]]+10\.8\.0\.[0-9]+' \
        "$CCD_DIR" "$CCD_TCP_DIR" 2>/dev/null \
    | grep -oE '[0-9]+$' | sort -n
)

is_used() {
    local octet="$1"
    for u in "${USED[@]:-}"; do [[ "$u" == "$octet" ]] && return 0; done
    return 1
}

if [[ -n "$WANT_IP" ]]; then
    OCTET="${WANT_IP##*.}"
    is_used "$OCTET" && { echo "ERROR: $WANT_IP already assigned." >&2; exit 1; }
    STATIC_IP="$WANT_IP"
else
    STATIC_IP=""
    for ((o=UDP_POOL_START; o<=UDP_POOL_END; o++)); do
        if ! is_used "$o"; then STATIC_IP="10.8.0.$o"; break; fi
    done
    [[ -n "$STATIC_IP" ]] || { echo "ERROR: no free IP in pool." >&2; exit 1; }
fi

echo "→ gateway : $NAME"
echo "→ staticIP: $STATIC_IP"

# ------------------------------------------------------ build the cert
if [[ "$CCD_ONLY" -eq 0 ]]; then
    if [[ -f "$EASYRSA_DIR/pki/issued/$NAME.crt" ]]; then
        echo "→ cert    : already issued, reusing"
    else
        echo "→ cert    : building…"
        ( cd "$EASYRSA_DIR" && ./easyrsa --batch build-client-full "$NAME" nopass )
    fi
else
    [[ -f "$EASYRSA_DIR/pki/issued/$NAME.crt" ]] \
        || { echo "ERROR: --ccd-only given but no cert for $NAME" >&2; exit 1; }
    echo "→ cert    : existing (--ccd-only)"
fi

# -------------------------------------------------------- write the ccd
echo "ifconfig-push $STATIC_IP $UDP_SUBNET_GW" | sudo tee "$CCD_DIR/$NAME" >/dev/null
sudo chmod 644 "$CCD_DIR/$NAME"
echo "→ ccd     : $CCD_DIR/$NAME"

# ------------------------------------------------- emit the .ovpn bundle
# Everything inlined so the gateway needs exactly one file. The transport
# ladder (UDP/1194 -> TCP/443 -> TCP/8443) is baked in as ordered remote
# lines: OpenVPN walks them in turn, so a site behind TLS inspection falls
# through without anyone editing config on site.
mkdir -p "$OUT_DIR"
OVPN="$OUT_DIR/$NAME.ovpn"

{
    cat <<EOF
client
dev tun
resolv-retry infinite
nobind
persist-key
persist-tun
remote-cert-tls server
verb 3

remote $SERVER_HOST 1194 udp
remote $SERVER_HOST 443 tcp
remote $SERVER_HOST 8443 tcp
connect-retry 5 30

key-direction $CLIENT_KEY_DIRECTION

EOF
    echo "<ca>";       sudo cat "$EASYRSA_DIR/pki/ca.crt";            echo "</ca>"
    echo "<cert>";     sudo cat "$EASYRSA_DIR/pki/issued/$NAME.crt";  echo "</cert>"
    echo "<key>";      sudo cat "$EASYRSA_DIR/pki/private/$NAME.key"; echo "</key>"
    echo "<tls-auth>"; sudo cat "$TA_KEY";                            echo "</tls-auth>"
} > "$OVPN"

chmod 600 "$OVPN"
echo "→ bundle  : $OVPN"

echo
echo "M300 settings for this gateway:"
echo "  VPN type      : OpenVPN client"
echo "  Config file   : $NAME.ovpn (upload as-is, certs are inlined)"
echo "  Expected VPN IP: $STATIC_IP"
echo
echo "Card appears on VPN Fleet within ~8s (OFFLINE until it dials in)."
echo "No OpenVPN restart needed — ccd/ is read per connection."
