const http = require('http');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const dbClient = new Client({
    host: 'local-db',
    port: 5432,
    user: 'pratik',
    password: 'mysecretpassword',
    database: 'factory_data',
});

// NEW: This function automatically retries if the database isn't ready
function connectWithRetry() {
    console.log('Attempting to connect to PostgreSQL database...');
    
    dbClient.connect()
        .then(() => {
            console.log('Successfully connected to the PostgreSQL database!');
            // Create table once connected
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
            // Wait 3 seconds, then call this function again
            setTimeout(connectWithRetry, 3000);
        });
}

// Start the retry connection loop
connectWithRetry();

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

        // Save reading to database if connected
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