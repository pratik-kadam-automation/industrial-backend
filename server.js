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

function connectWithRetry() {
    console.log('Attempting to connect to PostgreSQL database...');
    dbClient.connect()
        .then(() => {
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
            console.error('Database connection failed. Retrying in 3 seconds...', err.message);
            setTimeout(connectWithRetry, 3000);
        });
}

connectWithRetry();

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
        try {
            await dbClient.query(
                'INSERT INTO production_logs (machine_id, status, rpm, temperature, vibration) VALUES ($1, $2, $3, $4, $5)',
                [machineStatus.machineId, machineStatus.status, machineStatus.rpm, machineStatus.temperature, machineStatus.vibration]
            );
            console.log("Logged a new reading to the database!");
        } catch (err) {
            console.error("Could not write to DB (maybe still connecting):", err.message);
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