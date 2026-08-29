/*
 * admin.js — administrator-only user management.
 *
 * Every handler here calls auth.requireAdmin, which re-reads is_admin
 * from the database on each request rather than trusting the session
 * token. Admin can be revoked mid-session and a stale cookie must not
 * keep the privilege alive.
 */

const crypto = require('crypto');
const auth = require('./auth');
const auditLogger = require('./auditLogger');

// --------------------------------------------------------------- helpers

const NAME_RE = /^[a-z0-9_-]{2,50}$/;

function validUsername(u) {
    return typeof u === 'string' && NAME_RE.test(u);
}

/*
 * Temporary passwords omit +, / and = so they survive being typed into
 * gateway web forms and read aloud over a phone line without ambiguity.
 */
function tempPassword() {
    return crypto.randomBytes(12).toString('base64')
        .replace(/[+/=]/g, '').slice(0, 12);
}

// ----------------------------------------------------------------- users

/** GET /api/admin/users */
async function handleUsers(req, res, dbClient) {
    const admin = await auth.requireAdmin(req, res, dbClient);
    if (!admin) return;

    try {
        const q = await dbClient.query(
            `SELECT username, is_active, is_admin, must_change_password,
                    created_at, last_login
               FROM users ORDER BY username`
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ users: q.rows, me: admin.username }));
    } catch (err) {
        console.error('admin users error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Could not read users.' }));
    }
}

/** POST /api/admin/reset-password  { username } */
async function handleResetPassword(req, res, dbClient, body) {
    const admin = await auth.requireAdmin(req, res, dbClient);
    if (!admin) return;

    const username = String(body.username || '').trim().toLowerCase();
    if (!validUsername(username)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid username.' }));
    }

    const temp = tempPassword();
    try {
        const hash = await auth.hashPassword(temp);
        const q = await dbClient.query(
            `UPDATE users
                SET password_hash = $1, must_change_password = true, is_active = true
              WHERE username = $2
              RETURNING username`,
            [hash, username]
        );
        if (!q.rowCount) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: `No such user: ${username}` }));
        }
        console.log(`password reset: ${username} by ${admin.username}`);
        await auditLogger.logAuditEvent(dbClient, {
            actorId: admin.username,
            actorIp: req.socket.remoteAddress,
            action: 'RESET_PASSWORD',
            targetType: 'user',
            targetId: username,
            details: {},
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, username, temporaryPassword: temp }));
    } catch (err) {
        console.error('admin reset error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Could not reset password.' }));
    }
}

/** POST /api/admin/set-active  { username, active } */
async function handleSetActive(req, res, dbClient, body) {
    const admin = await auth.requireAdmin(req, res, dbClient);
    if (!admin) return;

    const username = String(body.username || '').trim().toLowerCase();
    const active = body.active === true;

    if (!validUsername(username)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid username.' }));
    }
    /* Locking yourself out would need shell access to undo, so refuse
       it outright rather than relying on the UI to hide the button. */
    if (username === admin.username && !active) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'You cannot disable your own account.' }));
    }

    try {
        const q = await dbClient.query(
            'UPDATE users SET is_active = $1 WHERE username = $2 RETURNING username',
            [active, username]
        );
        if (!q.rowCount) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: `No such user: ${username}` }));
        }
        console.log(`${active ? 'enabled' : 'disabled'}: ${username} by ${admin.username}`);
        await auditLogger.logAuditEvent(dbClient, {
            actorId: admin.username,
            actorIp: req.socket.remoteAddress,
            action: active ? 'ENABLE_USER' : 'DISABLE_USER',
            targetType: 'user',
            targetId: username,
            details: {},
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, username, active }));
    } catch (err) {
        console.error('admin set-active error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Could not update account.' }));
    }
}

/** POST /api/admin/add-user  { username } */
async function handleAddUser(req, res, dbClient, body) {
    const admin = await auth.requireAdmin(req, res, dbClient);
    if (!admin) return;

    const username = String(body.username || '').trim().toLowerCase();
    if (!validUsername(username)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            error: 'Username: 2-50 chars, lowercase letters, digits, hyphen, underscore.',
        }));
    }

    const temp = tempPassword();
    try {
        const hash = await auth.hashPassword(temp);
        await dbClient.query(
            `INSERT INTO users (username, password_hash, must_change_password)
             VALUES ($1, $2, true)`,
            [username, hash]
        );
        console.log(`user created: ${username} by ${admin.username}`);
        await auditLogger.logAuditEvent(dbClient, {
            actorId: admin.username,
            actorIp: req.socket.remoteAddress,
            action: 'ADD_USER',
            targetType: 'user',
            targetId: username,
            details: {},
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, username, temporaryPassword: temp }));
    } catch (err) {
        if (err.code === '23505') {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: `${username} already exists.` }));
        }
        console.error('admin add-user error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Could not create user.' }));
    }
}

/** POST /api/admin/set-admin  { username, admin } */
async function handleSetAdmin(req, res, dbClient, body) {
    const admin = await auth.requireAdmin(req, res, dbClient);
    if (!admin) return;

    const username = String(body.username || '').trim().toLowerCase();
    const grant = body.admin === true;

    if (!validUsername(username)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid username.' }));
    }
    if (username === admin.username && !grant) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'You cannot remove your own admin rights.' }));
    }

    try {
        const q = await dbClient.query(
            'UPDATE users SET is_admin = $1 WHERE username = $2 RETURNING username',
            [grant, username]
        );
        if (!q.rowCount) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: `No such user: ${username}` }));
        }
        console.log(`admin ${grant ? 'granted' : 'revoked'}: ${username} by ${admin.username}`);
        await auditLogger.logAuditEvent(dbClient, {
            actorId: admin.username,
            actorIp: req.socket.remoteAddress,
            action: grant ? 'GRANT_ADMIN' : 'REVOKE_ADMIN',
            targetType: 'user',
            targetId: username,
            details: {},
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, username, admin: grant }));
    } catch (err) {
        console.error('admin set-admin error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Could not update role.' }));
    }
}

module.exports = {
    handleUsers,
    handleResetPassword,
    handleSetActive,
    handleAddUser,
    handleSetAdmin,
};
