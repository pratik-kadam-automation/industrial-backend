// mqtt-machine.js
//
// Connects to AWS IoT Core over MQTT (mTLS) and keeps the latest message
// from a machine data topic cached in memory. industrial-backend's HTTP
// endpoints read from this cache -- they never block waiting on MQTT.

const fs = require('fs');
const mqtt = require('mqtt');

let latestMachineData = null;
let mqttConnected = false;
let lastMessageAt = null;

function startMqttClient() {
    const {
        MQTT_ENDPOINT,
        MQTT_PORT,
        MQTT_TOPIC,
        MQTT_CA_PATH,
        MQTT_CERT_PATH,
        MQTT_KEY_PATH,
        MQTT_CLIENT_ID,
    } = process.env;

    if (!MQTT_ENDPOINT || !MQTT_TOPIC || !MQTT_CA_PATH || !MQTT_CERT_PATH || !MQTT_KEY_PATH) {
        console.warn('MQTT config incomplete in .env -- skipping MQTT connection.');
        return;
    }

    const options = {
        host: MQTT_ENDPOINT,
        port: Number(MQTT_PORT) || 8883,
        protocol: 'mqtts',
        ca: fs.readFileSync(MQTT_CA_PATH),
        cert: fs.readFileSync(MQTT_CERT_PATH),
        key: fs.readFileSync(MQTT_KEY_PATH),
        clientId: MQTT_CLIENT_ID || `industrial-backend-${Date.now()}`,
        reconnectPeriod: 5000, // ms between reconnect attempts
    };

    const client = mqtt.connect(options);

    client.on('connect', () => {
        mqttConnected = true;
        console.log(`MQTT connected to ${MQTT_ENDPOINT}, subscribing to ${MQTT_TOPIC}`);
        client.subscribe(MQTT_TOPIC, (err) => {
            if (err) console.error('MQTT subscribe error:', err.message);
        });
    });

    client.on('message', (topic, payload) => {
        try {
            const parsed = JSON.parse(payload.toString());
            // Real gateway payloads arrive wrapped in an envelope:
            // { deployment_id, gateway_id, ts, data: { ...actual metrics } }
            // The demo topic sends flat JSON with no envelope. Handle both.
            const hasEnvelope = parsed && typeof parsed === 'object' && parsed.data && typeof parsed.data === 'object';
            latestMachineData = {
                topic,
                deploymentId: hasEnvelope ? (parsed.deployment_id ?? null) : null,
                gatewayId: hasEnvelope ? (parsed.gateway_id ?? null) : null,
                machineTs: hasEnvelope ? (parsed.ts ?? null) : null,
                data: hasEnvelope ? parsed.data : parsed,
                receivedAt: new Date(),
            };
            lastMessageAt = new Date();
        } catch (err) {
            console.error('MQTT message was not valid JSON:', err.message);
        }
    });

    client.on('error', (err) => {
        console.error('MQTT connection error:', err.message);
    });

    client.on('close', () => {
        mqttConnected = false;
    });
}

function getLatestMachineData() {
    return {
        connected: mqttConnected,
        lastMessageAt,
        ...(latestMachineData || {}),
    };
}

module.exports = { startMqttClient, getLatestMachineData };
