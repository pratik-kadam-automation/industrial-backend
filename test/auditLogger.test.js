// test/auditLogger.test.js
//
// Runs against the scratch database (factory_data_test), never production.
// Loads .env.test explicitly, before anything else touches process.env —
// dotenv only fills in vars that aren't already set, so this order matters.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.test') });

const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { logAuditEvent, ensureAuditTable } = require('../auditLogger');

let client;

test.before(async () => {
    client = new Client({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });
    await client.connect();

    // Guard: refuse to run against anything that isn't the scratch DB.
    // A typo in .env.test pointing this at factory_data would otherwise
    // write test rows into the real production audit log.
    assert.equal(
        process.env.DB_NAME,
        'factory_data_test',
        'refusing to run: DB_NAME is not the scratch test database'
    );

    await ensureAuditTable(client);
});

test.after(async () => {
    await client.end();
});

test('logAuditEvent writes a row and returns id + timestamp', async () => {
    const result = await logAuditEvent(client, {
        actorId: 'test-runner',
        actorIp: '127.0.0.1',
        action: 'TEST_EVENT',
        targetType: 'test',
        targetId: 'auditLogger.test.js',
        details: { note: 'automated test' },
    });

    assert.ok(result, 'expected a result object, got null (write failed silently)');
    assert.ok(Number.isInteger(result.id), 'expected numeric id');
    assert.ok(result.timestamp, 'expected a timestamp');

    const check = await client.query(
        'SELECT actor_id, action, status FROM audit_logs WHERE id = $1',
        [result.id]
    );
    assert.equal(check.rows.length, 1);
    assert.equal(check.rows[0].actor_id, 'test-runner');
    assert.equal(check.rows[0].action, 'TEST_EVENT');
    assert.equal(check.rows[0].status, 'SUCCESS');
});

test('logAuditEvent defaults actorId to "system" when omitted', async () => {
    const result = await logAuditEvent(client, {
        action: 'TEST_EVENT_NO_ACTOR',
    });
    assert.ok(result);

    const check = await client.query(
        'SELECT actor_id FROM audit_logs WHERE id = $1',
        [result.id]
    );
    assert.equal(check.rows[0].actor_id, 'system');
});

test('a password reset audit entry never stores the password in details', async () => {
    // Mirrors exactly how admin.js calls this for handleResetPassword —
    // details is deliberately {} so a temp password can never end up
    // sitting in the audit log.
    const tempPassword = 'sOmeTempPassw0rd';
    const result = await logAuditEvent(client, {
        actorId: 'pratik',
        action: 'RESET_PASSWORD',
        targetType: 'user',
        targetId: 'test-target-user',
        details: {},
    });
    assert.ok(result);

    const check = await client.query(
        'SELECT details FROM audit_logs WHERE id = $1',
        [result.id]
    );
    const detailsText = JSON.stringify(check.rows[0].details);
    assert.doesNotMatch(
        detailsText,
        new RegExp(tempPassword),
        'temp password must never appear in audit log details'
    );
});
