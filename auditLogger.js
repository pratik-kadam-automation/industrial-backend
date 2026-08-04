/*
 * auditLogger.js — a general event log: logins, password resets,
 * downtime config changes, anything worth being able to answer "who did
 * that and when" about later.
 *
 * Takes the shared dbClient rather than opening its own pg.Pool. The
 * original draft of this file created a second connection pool, which
 * on a 1 GB box with a documented OOM history is exactly the kind of
 * thing that causes an outage weeks later for a reason that takes an
 * hour to trace back here. One connection, reused everywhere, same as
 * auth.js, certs.js, and admin.js.
 */

let tableReady = false;

async function ensureAuditTable(dbClient) {
    if (tableReady) return;
    await dbClient.query(`
        CREATE TABLE IF NOT EXISTS audit_logs (
            id          SERIAL PRIMARY KEY,
            actor_id    VARCHAR(50)  NOT NULL,
            actor_ip    VARCHAR(45),
            action      VARCHAR(100) NOT NULL,
            target_type VARCHAR(50),
            target_id   VARCHAR(100),
            details     JSONB,
            status      VARCHAR(20)  NOT NULL DEFAULT 'SUCCESS',
            "timestamp" TIMESTAMP    NOT NULL DEFAULT now()
        )
    `);
    tableReady = true;
}

/**
 * Records one event. Failures are logged and swallowed rather than
 * thrown -- a broken audit write should never be the reason a real
 * action (like saving a downtime config) fails outright.
 */
async function logAuditEvent(dbClient, {
    actorId, actorIp, action, targetType, targetId, details = {}, status = 'SUCCESS',
}) {
    try {
        await ensureAuditTable(dbClient);
        const q = await dbClient.query(
            `INSERT INTO audit_logs
                (actor_id, actor_ip, action, target_type, target_id, details, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, "timestamp"`,
            [
                actorId || 'system',
                actorIp || null,
                action,
                targetType || null,
                targetId || null,
                JSON.stringify(details || {}),
                status,
            ]
        );
        return q.rows[0];
    } catch (err) {
        console.error('audit log write failed:', err.message);
        return null;
    }
}

/** GET /api/admin/audit-log?limit=50 — recent events, newest first. */
async function handleList(req, res, dbClient, auth) {
    const admin = await auth.requireAdmin(req, res, dbClient);
    if (!admin) return;

    await ensureAuditTable(dbClient);

    const url = new URL(req.url, 'http://localhost');
    let limit = parseInt(url.searchParams.get('limit'), 10);
    if (!Number.isFinite(limit) || limit < 1) limit = 50;
    limit = Math.min(limit, 200);

    try {
        const q = await dbClient.query(
            `SELECT id, actor_id, actor_ip, action, target_type, target_id,
                    details, status, "timestamp"
               FROM audit_logs
              ORDER BY "timestamp" DESC
              LIMIT $1`,
            [limit]
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ events: q.rows }));
    } catch (err) {
        console.error('audit list error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Could not read audit log.' }));
    }
}

module.exports = { ensureAuditTable, logAuditEvent, handleList };
