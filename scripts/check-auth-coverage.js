#!/usr/bin/env node
/*
 * scripts/check-auth-coverage.js — fails CI if a route in server.js has
 * no visible auth check and isn't on the explicit allowlist below.
 *
 * This is a text-level check, not real static analysis: it looks for
 * requireAuth/requireAdmin within a route's own if-block in server.js.
 * Routes that delegate to a handler in another file (certs.js, admin.js)
 * won't show an auth call here even when they're genuinely protected --
 * that's why ALLOWLIST exists. Adding a route to ALLOWLIST is a real
 * claim that you've manually confirmed its handler checks auth itself.
 * Don't add to this list to silence the check without checking.
 */
const fs = require('fs');

const src = fs.readFileSync('server.js', 'utf8');
const lines = src.split('\n');

// Routes intentionally public, or verified to guard auth in their own
// handler file rather than inline here.
const ALLOWLIST = [
    '/health',
    '/api/login',
    '/api/logout',
    '/api/certs/generate',   // certs.js: requireAuth + dbClient, fixed 2026-08-24
    '/api/certs/gateways',   // certs.js: requireAuth + dbClient, fixed 2026-08-24
    '/api/certs/list',       // certs.js: requireAuth + dbClient
    '/api/certs/download/',  // certs.js: requireAuth + dbClient. Corrected 2026-08-30 -- trailing slash added to match the actual startsWith('/api/certs/download/') route; the old entry (no trailing slash) never matched anything even before the regex was widened, since the route always used startsWith, never ===.
    '/api/admin/reset-password',  // admin.js: requireAdmin, verified 2026-08-30
    '/api/admin/set-active',      // admin.js: requireAdmin, verified 2026-08-30
    '/api/admin/set-admin',       // admin.js: requireAdmin, verified 2026-08-30
    '/api/admin/add-user',        // admin.js: requireAdmin, verified 2026-08-30
    '/api/admin/users',           // admin.js: requireAdmin, verified 2026-08-30
    '/api/admin/downtime-config', // downtimeConfig.js: requireAdmin (POST) / requireAuth (GET), verified 2026-08-30
    '/api/admin/audit-log',          // auditLogger.js: requireAdmin, verified 2026-08-30 (startsWith route)
    '/api/admin/downtime-config/',   // downtimeConfig.js: requireAuth, verified 2026-08-30 (startsWith route)
    '/',                     // static shell (index.html); real protection is in the guarded API calls it makes, verified 2026-08-30
    '/certs',                // static shell (certs.html); same reasoning as '/', verified 2026-08-30
    '/api/whoami',           // intentionally public -- this IS the auth-status check, verified 2026-08-30
    '/api/sap/report',       // guarded via SAP_REPORT_TOKEN bearer token, not session auth, verified 2026-08-30
    '/api/change-password',  // guarded -- password query itself requires is_active = true, verified 2026-08-30
];

// Matches both exact-match routes (req.url === '...') and prefix-match
// routes (req.url.startsWith('...')) -- widened 2026-08-30 after the
// startsWith style was found to be entirely invisible to this check.
const routeRegex = /req\.url\s*===\s*'([^']+)'|req\.url\.startsWith\('([^']+)'\)/;
const failures = [];

lines.forEach((line, i) => {
    const m = line.match(routeRegex);
    if (!m) return;
    const route = m[1] || m[2];
    if (ALLOWLIST.includes(route)) return;

    // Look ahead a reasonable window for an auth call before the next route.
    const window = lines.slice(i, i + 15).join('\n');
    const hasAuth = /requireAuth|requireAdmin/.test(window);
    if (!hasAuth) {
        failures.push(`  line ${i + 1}: ${route} -- no requireAuth/requireAdmin found, and not on ALLOWLIST`);
    }
});

if (failures.length > 0) {
    console.error('Auth coverage check failed. These routes have no visible auth check:');
    console.error(failures.join('\n'));
    console.error('\nEither add the missing auth check, or -- only if you have personally');
    console.error('verified the handler checks auth itself -- add the route to ALLOWLIST');
    console.error('in scripts/check-auth-coverage.js with a comment explaining why.');
    process.exit(1);
}

console.log(`Auth coverage check passed. ${lines.filter(l => routeRegex.test(l)).length} routes checked.`);
