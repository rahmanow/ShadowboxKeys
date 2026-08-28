'use strict';

const http = require('http');
const crypto = require('crypto');
const qrcode = require('qrcode-terminal');

const { OutlineClient } = require('./outline');
const { rewriteAccessUrl, parseBytes } = require('./format');
const { UserError } = require('./errors');
const { page } = require('./web');

/**
 * A local web UI over the Management API.
 *
 * Security shape, which matters more here than in most little servers: the
 * Management API URL is full administrative control of the Outline server, and
 * it never leaves this process — the browser talks only to this server, which
 * holds the credential and proxies. Three things guard that:
 *
 *  - it listens on the loopback interface only, so nothing off-machine can
 *    reach it;
 *  - every /api request must carry a random token minted at startup and handed
 *    over in the printed URL, so another page in the same browser cannot drive
 *    it, and requiring a custom header means cross-origin attempts hit a CORS
 *    preflight that is never answered;
 *  - the Host header must name the loopback address, which is what stops DNS
 *    rebinding from turning an attacker's domain into a route to 127.0.0.1.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** True when the Host header names this server on the loopback interface. */
function hostIsLoopback(hostHeader, port) {
    if (!hostHeader) return false;
    const lastColon = hostHeader.lastIndexOf(':');
    const hasPort = lastColon > hostHeader.lastIndexOf(']');
    const host = hasPort ? hostHeader.slice(0, lastColon) : hostHeader;
    const givenPort = hasPort ? hostHeader.slice(lastColon + 1) : '';

    if (!LOOPBACK_HOSTS.has(host)) return false;
    return givenPort === '' || givenPort === String(port);
}

/** Reads a JSON request body, with a cap so a stray upload cannot exhaust memory. */
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', chunk => {
            raw += chunk;
            if (raw.length > 64 * 1024) {
                reject(new UserError('Request body too large.'));
                req.destroy();
            }
        });
        req.on('end', () => {
            if (!raw) return resolve({});
            try {
                resolve(JSON.parse(raw));
            } catch (err) {
                reject(new UserError('Could not parse the request body as JSON.'));
            }
        });
        req.on('error', reject);
    });
}

/** Accepts a byte count, a size string like "10GB", or null/"" to mean no limit. */
function toBytes(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value < 0) throw new UserError('Invalid data limit.');
        return Math.floor(value);
    }
    return parseBytes(String(value));
}

function renderQr(text) {
    return new Promise(resolve => {
        qrcode.generate(text, { small: true }, code => resolve(code));
    });
}

/**
 * Builds the request handler. Exported separately from start() so tests can
 * drive it without binding a port.
 */
