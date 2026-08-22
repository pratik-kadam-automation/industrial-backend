// mqtt-machine.js
//
// Connects to AWS IoT Core over MQTT (mTLS, using Venus's certificate —
// reused across all subscriptions per explicit decision; a dedicated
// subscribe-only cert can replace this later without changing anything
// else here). Subscribes to every topic listed in the machine_topics DB
// table and keeps the latest message from EACH cached separately, keyed
// by machine_id. industrial-backend's HTTP endpoints read from this
// cache — they never block waiting on MQTT.
const fs = require('fs');
const mqtt = require('mqtt');

let client = null;
let mqttConnected = false;

// machineId -> { topic, deploymentId, gatewayId, machineTs, data, receivedAt, lastMessageAt }
const machineCache = {};
// topic -> machineId, so incoming messages know which cache entry to update
const topicToMachineId = {};

// --- Rolling message history (in-memory only, NOT written to Postgres) ---
// Deliberately kept out of the DB for now: the production tracker is
// already paused pending a retention decision, and writing every MQTT
// message to disk is exactly the growth we're avoiding. A fixed-size
// ring per machine costs nothing and needs no cleanup job. If we later
// want real history, this is the obvious place to tee into TimescaleDB.
//
// Cost estimate: 25 machines x 10 msgs x ~2 KB = well under 1 MB.
// Buffers are cleared on restart -- that's accepted, this is a live
// debugging aid (MQTTX-style), not a historian.
const HISTORY_LIMIT = 10;      // messages kept per machine, newest first
const MAX_RAW_CHARS = 8192;    // guard against one huge payload eating memory
// machineId -> [{ receivedAt, bytes, data, raw, parseError }]
const machineHistory = {};

function pushHistory(machineId, entry) {
    let buf = machineHistory[machineId];
    if (!buf) {
        buf = [];
        machineHistory[machineId] = buf;
    }
    buf.unshift(entry);
    if (buf.length > HISTORY_LIMIT) buf.length = HISTORY_LIMIT; // FIFO drop of oldest
}

function getMachineHistory(machineId) {
    return machineHistory[machineId] || [];
}

function clearMachineHistory(machineId) {
    delete machineHistory[machineId];
}

function parseEnvelope(topic, payload) {
    try {
        const parsed = JSON.parse(payload.toString());
        // Real gateway payloads arrive wrapped: { deployment_id, gateway_id, ts, data: {...} }
        // Some gateways use a capitalized "Data" key instead of "data" —
        // handle both rather than assuming one casing across all gateways.
        // Some topics (like the old demo one) send flat JSON with no envelope.
        const dataContainer = parsed && typeof parsed === 'object'
            ? (parsed.data && typeof parsed.data === 'object' ? parsed.data
                : (parsed.Data && typeof parsed.Data === 'object' ? parsed.Data : null))
            : null;
        const hasEnvelope = dataContainer !== null;
        return {
            topic,
            deploymentId: hasEnvelope ? (parsed.deployment_id ?? parsed.Deployment_Id ?? null) : null,
            gatewayId: hasEnvelope ? (parsed.gateway_id ?? parsed.Gateway_Id ?? null) : null,
            machineTs: hasEnvelope ? (parsed.ts ?? parsed.Ts ?? null) : null,
            data: hasEnvelope ? dataContainer : parsed,
            receivedAt: new Date(),
        };
    } catch (err) {
        console.error(`MQTT message on ${topic} was not valid JSON:`, err.message);
        return null;
    }
}

async function loadTopicsFromDb(dbClient) {
    const res = await dbClient.query('SELECT machine_id, mqtt_topic FROM machine_topics');
    return res.rows; // [{ machine_id, mqtt_topic }, ...]
}

function subscribeTopic(topic, machineId) {
    if (!client) return;
    topicToMachineId[topic] = machineId;
    client.subscribe(topic, (err) => {
        if (err) console.error(`MQTT subscribe error for ${topic}:`, err.message);
        else console.log(`Subscribed to ${topic} (machine: ${machineId})`);
    });
}

