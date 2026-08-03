#!/usr/bin/env bash
#
# patch-auth-routes.sh — insert the auth route block into server.js.
#
# Safer than hand-editing a 480-line file on a phone: it backs up first,
# refuses to run twice, and reverts automatically if the result does not
# parse. Run it from the repo root on the Oracle box.
#
set -euo pipefail

FILE="${1:-server.js}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="${FILE}.bak-${STAMP}"

[[ -f "$FILE" ]] || { echo "ERROR: $FILE not found. Run from the repo root." >&2; exit 1; }

# ---- idempotence -------------------------------------------------------
if grep -q "/api/whoami" "$FILE"; then
    echo "Auth routes already present in $FILE — nothing to do."
    exit 0
fi

# ---- preconditions -----------------------------------------------------
ANCHOR='const server = http.createServer(async (req, res) => {'
if ! grep -qF "$ANCHOR" "$FILE"; then
    echo "ERROR: could not find the createServer line to insert after." >&2
    echo "       Expected: $ANCHOR" >&2
    exit 1
fi

# The handlers need the pg client and the body reader; bail early with a
# clear message rather than producing a file that throws at runtime.
grep -q "const dbClient" "$FILE" || { echo "ERROR: dbClient not found." >&2; exit 1; }
grep -q "function readJsonBody" "$FILE" || { echo "ERROR: readJsonBody not found." >&2; exit 1; }

cp "$FILE" "$BACKUP"
echo "→ backup : $BACKUP"

# ---- ensure the require line exists ------------------------------------
if ! grep -q "require('./auth')" "$FILE"; then
    # Place it after the pg require so the import block stays grouped.
    sed -i "s|^const { Client } = require('pg');|const { Client } = require('pg');\nconst auth = require('./auth');|" "$FILE"
    echo "→ added  : const auth = require('./auth');"
else
    echo "→ require: already present"
fi

# ---- insert the route block -------------------------------------------
# Written to a temp file and spliced in with awk rather than sed, because
# the block contains slashes, braces and quotes that sed would mangle.
BLOCK="$(mktemp)"
cat > "$BLOCK" <<'ROUTES'

    // ---- auth routes -------------------------------------------------
    // Placed first so a session is established before anything below it
    // has a chance to run. Nothing here is protected yet — these four
    // endpoints only manage the session itself; guarding the cert portal
    // and the write endpoints comes next.
    if (req.url === '/api/login' && req.method === 'POST') {
        try {
            return await auth.handleLogin(req, res, dbClient, await readJsonBody(req));
        } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Bad request body.' }));
        }
    }

    if (req.url === '/api/logout' && req.method === 'POST') {
        return auth.handleLogout(req, res);
    }

    if (req.url === '/api/whoami') {
        return await auth.handleWhoami(req, res, dbClient);
    }

    if (req.url === '/api/change-password' && req.method === 'POST') {
        try {
            return await auth.handleChangePassword(req, res, dbClient, await readJsonBody(req));
        } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Bad request body.' }));
        }
    }
ROUTES

awk -v anchor="$ANCHOR" -v blockfile="$BLOCK" '
    { print }
    index($0, anchor) && !done {
        while ((getline line < blockfile) > 0) print line
        close(blockfile)
        done = 1
    }
' "$FILE" > "${FILE}.new"

mv "${FILE}.new" "$FILE"
rm -f "$BLOCK"
echo "→ inserted: 4 auth routes"

# ---- verify, revert on failure ----------------------------------------
if node --check "$FILE" 2>/dev/null; then
    echo "→ syntax : OK"
else
    echo "ERROR: patched file does not parse — reverting." >&2
    node --check "$FILE" || true
    cp "$BACKUP" "$FILE"
    echo "Reverted to $BACKUP" >&2
    exit 1
fi

grep -q "express" "$FILE" && { echo "WARNING: 'express' appears in $FILE" >&2; }

echo
echo "Patched. Next:"
echo "  grep -c SESSION_SECRET .env      # must be 1, else the service will not boot"
echo "  sudo systemctl restart industrial-backend"
echo "  curl -s localhost:3000/api/whoami"
echo
echo "If anything is wrong:  cp $BACKUP $FILE"