function createHandler({ client, domain, token, port }) {
    const host = () => domain || client.hostname;

    async function state() {
        const [keys, transferred, server] = await Promise.all([
            client.listKeys(),
            client.getTransferMetrics(),
            client.getServerInfo().catch(() => null),
        ]);

        return {
            host: host(),
            serverName: server && server.name ? server.name : null,
            serverLimitBytes: server && server.accessKeyDataLimit
                ? server.accessKeyDataLimit.bytes
                : null,
            keys: keys.map(key => ({
                id: key.id,
                name: key.name || '',
                port: key.port,
                dataLimitBytes: key.dataLimit ? key.dataLimit.bytes : null,
                bytes: transferred[key.id] || 0,
                accessUrl: rewriteAccessUrl(key.accessUrl, client.hostname, host()),
            })),
        };
    }

    const routes = [
        ['GET', /^\/api\/state$/, () => state()],

        ['POST', /^\/api\/keys$/, async (m, body) => {
            const key = await client.createKey((body.name || '').trim());
            const limit = toBytes(body.limitBytes);
            if (limit !== null && key) await client.setKeyDataLimit(key.id, limit);
            return state();
        }],

        ['DELETE', /^\/api\/keys\/([^/]+)$/, async m => {
            await client.removeKey(decodeURIComponent(m[1]));
            return state();
        }],

        ['PUT', /^\/api\/keys\/([^/]+)\/name$/, async (m, body) => {
            const name = (body.name || '').trim();
            if (!name) throw new UserError('A key name cannot be empty.');
            await client.renameKey(decodeURIComponent(m[1]), name);
            return state();
        }],

        ['PUT', /^\/api\/keys\/([^/]+)\/limit$/, async (m, body) => {
            const id = decodeURIComponent(m[1]);
            const bytes = toBytes(body.bytes);
            if (bytes === null) await client.clearKeyDataLimit(id);
            else await client.setKeyDataLimit(id, bytes);
            return state();
        }],

        ['PUT', /^\/api\/server\/limit$/, async (m, body) => {
            const bytes = toBytes(body.bytes);
            if (bytes === null) await client.clearServerDataLimit();
            else await client.setServerDataLimit(bytes);
            return state();
        }],

        ['GET', /^\/api\/keys\/([^/]+)\/qr$/, async m => {
            const id = decodeURIComponent(m[1]);
            const keys = await client.listKeys();
            const key = keys.find(k => String(k.id) === id);
            if (!key) throw new UserError(`No key with id "${id}".`);
            const url = rewriteAccessUrl(key.accessUrl, client.hostname, host());
            return { qr: await renderQr(url), accessUrl: url, name: key.name || '' };
        }],
    ];

    return async function handle(req, res) {
        const send = (status, body, type = 'application/json') => {
            const payload = type === 'application/json' ? JSON.stringify(body) : body;
            res.writeHead(status, {
                'Content-Type': `${type}; charset=utf-8`,
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
                // The page is entirely self-contained; forbid any outside loading.
                // connect-src must be explicit: it falls back to default-src,
                // and 'none' would block the page's own fetch calls.
                'Content-Security-Policy':
                    "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; " +
                    "script-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'",
                'Referrer-Policy': 'no-referrer',
            });
            res.end(payload);
        };

        if (!hostIsLoopback(req.headers.host, port)) {
            return send(403, { error: 'This interface is only reachable on localhost.' });
        }

        const path = (req.url || '/').split('?')[0];

        if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
            return send(200, page(), 'text/html');
        }

        if (!path.startsWith('/api/')) {
            return send(404, { error: 'Not found.' });
        }

        // Constant-time compare so a wrong token cannot be guessed by timing.
        const given = String(req.headers['x-auth-token'] || '');
        const expected = Buffer.from(token);
        const actual = Buffer.from(given);
        if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
            return send(401, { error: 'Missing or invalid token. Reopen the URL printed in the terminal.' });
        }

        for (const [method, pattern, run] of routes) {
            const match = pattern.exec(path);
            if (!match) continue;
            if (req.method !== method) return send(405, { error: 'Method not allowed.' });

            try {
                const body = method === 'GET' || method === 'DELETE' ? {} : await readJsonBody(req);
                return send(200, await run(match, body));
            } catch (err) {
                const known = err instanceof UserError;
                if (!known) console.error(err);
                return send(known ? 400 : 500, { error: known ? err.message : 'Something went wrong.' });
            }
        }

        return send(404, { error: 'Not found.' });
    };
}

/** Starts the UI and resolves with { server, url, port }. */
async function start({ client, managementApiUrl, certSha256, domain, port = 8787 }) {
    if (!client) client = new OutlineClient(managementApiUrl, certSha256);
    const token = crypto.randomBytes(24).toString('hex');

    // Built after listen(), because the Host check compares against the port we
    // actually got — with port 0 the kernel picks one, and a handler built from
    // the requested port would reject every request.
    let handler;
    const server = http.createServer((req, res) => {
        handler(req, res).catch(err => {
            console.error(err);
            if (!res.headersSent) res.writeHead(500);
            res.end();
        });
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        // Loopback only: never expose an admin interface on every interface.
        server.listen(port, '127.0.0.1', resolve);
    });

    const actualPort = server.address().port;
    handler = createHandler({ client, domain, token, port: actualPort });
    return { server, port: actualPort, url: `http://127.0.0.1:${actualPort}/?t=${token}`, token };
}

module.exports = { start, createHandler, hostIsLoopback, toBytes };
