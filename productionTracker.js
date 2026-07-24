const { getLatestMachineData } = require('./mqtt-machine');

const POLL_MS = 5000;
const RUN_SPEED_ON = 5;   // must reach this to count as "started"
const RUN_SPEED_OFF = 2;  // must drop below this to count as "stopped"
// Gap between ON/OFF thresholds absorbs small signal fluctuations
// around the boundary, preventing rapid open/close flapping that would
// otherwise generate near-empty batch/status rows every few seconds.

/* Adjust these if tag names differ. Matched case-insensitively with
   spaces/underscores normalized, same convention as the dashboard's
   own tag-detection logic. */
const TOP_SPEED_TAGS = ['top_roller_speed'];
const BOTTOM_SPEED_TAGS = ['bottom_roller_speed'];
const ENTRY_SENSOR_TAGS = ['entry_sensor', 'machine_entry_sensor'];
const EXIT_SENSOR_TAGS = ['exit_sensor'];
const BAR_DIAMETER_TAGS = ['in_bar_diameter'];

function normalizeKey(k) {
    return k.toLowerCase().replace(/[\s_]+/g, '_');
}
function findTagValue(data, candidates) {
    const keys = Object.keys(data);
    for (const cand of candidates) {
        const hit = keys.find(k => normalizeKey(k) === cand);
        if (hit !== undefined) {
            const n = Number(data[hit]);
            if (Number.isFinite(n)) return n;
        }
    }
    return null;
}

// In-memory per-machine tracking state. Resets on service restart —
// an in-progress batch or status event at restart time is lost. Good
// enough for now; can be made restart-safe later by persisting state
// to a small table if this becomes a real problem in practice.
const state = {};

function getState(machineId) {
    if (!state[machineId]) {
        state[machineId] = {
            isRunning: false,
            pendingEntries: 0,
            currentBatchId: null,
            currentStatusEventId: null,
            lastEntry: 0,
            lastExit: 0,
        };
    }
    return state[machineId];
}

async function closeStatusEvent(dbClient, eventId) {
    if (!eventId) return;
    await dbClient.query(
        `UPDATE machine_status_events
         SET ended_at = NOW(), duration_seconds = EXTRACT(EPOCH FROM (NOW() - started_at))
         WHERE id = $1`,
        [eventId]
    );
}

async function openStatusEvent(dbClient, machineId, status) {
    const res = await dbClient.query(
        'INSERT INTO machine_status_events (machine_id, status) VALUES ($1, $2) RETURNING id',
        [machineId, status]
    );
    return res.rows[0].id;
}

async function openBatch(dbClient, machineId, barDiameter) {
    const res = await dbClient.query(
        `INSERT INTO production_batches (machine_id, bar_diameter, bar_count, started_at)
         VALUES ($1, $2, 0, NOW()) RETURNING id`,
        [machineId, barDiameter]
    );
    return res.rows[0].id;
}

async function incrementBatch(dbClient, batchId) {
    await dbClient.query(
        'UPDATE production_batches SET bar_count = bar_count + 1 WHERE id = $1',
        [batchId]
    );
}

async function closeBatch(dbClient, batchId) {
    if (!batchId) return;
    await dbClient.query(
        'UPDATE production_batches SET ended_at = NOW() WHERE id = $1',
        [batchId]
    );
}

async function evaluateMachine(dbClient, machineId, data) {
    const s = getState(machineId);

    const topSpeed = findTagValue(data, TOP_SPEED_TAGS) ?? 0;
    const bottomSpeed = findTagValue(data, BOTTOM_SPEED_TAGS) ?? 0;
    const entry = findTagValue(data, ENTRY_SENSOR_TAGS) ?? 0;
    const exit = findTagValue(data, EXIT_SENSOR_TAGS) ?? 0;
    const diameter = findTagValue(data, BAR_DIAMETER_TAGS);

    const speed = Math.max(topSpeed, bottomSpeed);
    // Hysteresis: stay in whatever state we were already in unless we
    // clearly cross the opposite threshold.
    const isRunning = s.isRunning
        ? speed >= RUN_SPEED_OFF   // already running: only stop if it drops below OFF
        : speed >= RUN_SPEED_ON;   // already idle: only start if it reaches ON

    // Running/idle transitions open/close status events and batches FIRST,
    // so a bar detected in this same cycle has a batch row to attach to.
    if (isRunning && !s.isRunning) {
        await closeStatusEvent(dbClient, s.currentStatusEventId);
        s.currentStatusEventId = await openStatusEvent(dbClient, machineId, 'running');
        s.currentBatchId = await openBatch(dbClient, machineId, diameter);
    } else if (!isRunning && s.isRunning) {
        await closeBatch(dbClient, s.currentBatchId);
        s.currentBatchId = null;
        await closeStatusEvent(dbClient, s.currentStatusEventId);
        s.currentStatusEventId = await openStatusEvent(dbClient, machineId, 'idle');
    }
    s.isRunning = isRunning;

    // Bar counting: only count a bar once BOTH entry and exit have
    // pulsed for it (rising-edge detection on each, paired via a
    // pending-entries counter — handles multiple bars mid-machine).
    const entryRose = entry > 0 && s.lastEntry === 0;
    const exitRose = exit > 0 && s.lastExit === 0;

    if (entryRose) {
        s.pendingEntries += 1;
    }
    if (exitRose && s.pendingEntries > 0) {
        s.pendingEntries -= 1;
        if (s.currentBatchId) {
            await incrementBatch(dbClient, s.currentBatchId);
        }
    }
    s.lastEntry = entry;
    s.lastExit = exit;
}

// Currently tracks only the single live MQTT feed (Venus). Extend
// mqtt-machine.js to support multiple gateways before adding more
// machine IDs here — this function assumes one shared data source.
function startProductionTracker(dbClient, machineId = 'venus') {
    setInterval(async () => {
        const latest = getLatestMachineData();
        if (!latest || !latest.data) return;
        try {
            await evaluateMachine(dbClient, machineId, latest.data);
        } catch (err) {
            console.error(`Production tracker error for ${machineId}:`, err.message);
        }
    }, POLL_MS);
    console.log(`Production tracker started for machine "${machineId}"`);

    // Storage safety net: delete completed rows older than the
    // retention window, once a day. Keeps this table from growing
    // unbounded regardless of how much data gets logged day to day.
    // Raw per-second trend data (if ever added later) should get a
    // much shorter retention window than this — batches/status events
    // are naturally low-volume (one row per state change, not per poll).
    const RETENTION_DAYS = 180;
    const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
    setInterval(async () => {
        try {
            const res1 = await dbClient.query(
                `DELETE FROM production_batches WHERE ended_at < NOW() - ($1 || ' days')::interval`,
                [RETENTION_DAYS]
            );
            const res2 = await dbClient.query(
                `DELETE FROM machine_status_events WHERE ended_at < NOW() - ($1 || ' days')::interval`,
                [RETENTION_DAYS]
            );
            console.log(`Retention cleanup: removed ${res1.rowCount} old batches, ${res2.rowCount} old status events`);
        } catch (err) {
            console.error('Retention cleanup failed:', err.message);
        }
    }, CLEANUP_INTERVAL_MS);
}

module.exports = { startProductionTracker };
