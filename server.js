require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const dbClient = new Client({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
});

const VPN_STATUS_LOG = process.env.VPN_STATUS_LOG || '/etc/openvpn/server/openvpn-status.log';

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
        .catch(err => {
            console.warn('Database not available, continuing without DB logging:', err.message);
        });
}

connectToDatabase();

function parseVpnStatus() {
    return new Promise((resolve, reject) => {
        fs.readFile(VPN_STATUS_LOG, 'utf8', (err, data) => {
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
            const clients = await parseVpnStatus();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                connectedCount: clients.length,
                sites: clients,
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