function unsubscribeTopic(topic) {
    const machineId = topicToMachineId[topic];
    delete topicToMachineId[topic];
    if (machineId) {
        delete machineCache[machineId];
        clearMachineHistory(machineId); // don't leak buffers as topics come and go
    }
    if (!client) return;
    client.unsubscribe(topic, (err) => {
        if (err) console.error(`MQTT unsubscribe error for ${topic}:`, err.message);
        else console.log(`Unsubscribed from ${topic}`);
    });
}

// Used when a topic is EDITED on the dashboard. Without this the client
// stays subscribed to the old topic and keeps filling the cache with the
// wrong feed until the service restarts -- which would defeat the whole
// point of the dynamic subscription design. Order matters: drop the old
// subscription first, then take the new one.
function retargetTopic(machineId, oldTopic, newTopic) {
    if (oldTopic === newTopic) return;
    unsubscribeTopic(oldTopic);
    subscribeTopic(newTopic, machineId);
}

async function startMqttClient(dbClient) {
    const {
        MQTT_ENDPOINT,
        MQTT_PORT,
        MQTT_CA_PATH,
        MQTT_CERT_PATH,
        MQTT_KEY_PATH,
        MQTT_CLIENT_ID,
    } = process.env;

    if (!MQTT_ENDPOINT || !MQTT_CA_PATH || !MQTT_CERT_PATH || !MQTT_KEY_PATH) {
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
        reconnectPeriod: 5000,
    };

    client = mqtt.connect(options);

    client.on('connect', async () => {
        mqttConnected = true;
        console.log(`MQTT connected to ${MQTT_ENDPOINT}`);
        try {
            const topics = await loadTopicsFromDb(dbClient);
            for (const { machine_id, mqtt_topic } of topics) {
                subscribeTopic(mqtt_topic, machine_id);
            }
            console.log(`Subscribed to ${topics.length} topic(s) from machine_topics table`);
        } catch (err) {
            console.error('Failed to load topics from DB:', err.message);
        }
    });

    client.on('message', (topic, payload) => {
        const machineId = topicToMachineId[topic];
        if (!machineId) return; // message on a topic we're not tracking (shouldn't happen)

        const rawStr = payload.toString();
        const raw = rawStr.length > MAX_RAW_CHARS
            ? rawStr.slice(0, MAX_RAW_CHARS) + ' ...[truncated]'
            : rawStr;

        const parsed = parseEnvelope(topic, payload);

        // History records EVERY message, including ones that failed to
        // parse -- a malformed payload is exactly what you want to see
        // when debugging a new gateway, and it's the case where the live
        // view below shows nothing at all.
        pushHistory(machineId, {
            receivedAt: new Date(),
            bytes: payload.length,
            raw,
            data: parsed ? parsed.data : null,
            gatewayId: parsed ? parsed.gatewayId : null,
            machineTs: parsed ? parsed.machineTs : null,
            parseError: !parsed,
        });

        if (!parsed) return;
        machineCache[machineId] = {
            ...parsed,
            lastMessageAt: parsed.receivedAt,
        };
    });

    client.on('error', (err) => {
        console.error('MQTT connection error:', err.message);
    });

    client.on('close', () => {
        mqttConnected = false;
    });
}

function getLatestMachineData(machineId) {
    const cached = machineCache[machineId];
    return {
        connected: mqttConnected,
        lastMessageAt: cached?.lastMessageAt ?? null,
        ...(cached || {}),
    };
}

function getAllMachineIds() {
    return Object.keys(topicToMachineId).map((topic) => topicToMachineId[topic]);
}

function getConnectionStatus() {
    return {
        connected: Boolean(client && client.connected),
        reconnecting: Boolean(client && client.reconnecting),
    };
}

module.exports = {
    startMqttClient,
    getLatestMachineData,
    getMachineHistory,
    getConnectionStatus,
    clearMachineHistory,
    subscribeTopic,
    unsubscribeTopic,
    retargetTopic,
    getAllMachineIds,
    HISTORY_LIMIT,
};
