#!/usr/bin/env bash
#
# patch-admin-routes.sh — add gateway-browser and admin routes to server.js.
#
set -euo pipefail

FILE="${1:-server.js}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="${FILE}.bak-admin-${STAMP}"

[[ -f "$FILE" ]] || { echo "ERROR: $FILE not found. Run from the repo root." >&2; exit 1; }

if grep -q "/api/admin/users" "$FILE"; then
    echo "Admin routes already present — nothing to do."
    exit 0
fi

ANCHOR="if (req.url === '/api/certs/list' && req.method === 'GET') {"
if ! grep -qF "$ANCHOR" "$FILE"; then
    echo "ERROR: cert routes not found. Run patch-cert-routes.sh first." >&2
    exit 1
fi

cp "$FILE" "$BACKUP"
echo "→ backup : $BACKUP"

if ! grep -q "require('./admin')" "$FILE"; then
    sed -i "s|^const certs = require('./certs');|const certs = require('./certs');\nconst admin = require('./admin');|" "$FILE"
    echo "→ added  : const admin = require('./admin');"
fi

BLOCK="$(mktemp)"
cat > "$BLOCK" <<'ROUTES'
    if (req.url === '/api/certs/gateways' && req.method === 'GET') {
        return certs.handleGateways(req, res);
    }

    // ---- admin routes (is_admin re-checked per request) ---------------
    if (req.url === '/api/admin/users' && req.method === 'GET') {
        return await admin.handleUsers(req, res, dbClient);
    }

    if (req.url === '/api/admin/reset-password' && req.method === 'POST') {
        try {
            return await admin.handleResetPassword(req, res, dbClient, await readJsonBody(req));
        } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Bad request body.' }));
        }
    }

    if (req.url === '/api/admin/set-active' && req.method === 'POST') {
        try {
            return await admin.handleSetActive(req, res, dbClient, await readJsonBody(req));
        } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Bad request body.' }));
        }
    }

    if (req.url === '/api/admin/set-admin' && req.method === 'POST') {
        try {
            return await admin.handleSetAdmin(req, res, dbClient, await readJsonBody(req));
        } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Bad request body.' }));
        }
    }

    if (req.url === '/api/admin/add-user' && req.method === 'POST') {
        try {
            return await admin.handleAddUser(req, res, dbClient, await readJsonBody(req));
        } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Bad request body.' }));
        }
    }

ROUTES

awk -v anchor="$ANCHOR" -v blockfile="$BLOCK" '
    index($0, anchor) && !done {
        while ((getline line < blockfile) > 0) print line
        close(blockfile)
        done = 1
    }
    { print }
' "$FILE" > "${FILE}.new"

mv "${FILE}.new" "$FILE"
rm -f "$BLOCK"
echo "→ inserted: 6 routes"

if node --check "$FILE" 2>/dev/null; then
    echo "→ syntax : OK"
else
    echo "ERROR: patched file does not parse — reverting." >&2
    node --check "$FILE" || true
    cp "$BACKUP" "$FILE"
    exit 1
fi

echo
echo "Patched. Next:"
echo "  node scripts/manage-users.js admin pratik"
echo "  sudo systemctl restart industrial-backend"
echo
echo "Revert with:  cp $BACKUP $FILE"
