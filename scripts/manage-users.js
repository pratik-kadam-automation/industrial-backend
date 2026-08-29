#!/usr/bin/env node
/*
 * scripts/manage-users.js — create, update, list, and disable dashboard users.
 *
 * Passwords are read from a TTY prompt with echo off rather than taken as
 * an argv value. Arguments land in shell history and in `ps` output, both
 * of which are readable by anyone else on the box.
 *
 *   node scripts/manage-users.js add pratik
 *   node scripts/manage-users.js passwd ela
 *   node scripts/manage-users.js reset ela      # admin: temp password
 *   node scripts/manage-users.js admin pratik   # grant admin
 *   node scripts/manage-users.js unadmin ela    # revoke admin
 *   node scripts/manage-users.js list
 *   node scripts/manage-users.js disable tarun
 *   node scripts/manage-users.js enable tarun
 */

require('dotenv').config();
const crypto = require('crypto');
const { Pool } = require('pg');
const { hashPassword } = require('../auth');

const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
});

/*
 * Reads a line from the TTY with echo off. The earlier readline-based
 * approach left characters visible; this uses raw mode directly, which
 * is the only reliable way without pulling in a dependency.
 */
function promptHidden(question) {
    return new Promise((resolve, reject) => {
        const stdin = process.stdin;
        if (!stdin.isTTY) {
            return reject(new Error('Not a TTY — run this in an interactive shell.'));
        }
        process.stdout.write(question);

        const wasRaw = stdin.isRaw;
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');

        let buf = '';
        const onData = (chunk) => {
            for (const ch of chunk) {
                if (ch === '\r' || ch === '\n') {
                    stdin.removeListener('data', onData);
                    stdin.setRawMode(wasRaw);
                    stdin.pause();
                    process.stdout.write('\n');
                    return resolve(buf);
                }
                if (ch === '\u0003') {           // Ctrl+C
                    stdin.setRawMode(wasRaw);
                    process.stdout.write('\n');
                    process.exit(130);
                }
                if (ch === '\u007f' || ch === '\b') {   // backspace
                    buf = buf.slice(0, -1);
                    continue;
                }
                if (ch < ' ') continue;          // ignore other control chars
                buf += ch;
            }
        };
        stdin.on('data', onData);
    });
}

