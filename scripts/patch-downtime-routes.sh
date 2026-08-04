#!/usr/bin/env bash
#
# patch-downtime-routes.sh — add audit-log and downtime-config routes.
#
# Run from the repo root on the Oracle box, after server.js has been
# reset to the last known-good commit (git checkout -- server.js) if an
# earlier hand-edit was abandoned.
#
set -euo pipefail

FILE="${1:-server.js}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="${FILE}.bak-downtime-${STAMP}"

[[ -f "$FILE" ]] || { echo "ERROR: $FILE not found. Run from the repo root." >&2; exit 1; }

if grep -q "/api/admin/downtime-config" "$FILE"; then
    echo "Downtime routes already present — nothing to do."
    exit 0
fi

ANCHOR="if (req.url === '/api/admin/users' && req.method === 'GET') {"
if ! grep -qF "$ANCHOR" "$FILE"; then
    echo "ERROR: admin routes not found. Run patch-admin-routes.sh first." >&2
    exit 1
fi

for dep in auditLogger.js downtimeConfig.js; do
    [[ -f "$dep" ]] || { echo "ERROR: $dep not found in repo root." >&2; exit 1; }
done

cp "$FILE" "$BACKUP"
echo "→ backup : $BACKUP"

if ! grep -q "require('./auditLogger')" "$FILE"; then
    sed -i "s|^const admin = require('./admin');|const admin = require('./admin');\nconst auditLogger = require('./auditLogger');\nconst downtimeConfig = require('./downtimeConfig');|" "$FILE"
    echo "→ added  : auditLogger + downtimeConfig requires"
fi

BLOCK="$(mktemp)"
cat > "$BLOCK" <<'ROUTES'
    // ---- audit log (admin only) ---------------------------------------
    if (req.url.startsWith('/api/admin/audit-log') && req.method === 'GET') {
        return await auditLogger.handleList(req, res, dbClient, auth);
    }

    // ---- downtime tag configuration ------------------------------------
    // Save is admin-only (changes fleet-wide behavior); reads are open to
    // any signed-in user since the Downtimes tab needs them to render.
    if (req.url === '/api/admin/downtime-config' && req.method === 'POST') {
        try {
            return await downtimeConfig.handleSave(req, res, dbClient, await readJsonBody(req), auth);
        } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Bad request body.' }));
        }
    }

    if (req.url === '/api/admin/downtime-config' && req.method === 'GET') {
        return await downtimeConfig.handleList(req, res, dbClient, auth);
    }

    if (req.url.startsWith('/api/admin/downtime-config/') && req.method === 'GET') {
        const gwId = decodeURIComponent(req.url.split('/api/admin/downtime-config/')[1].split('?')[0]);
        return await downtimeConfig.handleGet(req, res, dbClient, gwId, auth);
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
echo "→ inserted: 4 routes"

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
echo "  curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/admin/downtime-config   # expect 401"
echo
echo "Revert with:  cp $BACKUP $FILE"
