require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const auth = require('./auth');
const certs = require('./certs');
const admin = require('./admin');
const auditLogger = require('./auditLogger');
const downtimeConfig = require('./downtimeConfig');
const {
    startMqttClient,
    getLatestMachineData,
    getMachineHistory,
    clearMachineHistory,
    subscribeTopic,
    unsubscribeTopic,
    retargetTopic,
    HISTORY_LIMIT,
    getConnectionStatus,
} = require('./mqtt-machine');
const { startProductionTracker } = require('./productionTracker');
const dbClient = new Client({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
});
const VPN_STATUS_LOG = process.env.VPN_STATUS_LOG || '/etc/openvpn/server/openvpn-status.log';
const VPN_STATUS_LOG_TCP = process.env.VPN_STATUS_LOG_TCP || '/etc/openvpn/server/openvpn-status-tcp.log';
// Simple shared secret so random people on the internet can't post fake SAP reports.
// Set SAP_REPORT_TOKEN in .env and give the same value to the laptop script.
const SAP_REPORT_TOKEN = process.env.SAP_REPORT_TOKEN || 'change-me';
let dbAvailable = false;
let lastSapReport = null; // in-memory store, resets on restart
function connectToDatabase() {
    dbClient.connect()
        .then(() => {
            dbAvailable = true;
            console.log('Successfully connected to the PostgreSQL database!');
            return dbClient.query(`
                CREATE TABLE IF NOT EXISTS production_logs (
                    id SERIAL PRIMARY KEY,
                    machine_id VARCHAR(50),
                    status VARCHAR(20),
                    rpm INT,
                    temperature NUMERIC,
                    vibration NUMERIC,
                    logged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);
        })
        .then(() => {
            // Production tracker intentionally PAUSED for now — holding
            // off on continuous DB writes until we've watched actual
            // storage growth and tuned the logic with a clear head.
            // Re-enable by uncommenting the line below.
            // startProductionTracker(dbClient, 'venus');
            console.log('Production tracker is paused (not writing data) — uncomment in server.js to re-enable.');
        })
        .catch(err => {
            console.warn('Database not available, continuing without DB logging:', err.message);
        });
}
connectToDatabase();
// Intentionally NOT chained after DB connect succeeds — MQTT must keep
// working even if Postgres is ever down (it did before DB existed at
// all). The topic-loading step inside startMqttClient already handles
// a not-yet-connected dbClient gracefully via try/catch, logging a
// warning rather than crashing. Worst case if DB is genuinely down:
// MQTT still connects to AWS fine, just has no topics to subscribe to
// until DB comes back and the service restarts.
startMqttClient(dbClient);
function parseVpnStatus(logPath) {
    return new Promise((resolve, reject) => {
        fs.readFile(logPath, 'utf8', (err, data) => {
            if (err) return reject(err);
            const lines = data.split('\n');
            const clients = [];
            for (const line of lines) {
                if (!line.startsWith('CLIENT_LIST,')) continue;
                const parts = line.split(',');
                const [, commonName, realAddress, virtualAddress, , bytesReceived,
                    bytesSent, connectedSince] = parts;
                if (commonName === 'UNDEF') continue;
                clients.push({
                    name: commonName,
                    realAddress,
                    vpnIp: virtualAddress || null,
                    connectedSince,
                    bytesReceived: Number(bytesReceived),
                    bytesSent: Number(bytesSent),
                });
            }
            resolve(clients);
        });
    });
}
// Oracle runs two separate OpenVPN instances (UDP for gateways, TCP for
// laptops/mesh access) — each keeps its own status log. This merges
// both so no client is invisible just because it's on the "other" one.
async function parseAllVpnStatus() {
    const results = await Promise.allSettled([
        parseVpnStatus(VPN_STATUS_LOG),
        parseVpnStatus(VPN_STATUS_LOG_TCP),
    ]);
    let clients = [];
    for (const r of results) {
        if (r.status === 'fulfilled') clients = clients.concat(r.value);
        else console.warn('Could not read a VPN status log:', r.reason.message);
    }
    return clients;
}
const CCD_DIRS = [
    process.env.CCD_DIR || '/etc/openvpn/server/ccd',
    process.env.CCD_TCP_DIR || '/etc/openvpn/server/ccd-tcp',
];
// Reads Oracle's OpenVPN client-config-dir folders — this is the
// authoritative "every gateway ever provisioned" list, independent of
// who's currently connected. New gateways show up here automatically
// the moment their cert/ccd entry is created, no code changes needed.
function getKnownGateways() {
    const names = new Set();
    for (const dir of CCD_DIRS) {
        try {
            const files = fs.readdirSync(dir);
            for (const f of files) {
                if (f.startsWith('.')) continue;
                names.add(f);
            }
        } catch (err) {
            console.warn(`Could not read ccd dir ${dir}:`, err.message);
        }
    }
    return Array.from(names);
}
// Reads the raw body of a POST request and parses it as JSON.
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (err) {
                reject(err);
            }
        });
        req.on('error', reject);
    });
}
const server = http.createServer(async (req, res) => {
    // ---- health check (no auth) ----------------------------------------
    // Used by deploy tooling to confirm the service is actually working,
    // not just that the process is running.
    if (req.url === '/health' && req.method === 'GET') {
        const checks = { database: false, mqtt: false };

        if (!dbAvailable) {
            checks.databaseError = 'not connected';
        } else {
            try {
                await Promise.race([
                    dbClient.query('SELECT 1'),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('timeout after 2s')), 2000)
                    ),
                ]);
                checks.database = true;
            } catch (err) {
                checks.databaseError = err.message;
            }
        }

        const mqttStatus = getConnectionStatus();
        checks.mqtt = mqttStatus.connected;

        const healthy = checks.database && checks.mqtt;
        res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            status: healthy ? 'ok' : 'degraded',
            uptime_s: Math.floor(process.uptime()),
            checks,
        }));
    }
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

    if (req.url === '/api/certs/gateways' && req.method === 'GET') {
        return certs.handleGateways(req, res);
    }

    // ---- admin routes (is_admin re-checked per request) ---------------
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
    if (req.url === '/api/machine-status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const machineStatus = {
            machineId: "Straightener_D120",
            status: "Running",
            rpm: Math.floor(Math.random() * (1460 - 1440 + 1)) + 1440,
            temperature: 68.5,
            vibration: 2.4
        };
        if (dbAvailable) {
            try {
                await dbClient.query(
                    'INSERT INTO production_logs (machine_id, status, rpm, temperature, vibration) VALUES ($1, $2, $3, $4, $5)',
                    [machineStatus.machineId, machineStatus.status, machineStatus.rpm, machineStatus.temperature, machineStatus.vibration]
                );
                console.log("Logged a new reading to the database!");
            } catch (err) {
                console.error("Could not write to DB:", err.message);
            }
        }
        return res.end(JSON.stringify({ ...machineStatus, timestamp: new Date() }));
    }
    if (req.url === '/api/vpn/sites') {
        try {
            const liveClients = await parseAllVpnStatus();
            const liveByName = {};
            liveClients.forEach(c => { liveByName[c.name] = c; });

            const knownGateways = getKnownGateways();
            const allNames = Array.from(new Set([...knownGateways, ...liveClients.map(c => c.name)]));

            const sites = allNames.map(name => {
                const live = liveByName[name];
                return {
                    name,
                    online: !!live,
                    realAddress: live?.realAddress || null,
                    vpnIp: live?.vpnIp || null,
                    connectedSince: live?.connectedSince || null,
                    bytesReceived: live?.bytesReceived ?? 0,
                    bytesSent: live?.bytesSent ?? 0,
                };
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                connectedCount: liveClients.length,
                totalKnown: allNames.length,
                sites,
                checkedAt: new Date(),
            }));
        } catch (err) {
            console.error('Could not read VPN status log:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Could not read VPN status log', detail: err.message }));
        }
    }
    // Laptop script POSTs its SAP sync status here periodically.
    if (req.url === '/api/sap/report' && req.method === 'POST') {
        try {
            const body = await readJsonBody(req);
            if (body.token !== SAP_REPORT_TOKEN) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Invalid token' }));
            }
            lastSapReport = {
                pendingCount: body.pendingCount ?? null,
                errorCount: body.errorCount ?? null,
                lastFileProcessed: body.lastFileProcessed ?? null,
                reportedAt: new Date(),
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ received: true }));
        } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        }
    }
    // Dashboard reads/edits the machine-topic registry here — no
    // redeploy needed to add a new gateway, matches the same
    // philosophy as the auto-detecting VPN Fleet.
    if (req.url === '/api/machine-topics' && req.method === 'GET') {
        try {
            const result = await dbClient.query(
                'SELECT id, machine_id, display_name, mqtt_topic, vpn_gateway_name FROM machine_topics ORDER BY display_name'
            );
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ machines: result.rows }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'DB query failed', detail: err.message }));
        }
    }
    if (req.url === '/api/machine-topics' && req.method === 'POST') {
        try {
            const body = await readJsonBody(req);
            const { display_name, mqtt_topic, vpn_gateway_name } = body;
            if (!display_name || !mqtt_topic) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'display_name and mqtt_topic are required' }));
            }

            // machine_id is auto-generated, never typed by hand — removes
            // the whole "same id can't be used" problem entirely. Slug of
            // the display name plus a short random suffix; retried on the
            // astronomically unlikely chance of a collision.
            const slug = display_name.toLowerCase().trim()
                .replace(/[^a-z0-9]+/g, '_')
                .replace(/^_+|_+$/g, '')
                .slice(0, 40) || 'machine';

            let machineId;
            let inserted = false;
            let lastErr = null;
            for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
                const suffix = Math.random().toString(36).slice(2, 6); // 4 random chars
                machineId = `${slug}_${suffix}`;
                try {
                    await dbClient.query(
                        `INSERT INTO machine_topics (machine_id, display_name, mqtt_topic, vpn_gateway_name)
                         VALUES ($1, $2, $3, $4)`,
                        [machineId, display_name, mqtt_topic, vpn_gateway_name || null]
                    );
                    inserted = true;
                } catch (err) {
                    lastErr = err;
                    // machine_id collision (vanishingly rare) -> retry with a new suffix.
                    // mqtt_topic collision -> that topic's already tracked, stop and say so clearly.
                    if (err.constraint && err.constraint.includes('mqtt_topic')) {
                        res.writeHead(409, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ error: 'That MQTT topic is already being tracked under a different machine.' }));
                    }
                    // otherwise (machine_id collision) fall through and retry
                }
            }
            if (!inserted) {
                throw lastErr || new Error('Could not generate a unique machine_id after 5 attempts');
            }

            subscribeTopic(mqtt_topic, machineId); // live, no restart needed
            res.writeHead(201, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ added: true, machine_id: machineId }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Could not add machine', detail: err.message }));
        }
    }
    // Edit an existing entry. The DB update is the easy half -- the part
    // that matters is that changing mqtt_topic must also move the live
    // MQTT subscription, otherwise we'd keep receiving the OLD topic
    // until the next service restart. machine_id is deliberately NOT
    // editable: it's auto-generated and the caches key off it.
    if (req.url.startsWith('/api/machine-topics/') && req.method === 'PUT') {
        try {
            const machineId = decodeURIComponent(req.url.split('/api/machine-topics/')[1].split('?')[0]);
            const body = await readJsonBody(req);
            const displayName = (body.display_name || '').trim();
            const mqttTopic = (body.mqtt_topic || '').trim();
            const vpnGatewayName = body.vpn_gateway_name === undefined
                ? undefined
                : (body.vpn_gateway_name || null);

            if (!displayName || !mqttTopic) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'display_name and mqtt_topic are required' }));
            }

            const existing = await dbClient.query(
                'SELECT mqtt_topic, vpn_gateway_name FROM machine_topics WHERE machine_id = $1',
                [machineId]
            );
            if (!existing.rows[0]) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'No machine with that id' }));
            }
            const oldTopic = existing.rows[0].mqtt_topic;
            const newGateway = vpnGatewayName === undefined
                ? existing.rows[0].vpn_gateway_name
                : vpnGatewayName;

            try {
                await dbClient.query(
                    `UPDATE machine_topics
                     SET display_name = $1, mqtt_topic = $2, vpn_gateway_name = $3
                     WHERE machine_id = $4`,
                    [displayName, mqttTopic, newGateway, machineId]
                );
            } catch (err) {
                if (err.constraint && err.constraint.includes('mqtt_topic')) {
                    res.writeHead(409, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'That MQTT topic is already being tracked under a different machine.' }));
                }
                throw err;
            }

            // Only touch MQTT if the topic actually changed -- a pure
            // rename must not interrupt a live feed.
            if (oldTopic !== mqttTopic) {
                retargetTopic(machineId, oldTopic, mqttTopic); // live, no restart needed
                clearMachineHistory(machineId); // old buffer belongs to a different feed
                console.log(`Topic for ${machineId} changed: ${oldTopic} -> ${mqttTopic}`);
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                updated: true,
                machine_id: machineId,
                topic_changed: oldTopic !== mqttTopic,
            }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Could not update machine', detail: err.message }));
        }
    }
    // Rolling in-memory history (last N messages) for one machine --
    // MQTTX-style: newest first, each with its own arrival timestamp.
    // Reads from RAM only, never the DB.
    if (req.url.startsWith('/api/machine-history/') && req.method === 'GET') {
        const machineId = decodeURIComponent(req.url.split('/api/machine-history/')[1].split('?')[0]);
        const history = getMachineHistory(machineId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            machineId,
            limit: HISTORY_LIMIT,
            count: history.length,
            messages: history,
        }));
    }
    if (req.url.startsWith('/api/machine-topics/') && req.method === 'DELETE') {
        try {
            const machineId = decodeURIComponent(req.url.split('/api/machine-topics/')[1]);
            const result = await dbClient.query(
                'DELETE FROM machine_topics WHERE machine_id = $1 RETURNING mqtt_topic',
                [machineId]
            );
            if (result.rows[0]) {
                unsubscribeTopic(result.rows[0].mqtt_topic); // live, no restart needed
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ deleted: result.rowCount > 0 }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Could not delete machine', detail: err.message }));
        }
    }
    if (req.url === '/api/sap/sync-status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (!lastSapReport) {
            return res.end(JSON.stringify({ status: 'no_reports_yet' }));
        }
        return res.end(JSON.stringify(lastSapReport));
    }
    if (req.url === '/api/machine-status/demo') {
        // Alias kept for backward compatibility with the current
        // frontend, which still hardcodes this path for Venus.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(getLatestMachineData('venus1')));
    }
    if (req.url.startsWith('/api/machine-status/') && req.url !== '/api/machine-status/demo') {
        const machineId = decodeURIComponent(req.url.split('/api/machine-status/')[1].split('?')[0]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(getLatestMachineData(machineId)));
    }
    if (req.url.startsWith('/api/production/current')) {
        try {
            const urlObj = new URL(req.url, 'http://localhost');
            const machineId = urlObj.searchParams.get('machineId') || 'venus';
            const statusRes = await dbClient.query(
                `SELECT status, started_at FROM machine_status_events
                 WHERE machine_id = $1 AND ended_at IS NULL
                 ORDER BY started_at DESC LIMIT 1`,
                [machineId]
            );
            const batchRes = await dbClient.query(
                `SELECT bar_diameter, bar_count, started_at FROM production_batches
                 WHERE machine_id = $1 AND ended_at IS NULL
                 ORDER BY started_at DESC LIMIT 1`,
                [machineId]
            );
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                currentStatus: statusRes.rows[0] || null,
                currentBatch: batchRes.rows[0] || null,
            }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'DB query failed', detail: err.message }));
        }
    }
    if (req.url.startsWith('/api/production/history')) {
        try {
            const urlObj = new URL(req.url, 'http://localhost');
            const machineId = urlObj.searchParams.get('machineId') || 'venus';
            const hours = Number(urlObj.searchParams.get('hours')) || 24;
            const statusEvents = await dbClient.query(
                `SELECT status, started_at, ended_at, duration_seconds FROM machine_status_events
                 WHERE machine_id = $1 AND started_at > NOW() - ($2 || ' hours')::interval
                 ORDER BY started_at ASC`,
                [machineId, hours]
            );
            const batches = await dbClient.query(
                `SELECT bar_diameter, bar_count, started_at, ended_at FROM production_batches
                 WHERE machine_id = $1 AND started_at > NOW() - ($2 || ' hours')::interval
                 ORDER BY started_at ASC`,
                [machineId, hours]
            );
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                statusEvents: statusEvents.rows,
                batches: batches.rows,
            }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'DB query failed', detail: err.message }));
        }
    }
    if (req.url === '/' || req.url === '/index.html') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, content) => {
            if (err) { res.writeHead(500); return res.end('Error loading index.html'); }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(content);
        });
    }
});
server.listen(3000, () => {
    console.log('Full-Stack Database engine live on port 3000!');
});
