#!/usr/bin/env bash
#
# patch-cert-routes.sh — add the certificate portal routes to server.js.
#
# Same approach as patch-auth-routes.sh: back up, insert, verify, revert
# on failure. Run from the repo root on the Oracle box.
#
set -euo pipefail

FILE="${1:-server.js}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="${FILE}.bak-certs-${STAMP}"

[[ -f "$FILE" ]] || { echo "ERROR: $FILE not found. Run from the repo root." >&2; exit 1; }

if grep -q "/api/certs/generate" "$FILE"; then
    echo "Cert routes already present — nothing to do."
    exit 0
fi

ANCHOR="if (req.url === '/api/whoami') {"
if ! grep -qF "$ANCHOR" "$FILE"; then
    echo "ERROR: auth routes not found. Run patch-auth-routes.sh first." >&2
    exit 1
fi

cp "$FILE" "$BACKUP"
echo "→ backup : $BACKUP"

if ! grep -q "require('./certs')" "$FILE"; then
    sed -i "s|^const auth = require('./auth');|const auth = require('./auth');\nconst certs = require('./certs');|" "$FILE"
    echo "→ added  : const certs = require('./certs');"
fi

# Insert after the whoami block closes. Anchoring on the change-password
# route instead would be fragile if it is ever reordered, so we anchor on
# whoami and insert before it -- order among these four does not matter
# since each matches a distinct exact path.
BLOCK="$(mktemp)"
cat > "$BLOCK" <<'ROUTES'
    // ---- certificate portal (session required) -----------------------
    // The dashboard at / stays open; only these routes and /certs check
    // for a session. Guarding happens inside certs.js via requireAuth so
    // a missed check here cannot silently expose them.
    if (req.url === '/api/certs/generate' && req.method === 'POST') {
        try {
            return await certs.handleGenerate(req, res, dbClient, await readJsonBody(req));
        } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Bad request body.' }));
        }
    }

    if (req.url === '/api/certs/list' && req.method === 'GET') {
        return await certs.handleList(req, res, dbClient);
    }

    if (req.url.startsWith('/api/certs/download/') && req.method === 'GET') {
        return certs.handleDownload(req, res, req.url.split('?')[0]);
    }

    if (req.url === '/certs' || req.url === '/certs.html') {
        return fs.readFile(path.join(__dirname, 'certs.html'), (err, content) => {
            if (err) { res.writeHead(500); return res.end('Error loading certs.html'); }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(content);
        });
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
echo "→ inserted: 4 cert routes"

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
echo "  sudo systemctl restart industrial-backend"
echo "  open http://10.8.0.1:3000/certs"
echo
echo "Revert with:  cp $BACKUP $FILE"
