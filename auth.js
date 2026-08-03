/*
 * auth.js — login, sessions, and password storage for industrial-backend.
 *
 * Deliberately dependency-free: password hashing uses Node's built-in
 * crypto.scrypt and sessions are stateless HMAC-signed tokens. Two
 * reasons that matters here. First, this box has 1 GB of RAM and a
 * history of OOM kills, so every avoided dependency is real. Second,
 * stateless tokens survive `systemctl restart industrial-backend` —
 * an in-memory session store would sign everyone out on every deploy,
 * which on this project happens several times an evening.
 *
 * The token is NOT encrypted, only signed. It carries username and
 * expiry in the clear; the signature stops anyone forging one. Never
 * put anything secret in the payload.
 */

const crypto = require('crypto');

// ---------------------------------------------------------------- config

const SESSION_SECRET = process.env.SESSION_SECRET || '';
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);
const COOKIE_NAME = 'slogic_session';

if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
    // Failing loudly at boot beats silently accepting forged tokens.
    throw new Error(
        'SESSION_SECRET missing or too short in .env (need >= 32 chars).\n' +
        'Generate one with:  openssl rand -base64 48'
    );
}

// scrypt parameters. N=16384 is the Node default and takes roughly
// 100 ms on this instance — slow enough to make offline cracking
// expensive, fast enough that login does not feel laggy.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;

// ------------------------------------------------------- password hashing

/** Returns a self-describing hash string: scrypt$N$r$p$salt$hash */
function hashPassword(plain) {
    return new Promise((resolve, reject) => {
        const salt = crypto.randomBytes(SALT_BYTES);
        crypto.scrypt(
            plain, salt, KEYLEN,
            { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
            (err, derived) => {
                if (err) return reject(err);
                resolve(
                    `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$` +
                    `${salt.toString('base64')}$${derived.toString('base64')}`
                );
            }
        );
    });
}

/** Constant-time verify against a stored hash string. */
function verifyPassword(plain, stored) {
    return new Promise((resolve) => {
        if (typeof stored !== 'string') return resolve(false);
        const parts = stored.split('$');
        if (parts.length !== 6 || parts[0] !== 'scrypt') return resolve(false);

        const [, n, r, p, saltB64, hashB64] = parts;
        let salt, expected;
        try {
            salt = Buffer.from(saltB64, 'base64');
            expected = Buffer.from(hashB64, 'base64');
        } catch (e) {
            return resolve(false);
        }

        crypto.scrypt(
            plain, salt, expected.length,
            { N: Number(n), r: Number(r), p: Number(p) },
            (err, derived) => {
                if (err) return resolve(false);
                // timingSafeEqual throws on length mismatch, hence the guard.
                if (derived.length !== expected.length) return resolve(false);
                resolve(crypto.timingSafeEqual(derived, expected));
            }
        );
    });
}

// --------------------------------------------------------------- sessions

function sign(data) {
    return crypto.createHmac('sha256', SESSION_SECRET)
        .update(data).digest('base64url');
}

/** Builds a signed token carrying username + expiry. */
function createToken(username) {
    const payload = JSON.stringify({
        u: username,
        exp: Date.now() + SESSION_HOURS * 3600 * 1000,
    });
    const body = Buffer.from(payload).toString('base64url');
    return `${body}.${sign(body)}`;
}

/** Returns { username } for a valid unexpired token, else null. */
function verifyToken(token) {
    if (typeof token !== 'string' || !token.includes('.')) return null;
    const idx = token.lastIndexOf('.');
    const body = token.slice(0, idx);
    const sig = token.slice(idx + 1);

    const expectedSig = sign(body);
    // Compare as buffers of equal length, constant time.
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    let payload;
    try {
        payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch (e) {
        return null;
    }
    if (!payload || typeof payload.exp !== 'number') return null;
    if (Date.now() > payload.exp) return null;
    return { username: payload.u };
}

// ---------------------------------------------------------------- cookies

function parseCookies(req) {
    const header = req.headers.cookie;
    const out = {};
    if (!header) return out;
    for (const pair of header.split(';')) {
        const i = pair.indexOf('=');
        if (i < 0) continue;
        out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
    }
    return out;
}

/*
 * The Secure flag is intentionally conditional. The dashboard is
 * currently reached over plain HTTP at 10.8.0.1:3000 through the VPN,
 * so setting Secure unconditionally would make the cookie undeliverable
 * and login would appear to succeed then immediately fail. Flip
 * COOKIE_SECURE=1 in .env once certbot DNS-01 gives the portal HTTPS.
 */
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';

function sessionCookie(token) {
    const bits = [
        `${COOKIE_NAME}=${token}`,
        'HttpOnly',
        'Path=/',
        'SameSite=Strict',
        `Max-Age=${SESSION_HOURS * 3600}`,
    ];
    if (COOKIE_SECURE) bits.push('Secure');
    return bits.join('; ');
}

function clearCookie() {
    return `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`;
}

// ------------------------------------------------------------ middleware

/** Returns { username } if the request carries a valid session, else null. */
function getUser(req) {
    const token = parseCookies(req)[COOKIE_NAME];
    if (!token) return null;
    return verifyToken(token);
}

/**
 * Guard for protected routes. Returns the user, or writes a 401 and
 * returns null — so call sites read:
 *
 *   const user = requireAuth(req, res);
 *   if (!user) return;
 */
function requireAuth(req, res) {
    const user = getUser(req);
    if (user) return user;
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Authentication required' }));
    return null;
}

// --------------------------------------------------------- login handlers

/*
 * Rate limiting: a small in-memory map of failed attempts per username.
 * Not distributed and it resets on restart, which is fine — the goal is
 * to blunt online guessing, not to be a fortress. scrypt already makes
 * each attempt cost ~100 ms.
 */
const failures = new Map();
const MAX_FAILURES = 8;
const LOCKOUT_MS = 15 * 60 * 1000;

function isLockedOut(username) {
    const rec = failures.get(username);
    if (!rec) return false;
    if (Date.now() - rec.at > LOCKOUT_MS) {
        failures.delete(username);
        return false;
    }
    return rec.count >= MAX_FAILURES;
}

function noteFailure(username) {
    const rec = failures.get(username) || { count: 0, at: Date.now() };
    rec.count += 1;
    rec.at = Date.now();
    failures.set(username, rec);
}

function clearFailures(username) {
    failures.delete(username);
}

/**
 * POST /api/login  { username, password }
 * `pool` is the pg Pool already created in server.js.
 */
async function handleLogin(req, res, pool, body) {
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');

    if (!username || !password) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Username and password required.' }));
    }

    if (isLockedOut(username)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            error: 'Too many failed attempts. Try again in 15 minutes.',
        }));
    }

    let row = null;
    try {
        const q = await pool.query(
            `SELECT username, password_hash, is_active, must_change_password
               FROM users WHERE username = $1`,
            [username]
        );
        row = q.rows[0] || null;
    } catch (err) {
        console.error('login db error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Login unavailable.' }));
    }

    // Verify even when the user does not exist, against a dummy hash, so
    // response timing does not reveal which usernames are real.
    const stored = row ? row.password_hash : DUMMY_HASH;
    const ok = await verifyPassword(password, stored);

    if (!row || !row.is_active || !ok) {
        noteFailure(username);
        console.warn(`failed login: ${username}`);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid username or password.' }));
    }

    clearFailures(username);
    pool.query('UPDATE users SET last_login = now() WHERE username = $1', [username])
        .catch(e => console.warn('last_login update failed:', e.message));

    console.log(`login ok: ${username}`);
    res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': sessionCookie(createToken(username)),
    });
    res.end(JSON.stringify({
        ok: true,
        username,
        mustChangePassword: !!row.must_change_password,
    }));
}

