/*
 * certs.js — authenticated certificate provisioning and download.
 *
 * Wraps scripts/new-gateway.sh so the web portal and the CLI produce
 * byte-identical results. Duplicating the provisioning logic in JS would
 * mean two places to keep in sync, and the divergence would surface as a
 * gateway that connects but lands on the wrong IP.
 *
 * Every route here requires a session. The dashboard itself stays open.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const auth = require('./auth');

const SCRIPT = process.env.GATEWAY_SCRIPT
    || path.join(__dirname, 'scripts', 'new-gateway.sh');
const EASYRSA_DIR = process.env.EASYRSA_DIR || '/home/ubuntu/openvpn-ca';
const CCD_DIR = process.env.CCD_DIR || '/etc/openvpn/server/ccd';
const OUT_DIR = process.env.OUT_DIR || '/home/ubuntu/gateway-configs';

/* Whether to prefix the script with sudo. The systemd unit may run node
   as a non-root user, in which case writing ccd/ and running easy-rsa
   both need elevation via a narrowly-scoped sudoers rule. */
const USE_SUDO = process.env.CERT_USE_SUDO === '1';

// ------------------------------------------------------------ validation

/*
 * Gateway names become filenames, certificate CNs, and shell arguments.
 * The allowlist is deliberately narrow: anything outside it is rejected
 * rather than escaped. This is the single most important check in the
 * file -- a name containing ../ or a null byte would otherwise let an
 * authenticated user read arbitrary files through the download route.
 */
const NAME_RE = /^[a-zA-Z0-9_-]{2,50}$/;

function validName(name) {
    return typeof name === 'string' && NAME_RE.test(name);
}

// The four files a gateway needs, plus the combined bundle.
function filesFor(name) {
    return {
        'ca.crt':        path.join(EASYRSA_DIR, 'pki', 'ca.crt'),
        [`${name}.crt`]: path.join(EASYRSA_DIR, 'pki', 'issued', `${name}.crt`),
        [`${name}.key`]: path.join(EASYRSA_DIR, 'pki', 'private', `${name}.key`),
        'ta.key':        path.join(EASYRSA_DIR, 'ta.key'),
        [`${name}.ovpn`]: path.join(OUT_DIR, `${name}.ovpn`),
    };
}

function readCcdIp(name) {
    try {
        const txt = fs.readFileSync(path.join(CCD_DIR, name), 'utf8');
        const m = txt.match(/ifconfig-push\s+(\S+)/);
        return m ? m[1] : null;
    } catch (e) {
        return null;
    }
}

// --------------------------------------------------------------- generate

/**
 * POST /api/certs/generate  { client: 'gloster' }  or  { name: 'gloster13' }
 */
async function handleGenerate(req, res, dbClient, body) {
    const user = auth.requireAuth(req, res);
    if (!user) return;

    const client = body.client ? String(body.client).trim().toLowerCase() : '';
    const name = body.name ? String(body.name).trim() : '';

    let args;
    if (client) {
        if (!validName(client)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Invalid client prefix.' }));
        }
        args = ['--client', client];
    } else if (name) {
        if (!validName(name)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                error: 'Name must be 2-50 chars: letters, digits, hyphen, underscore.',
            }));
        }
        if (fs.existsSync(path.join(CCD_DIR, name))) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: `${name} already exists.` }));
        }
        args = [name];
    } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Provide a client prefix or a name.' }));
    }

    const cmd = USE_SUDO ? 'sudo' : SCRIPT;
    const cmdArgs = USE_SUDO ? ['-n', SCRIPT, ...args] : args;

    /* execFile, never exec: arguments are passed as an array so the shell
       never sees them. Combined with NAME_RE this closes command
       injection from both directions. */
    execFile(cmd, cmdArgs, { timeout: 120000 }, async (err, stdout, stderr) => {
        if (err) {
            console.error('cert generate failed:', stderr || err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                error: 'Generation failed.',
                detail: (stderr || err.message).slice(0, 500),
            }));
        }

        // The script prints the name it chose, which matters in --client
        // mode where the caller does not know it in advance.
        const nameMatch = stdout.match(/→ gateway\s*:\s*(\S+)/);
        const ipMatch = stdout.match(/→ staticIP\s*:\s*(\S+)/);
        const finalName = nameMatch ? nameMatch[1] : name;
        const staticIp = ipMatch ? ipMatch[1] : readCcdIp(finalName);

        try {
            await dbClient.query(
                `INSERT INTO cert_audit (gateway_name, static_ip, issued_by)
                 VALUES ($1, $2, $3)`,
                [finalName, staticIp, user.username]
            );
        } catch (e) {
            console.warn('cert_audit insert failed:', e.message);
        }

        console.log(`cert issued: ${finalName} (${staticIp}) by ${user.username}`);

        const available = [];
        for (const [label, p] of Object.entries(filesFor(finalName))) {
            if (fs.existsSync(p)) available.push(label);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ok: true,
            name: finalName,
            staticIp,
            files: available,
            log: stdout.slice(0, 2000),
        }));
    });
}

// --------------------------------------------------------------- download

/**
 * GET /api/certs/download/<name>/<file>
 */
function handleDownload(req, res, urlPath) {
    const user = auth.requireAuth(req, res);
    if (!user) return;

    const rest = urlPath.replace('/api/certs/download/', '');
    const [rawName, rawFile] = rest.split('/').map(s => decodeURIComponent(s || ''));

    if (!validName(rawName)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid gateway name.' }));
    }

    /* Look the requested file up in the generated map rather than joining
       user input onto a directory. Even with the name validated, building
       a path from request data invites mistakes; a map lookup cannot
       escape the set of files we intended to expose. */
    const map = filesFor(rawName);
    const filePath = map[rawFile];

    if (!filePath) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Unknown file for this gateway.' }));
    }
    if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: `${rawFile} not found on server.` }));
    }

    fs.readFile(filePath, (err, content) => {
        if (err) {
            console.error('cert read failed:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Could not read file.' }));
        }
        console.log(`cert download: ${rawName}/${rawFile} by ${user.username}`);
        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${rawFile}"`,
            'Content-Length': content.length,
            'Cache-Control': 'no-store',
        });
        res.end(content);
    });
}

// ------------------------------------------------------------------- list

/** GET /api/certs/list — recent issuances, for the portal's history panel. */
async function handleList(req, res, dbClient) {
    const user = auth.requireAuth(req, res);
    if (!user) return;

    try {
        const q = await dbClient.query(
            `SELECT gateway_name, static_ip, issued_by, issued_at
               FROM cert_audit ORDER BY issued_at DESC LIMIT 25`
        );
        const rows = q.rows.map(r => ({
            ...r,
            files: Object.keys(filesFor(r.gateway_name))
                .filter(label => fs.existsSync(filesFor(r.gateway_name)[label])),
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ certs: rows }));
    } catch (err) {
        console.error('cert list error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Could not read issuance history.' }));
    }
}

module.exports = { handleGenerate, handleDownload, handleList, validName };