async function ensureTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id            SERIAL PRIMARY KEY,
            username      VARCHAR(50) NOT NULL UNIQUE,
            password_hash TEXT        NOT NULL,
            is_active     BOOLEAN     NOT NULL DEFAULT true,
            created_at    TIMESTAMP   NOT NULL DEFAULT now(),
            last_login    TIMESTAMP,
            must_change_password BOOLEAN NOT NULL DEFAULT false,
            is_admin      BOOLEAN     NOT NULL DEFAULT false
        )
    `);
    // Existing installs predate this column; add it idempotently.
    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false
    `);
    // role is additive alongside is_admin for now -- is_admin remains the
    // source of truth for admin routes until WQ-12 introduces role-based
    // middleware. tenant_id has no FK yet; the tenants table arrives in
    // WQ-14. Both are safe to add early so this file isn't touched twice.
    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'viewer'
    `);
    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS tenant_id INTEGER
    `);
    // Backfill: existing admins should carry the admin role explicitly,
    // not just the is_admin flag, so future role-based checks see them.
    await pool.query(`
        UPDATE users SET role = 'admin' WHERE is_admin = true AND role = 'viewer'
    `);
    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false
    `);
    /* Audit trail for certificate issuance. Knowing a cert exists is not
       enough -- with three people provisioning gateways you need to know
       who minted which one and when. */
    await pool.query(`
        CREATE TABLE IF NOT EXISTS cert_audit (
            id           SERIAL PRIMARY KEY,
            gateway_name VARCHAR(100) NOT NULL,
            static_ip    VARCHAR(45),
            issued_by    VARCHAR(50)  NOT NULL,
            issued_at    TIMESTAMP    NOT NULL DEFAULT now(),
            note         TEXT
        )
    `);
}

async function main() {
    const [cmd, username] = process.argv.slice(2);

    if (!cmd) {
        console.log('usage: manage-users.js <add|passwd|reset|admin|unadmin|list|disable|enable> [username]');
        process.exit(1);
    }

    await ensureTable();

    if (cmd === 'list') {
        const q = await pool.query(
            `SELECT username, is_active, is_admin, created_at, last_login, must_change_password
               FROM users ORDER BY username`
        );
        if (!q.rows.length) {
            console.log('No users yet. Create one:  node scripts/manage-users.js add <name>');
        } else {
            console.table(q.rows.map(r => ({
                username: r.username,
                active: r.is_active,
                admin: r.is_admin,
                created: r.created_at.toISOString().slice(0, 10),
                last_login: r.last_login ? r.last_login.toISOString().slice(0, 16) : 'never',
                must_change: r.must_change_password,
            })));
        }
        await pool.end();
        return;
    }

    if (!username) {
        console.error(`'${cmd}' needs a username.`);
        process.exit(1);
    }
    const uname = username.trim().toLowerCase();

    if (cmd === 'admin' || cmd === 'unadmin') {
        const grant = cmd === 'admin';
        const q = await pool.query(
            'UPDATE users SET is_admin = $1 WHERE username = $2 RETURNING username',
            [grant, uname]
        );
        console.log(q.rowCount ? `${uname}: is_admin = ${grant}` : `No such user: ${uname}`);
        await pool.end();
        return;
    }

    if (cmd === 'role') {
        const newRole = process.argv[4];
        const allowed = ['viewer', 'operator', 'engineer', 'admin'];
        if (!allowed.includes(newRole)) {
            console.error(`Role must be one of: ${allowed.join(', ')}`);
            await pool.end();
            return;
        }
        const q = await pool.query(
            'UPDATE users SET role = $1 WHERE username = $2 RETURNING username',
            [newRole, uname]
        );
        console.log(q.rowCount ? `${uname}: role = ${newRole}` : `No such user: ${uname}`);
        await pool.end();
        return;
    }
    if (cmd === 'disable' || cmd === 'enable') {
        const active = cmd === 'enable';
        const q = await pool.query(
            'UPDATE users SET is_active = $1 WHERE username = $2 RETURNING username',
            [active, uname]
        );
        console.log(q.rowCount ? `${uname}: is_active = ${active}` : `No such user: ${uname}`);
        await pool.end();
        return;
    }

    /*
     * Admin reset. Generates a temporary password, prints it once, and
     * flags the account so the user is forced to choose their own on next
     * login. Printing it is the point -- the admin has to relay it out of
     * band -- but it means it lands in scrollback, hence the single-use
     * flag: the temp password is worthless the moment they log in.
     */
    if (cmd === 'reset') {
        const temp = crypto.randomBytes(9).toString('base64')
            .replace(/[+/=]/g, '').slice(0, 12);
        const hash = await hashPassword(temp);
        const q = await pool.query(
            `UPDATE users
               SET password_hash = $1, must_change_password = true, is_active = true
             WHERE username = $2
             RETURNING username`,
            [hash, uname]
        );
        if (!q.rowCount) {
            console.log(`No such user: ${uname}`);
        } else {
            console.log('');
            console.log(`  Temporary password for ${uname}:  ${temp}`);
            console.log('');
            console.log('  Relay this to them directly. They must set their own');
            console.log('  password at first login -- this one stops working then.');
            console.log('');
        }
        await pool.end();
        return;
    }

    if (cmd !== 'add' && cmd !== 'passwd') {
        console.error(`Unknown command: ${cmd}`);
        process.exit(1);
    }

    const pw1 = await promptHidden(`Password for ${uname}: `);
    if (pw1.length < 10) {
        console.error('Too short — use at least 10 characters.');
        process.exit(1);
    }
    const pw2 = await promptHidden('Confirm: ');
    if (pw1 !== pw2) {
        console.error('Passwords do not match.');
        process.exit(1);
    }

    const hash = await hashPassword(pw1);

    if (cmd === 'add') {
        try {
            await pool.query(
                'INSERT INTO users (username, password_hash) VALUES ($1, $2)',
                [uname, hash]
            );
            console.log(`Created user: ${uname}`);
        } catch (err) {
            if (err.code === '23505') {
                console.error(`User ${uname} already exists — use 'passwd' to change it.`);
            } else {
                console.error('Insert failed:', err.message);
            }
            process.exit(1);
        }
    } else {
        const q = await pool.query(
            `UPDATE users SET password_hash = $1, must_change_password = false
              WHERE username = $2 RETURNING username`,
            [hash, uname]
        );
        console.log(q.rowCount ? `Password updated: ${uname}` : `No such user: ${uname}`);
    }

    await pool.end();
}

if (require.main === module) {
    main().catch(err => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = { ensureTable, pool };
