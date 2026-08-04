/*
 * downtimeConfig.js — per-gateway mapping from an MQTT tag/value to
 * running / idle / breakdown state, for the Downtimes tab.
 *
 * Two changes from the original draft:
 *   1. Every route is guarded (requireAuth to read, requireAdmin to
 *      write) -- the draft had no guard at all on a path under
 *      /api/admin/, which would have let anyone on the VPN change how
 *      downtime is calculated for any gateway.
 *   2. Uses the shared dbClient instead of pulling in a second
 *      connection pool via auditLogger's old standalone Pool.
 */

const auditLogger = require('./auditLogger');

let tableReady = false;

async function ensureTable(dbClient) {
    if (tableReady) return;
    await dbClient.query(`
        CREATE TABLE IF NOT EXISTS gateway_downtime_configs (
            gateway_id      VARCHAR(100) PRIMARY KEY,
            mqtt_topic      VARCHAR(255) NOT NULL,
            tag_key         VARCHAR(100) NOT NULL,
            breakdown_value VARCHAR(50)  NOT NULL DEFAULT '2',
            downtime_value  VARCHAR(50)  NOT NULL DEFAULT '0',
            running_value   VARCHAR(50)  NOT NULL DEFAULT '1',
            updated_at      TIMESTAMP    NOT NULL DEFAULT now(),
            updated_by      VARCHAR(50)
        )
    `);
    tableReady = true;
}

/** POST /api/admin/downtime-config — admin only, this changes fleet-wide behavior. */
async function handleSave(req, res, dbClient, body, auth) {
    const admin = await auth.requireAdmin(req, res, dbClient);
    if (!admin) return;

    await ensureTable(dbClient);

    const { gatewayId, mqttTopic, tagKey, breakdownValue, downtimeValue, runningValue } = body || {};
    if (!gatewayId || !mqttTopic || !tagKey) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            error: 'Missing required fields: gatewayId, mqttTopic, tagKey',
        }));
    }

    try {
        await dbClient.query(
            `INSERT INTO gateway_downtime_configs
                (gateway_id, mqtt_topic, tag_key, breakdown_value, downtime_value, running_value, updated_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (gateway_id) DO UPDATE SET
                mqtt_topic      = EXCLUDED.mqtt_topic,
                tag_key         = EXCLUDED.tag_key,
                breakdown_value = EXCLUDED.breakdown_value,
                downtime_value  = EXCLUDED.downtime_value,
                running_value   = EXCLUDED.running_value,
                updated_at      = now(),
                updated_by      = EXCLUDED.updated_by`,
            [
                gatewayId, mqttTopic, tagKey,
                String(breakdownValue ?? '2'),
                String(downtimeValue ?? '0'),
                String(runningValue ?? '1'),
                admin.username,
            ]
        );

        await auditLogger.logAuditEvent(dbClient, {
            actorId: admin.username,
            actorIp: req.socket.remoteAddress,
            action: 'CONFIGURE_DOWNTIME_TAGS',
            targetType: 'gateway',
            targetId: gatewayId,
            details: { mqttTopic, tagKey, breakdownValue, downtimeValue, runningValue },
        });

        console.log(`downtime config saved: ${gatewayId} by ${admin.username}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: `Configuration saved for ${gatewayId}` }));
    } catch (err) {
        console.error('downtime config save error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Could not save configuration.' }));
    }
}

/**
 * GET /api/admin/downtime-config/<gatewayId> — any signed-in user can
 * read the current mapping (needed to render the Downtimes tab); only
 * admins can change it.
 */
async function handleGet(req, res, dbClient, gatewayId, auth) {
    const user = auth.requireAuth(req, res);
    if (!user) return;

    await ensureTable(dbClient);

    try {
        const q = await dbClient.query(
            'SELECT * FROM gateway_downtime_configs WHERE gateway_id = $1',
            [gatewayId]
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(q.rows[0] || {}));
    } catch (err) {
        console.error('downtime config get error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Could not read configuration.' }));
    }
}

/** GET /api/admin/downtime-config — list every configured gateway. */
async function handleList(req, res, dbClient, auth) {
    const user = auth.requireAuth(req, res);
    if (!user) return;

    await ensureTable(dbClient);

    try {
        const q = await dbClient.query(
            'SELECT * FROM gateway_downtime_configs ORDER BY gateway_id'
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ configs: q.rows }));
    } catch (err) {
        console.error('downtime config list error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Could not read configurations.' }));
    }
}

module.exports = { handleSave, handleGet, handleList };