/* A fixed valid-format hash so the unknown-user path costs the same
   scrypt work as the known-user path. Password is irrelevant. */
const DUMMY_HASH =
    'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function handleLogout(req, res) {
    res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': clearCookie(),
    });
    res.end(JSON.stringify({ ok: true }));
}

async function handleWhoami(req, res, pool) {
    const user = getUser(req);
    if (!user) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ authenticated: false, username: null }));
    }
    /* Read the flag live rather than trusting the token. An admin may
       have reset this account after the session was issued, and a stale
       token should not let someone skip the forced change. */
    let mustChange = false;
    try {
        const q = await pool.query(
            'SELECT must_change_password, is_active FROM users WHERE username = $1',
            [user.username]
        );
        const row = q.rows[0];
        if (!row || !row.is_active) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ authenticated: false, username: null }));
        }
        mustChange = !!row.must_change_password;
    } catch (err) {
        console.warn('whoami db error:', err.message);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        authenticated: true,
        username: user.username,
        mustChangePassword: mustChange,
    }));
}

/**
 * POST /api/change-password  { currentPassword, newPassword }
 * Any logged-in user can change their own. Verifying the current
 * password matters even inside a session: it stops someone who walks up
 * to an unlocked laptop from locking the real owner out.
 */
async function handleChangePassword(req, res, pool, body) {
    const user = getUser(req);
    if (!user) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Not logged in.' }));
    }

    const current = String(body.currentPassword || '');
    const next = String(body.newPassword || '');

    if (next.length < 10) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'New password must be at least 10 characters.' }));
    }
    if (next === current) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'New password must differ from the current one.' }));
    }

    try {
        const q = await pool.query(
            'SELECT password_hash FROM users WHERE username = $1 AND is_active = true',
            [user.username]
        );
        const row = q.rows[0];
        if (!row || !(await verifyPassword(current, row.password_hash))) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Current password is incorrect.' }));
        }

        const hash = await hashPassword(next);
        await pool.query(
            `UPDATE users SET password_hash = $1, must_change_password = false
              WHERE username = $2`,
            [hash, user.username]
        );
        console.log(`password changed: ${user.username}`);

        /* Reissue the cookie so the session clock restarts from the
           change rather than expiring at the old moment. */
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': sessionCookie(createToken(user.username)),
        });
        res.end(JSON.stringify({ ok: true }));
    } catch (err) {
        console.error('change-password error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Could not change password.' }));
    }
}

module.exports = {
    hashPassword,
    verifyPassword,
    createToken,
    verifyToken,
    getUser,
    requireAuth,
    handleLogin,
    handleLogout,
    handleWhoami,
    handleChangePassword,
    COOKIE_NAME,
};
