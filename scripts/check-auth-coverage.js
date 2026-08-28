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
    '/api/certs/download',   // certs.js: requireAuth + dbClient, fixed 2026-08-24
];

const routeRegex = /req\.url\s*===\s*'([^']+)'/;
const failures = [];

lines.forEach((line, i) => {
    const m = line.match(routeRegex);
    if (!m) return;
    const route = m[1];
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
