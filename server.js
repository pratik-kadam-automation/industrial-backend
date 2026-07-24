require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { startMqttClient, getLatestMachineData } = require('./mqtt-machine');
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
startMqttClient();
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
    // Dashboard reads the latest SAP status here.
    if (req.url === '/api/sap/sync-status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (!lastSapReport) {
            return res.end(JSON.stringify({ status: 'no_reports_yet' }));
        }
        return res.end(JSON.stringify(lastSapReport));
    }
    if (req.url === '/api/machine-status/demo') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(getLatestMachineData()));
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
