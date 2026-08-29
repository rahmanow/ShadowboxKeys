'use strict';

const http = require('http');
const crypto = require('crypto');
const qrcode = require('qrcode-terminal');

const { rewriteAccessUrl, parseBytes } = require('./format');
const { UserError } = require('./errors');
const { createRegistry, hostOf } = require('./registry');
const { createStore, createMemoryStore } = require('./config');
const { toSvgPath } = require('./qr');
const { createJobs } = require('./jobs');
const { page } = require('./web');

/**
 * A local admin dashboard over the Management API.
 *
 * Security shape, which matters more here than in most little servers: a
 * Management API URL is full administrative control of an Outline server, and
 * it never leaves this process — the browser talks only to this server, which
 * holds the credentials and proxies. Four things guard that:
 *
 *  - it listens on the loopback interface only, so nothing off-machine can
 *    reach it;
 *  - every /api request must carry a random token minted at startup and handed
 *    over in the printed URL, so another page in the same browser cannot drive
 *    it, and requiring a custom header means cross-origin attempts hit a CORS
 *    preflight that is never answered;
 *  - the Host header must name the loopback address, which is what stops DNS
 *    rebinding from turning an attacker's domain into a route to 127.0.0.1;
 *  - the dashboard is told which servers exist, but not their access codes.
 *    Those are sent only to the one endpoint that exists to reveal them, and
 *    only when someone clicks the button that asks for it.
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
 * Wraps an already-built client as a one-server registry.
 *
 * This is the seam the CLI's `ui` command and the tests come through when they
 * have a client in hand and no interest in the config file.
 */
function registryForClient(client, domain) {
    const apiUrl = client.baseUrl || `https://${client.hostname}/`;
    return createRegistry({
        store: createMemoryStore(),
        env: { apiUrl, domain, name: 'Environment' },
        clientFactory: () => client,
    });
}

/**
 * Builds the request handler. Exported separately from start() so tests can
 * drive it without binding a port.
 */
function createHandler({ registry, client, domain, token, port, jobs = createJobs() }) {
    if (!registry) {
        if (!client) throw new Error('createHandler needs either a registry or a client.');
        registry = registryForClient(client, domain);
    }

    const hostFor = server => server.domain || hostOf(server);

    /**
     * Everything the dashboard renders, in one response.
     *
     * A server that cannot be reached must not blank the page: the list of
     * servers is exactly what you need to fix it, so a failure is reported
     * alongside that list rather than as a failed request.
     */
    async function state() {
        const servers = registry.list();
        const base = {
            servers,
            configPath: registry.storePath,
            activeServerId: null,
            host: '',
            serverName: null,
            serverLimitBytes: null,
            keys: [],
            reachable: false,
            unreachableReason: null,
        };

        let active;
        let client;
        try {
            ({ server: active, client } = registry.activeClient());
        } catch (err) {
            // No server configured at all; the dashboard shows its empty state.
            return base;
        }

        base.activeServerId = active.id;
        base.host = hostFor(active);

        let keys;
        let transferred;
        let info;
        try {
            [keys, transferred, info] = await Promise.all([
                client.listKeys(),
                client.getTransferMetrics(),
                client.getServerInfo().catch(() => null),
            ]);
        } catch (err) {
            base.unreachableReason = err instanceof UserError ? err.message : 'Could not reach this server.';
            return base;
        }

        return {
            ...base,
            reachable: true,
            serverName: info && info.name ? info.name : null,
            serverLimitBytes: info && info.accessKeyDataLimit ? info.accessKeyDataLimit.bytes : null,
            keys: keys.map(key => ({
                id: key.id,
                name: key.name || '',
                port: key.port,
                dataLimitBytes: key.dataLimit ? key.dataLimit.bytes : null,
                bytes: transferred[key.id] || 0,
                accessUrl: rewriteAccessUrl(key.accessUrl, client.hostname, hostFor(active)),
            })),
        };
    }

    /** The active server's client, for the routes that act on access keys. */
    const withActive = () => registry.activeClient();

    const routes = [
        ['GET', /^\/api\/state$/, () => state()],

        // Access keys, always on the active server.
        ['POST', /^\/api\/keys$/, async (m, body) => {
            const { client } = withActive();
            const key = await client.createKey((body.name || '').trim());
            const limit = toBytes(body.limitBytes);
            if (limit !== null && key) await client.setKeyDataLimit(key.id, limit);
            return state();
        }],

        ['DELETE', /^\/api\/keys\/([^/]+)$/, async m => {
            const { client } = withActive();
            await client.removeKey(decodeURIComponent(m[1]));
            return state();
        }],

        ['PUT', /^\/api\/keys\/([^/]+)\/name$/, async (m, body) => {
            const name = (body.name || '').trim();
            if (!name) throw new UserError('A key name cannot be empty.');
            const { client } = withActive();
            await client.renameKey(decodeURIComponent(m[1]), name);
            return state();
        }],

        ['PUT', /^\/api\/keys\/([^/]+)\/limit$/, async (m, body) => {
            const id = decodeURIComponent(m[1]);
            const bytes = toBytes(body.bytes);
            const { client } = withActive();
            if (bytes === null) await client.clearKeyDataLimit(id);
            else await client.setKeyDataLimit(id, bytes);
            return state();
        }],

        ['PUT', /^\/api\/server\/limit$/, async (m, body) => {
            const bytes = toBytes(body.bytes);
            const { client } = withActive();
            if (bytes === null) await client.clearServerDataLimit();
            else await client.setServerDataLimit(bytes);
            return state();
        }],

        ['GET', /^\/api\/keys\/([^/]+)\/qr$/, async m => {
            const id = decodeURIComponent(m[1]);
            const { server, client } = withActive();
            const keys = await client.listKeys();
            const key = keys.find(k => String(k.id) === id);
            if (!key) throw new UserError(`No key with id "${id}".`);
            const url = rewriteAccessUrl(key.accessUrl, client.hostname, hostFor(server));
            const svg = toSvgPath(url);
            return {
                qr: await renderQr(url),
                svgPath: svg ? svg.path : null,
                svgSize: svg ? svg.size : 0,
                accessUrl: url,
                name: key.name || '',
            };
        }],

        // The servers themselves.
        ['POST', /^\/api\/servers$/, async (m, body) => {
            registry.add({ name: body.name, accessCode: body.accessCode, domain: body.domain });
            return state();
        }],

        ['PUT', /^\/api\/servers\/([^/]+)$/, async (m, body) => {
            registry.update(decodeURIComponent(m[1]), {
                name: body.name,
                domain: body.domain,
                accessCode: body.accessCode,
            });
            return state();
        }],

        ['DELETE', /^\/api\/servers\/([^/]+)$/, async m => {
            registry.remove(decodeURIComponent(m[1]));
            return state();
        }],

        ['POST', /^\/api\/servers\/([^/]+)\/activate$/, async m => {
            registry.activate(decodeURIComponent(m[1]));
            return state();
        }],

        // Deliberately its own endpoint; see registry.accessCode().
        ['GET', /^\/api\/servers\/([^/]+)\/access-code$/, async m =>
            registry.accessCode(decodeURIComponent(m[1]))],

        /*
         * Provisioning. Starting a run answers immediately with a job id and
         * then gets on with it, because installing Outline takes minutes — far
         * longer than a request should be held open, especially over the sort
         * of connection someone replacing a blocked server is likely on.
         */
        ['POST', /^\/api\/provision$/, async (m, body) => {
            const job = jobs.create();
            // Deliberately not awaited: the response goes back now.
            runProvision(job, body).catch(err => jobs.fail(job, err));
            return { jobId: job.id };
        }],

        ['GET', /^\/api\/provision\/([^/]+)$/, async m =>
            jobs.describe(decodeURIComponent(m[1]))],

        // The answer to a question the SSH handshake is parked on.
        ['POST', /^\/api\/provision\/([^/]+)\/host-key$/, async (m, body) => {
            jobs.answerHostKey(decodeURIComponent(m[1]), body.accept);
            return jobs.describe(decodeURIComponent(m[1]));
        }],

        // Checks one server without switching to it, so a credential can be
        // fixed and verified before it becomes the one everything else uses.
        ['POST', /^\/api\/servers\/([^/]+)\/test$/, async m => {
            const { client } = registry.clientById(decodeURIComponent(m[1]));
            const info = await client.getServerInfo();
            return {
                ok: true,
                name: (info && info.name) || null,
                version: (info && info.version) || null,
            };
        }],
    ];

    /**
     * One provisioning run: connect, install, register, create keys.
     *
     * The SSH credential lives in this function's arguments and nowhere else.
     * It is never put on the job, so it cannot reach the browser through the
     * polling endpoint, and never reaches the config file.
     */
    async function runProvision(job, body) {
        const provision = require('./provision');

        const host = String(body.host || '').trim();
        if (!host) throw new UserError('A server address is required.');

        const sshPort = body.sshPort ? Number(body.sshPort) : 22;
        if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
            throw new UserError(`"${body.sshPort}" is not a valid SSH port.`);
        }

        let client;
        try {
            jobs.append(job, `Connecting to ${body.username || 'root'}@${host}:${sshPort}\n`);
            client = await provision.connect({
                host,
                port: sshPort,
                username: String(body.username || 'root').trim() || 'root',
                password: body.password || undefined,
                privateKey: body.privateKey || undefined,
                passphrase: body.passphrase || undefined,
                // Hands the question to whoever is watching, and waits.
                onUnknownHost: info => jobs.awaitHostKey(job, info),
            });
        } catch (err) {
            return jobs.fail(job, err);
        }

        try {
            const { accessCode } = await provision.install(client, {
                hostname: body.hostname,
                apiPort: body.apiPort,
                keysPort: body.keysPort,
                onOutput: chunk => jobs.append(job, chunk),
            });

            const name = String(body.name || '').trim() || host;
            const serverId = registry.add({ name, accessCode, domain: body.domain || '' });

            // Recorded the instant it exists. Everything after this point is a
            // bonus, and must not be able to report the server as not created.
            jobs.registered(job, serverId);
            jobs.append(job, `\nSaved as "${name}".\n`);

            const wanted = body.keys === undefined || body.keys === '' ? 1 : Number(body.keys);
            if (!Number.isInteger(wanted) || wanted < 0 || wanted > 50) {
                return jobs.finish(job, {
                    warning: `The server was installed and saved, but "${body.keys}" is not a ` +
                        'number of keys between 0 and 50, so none were created.',
                });
            }

            const created = [];
            let warning = null;
            try {
                if (wanted > 0) {
                    const { server, client: outline } = registry.clientById(serverId);
                    for (let i = 1; i <= wanted; i++) {
                        const key = await outline.createKey(`key-${i}`);
                        created.push({
                            id: key.id,
                            name: key.name || '',
                            accessUrl: rewriteAccessUrl(
                                key.accessUrl, outline.hostname, server.domain || hostOf(server)
                            ),
                        });
                    }
                    jobs.append(job, `Created ${created.length} access key(s).\n`);
                }
            } catch (err) {
                // The server is installed and saved; only the keys did not
                // happen. Reporting that as a failed run would send someone
                // back to install a second copy on the same host.
                warning = 'The server was installed and saved, but creating access keys failed: ' +
                    (err instanceof UserError ? err.message : 'the management API did not answer.') +
                    ' Add keys from the Access keys section once it is reachable.';
                jobs.append(job, `\n${warning}\n`);
            }

            jobs.finish(job, { serverId, keys: created, warning });
        } catch (err) {
            jobs.fail(job, err);
        } finally {
            client.end();
        }
    }

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

        // Collect every route for this path first, so a path that exists under a
        // different method answers 405 rather than falling through to 404.
        const matched = routes
            .map(([method, pattern, run]) => ({ method, run, match: pattern.exec(path) }))
            .filter(route => route.match);

        if (matched.length) {
            const route = matched.find(candidate => candidate.method === req.method);
            if (!route) return send(405, { error: 'Method not allowed.' });

            try {
                const body = route.method === 'GET' || route.method === 'DELETE'
                    ? {}
                    : await readJsonBody(req);
                return send(200, await route.run(route.match, body));
            } catch (err) {
                const known = err instanceof UserError;
                if (!known) console.error(err);
                return send(known ? 400 : 500, { error: known ? err.message : 'Something went wrong.' });
            }
        }

        return send(404, { error: 'Not found.' });
    };
}

/**
 * Starts the dashboard and resolves with { server, url, port, token }.
 *
 * Passing a client keeps the old single-server behaviour; passing nothing lets
 * the registry read the config file, which is what makes it possible to open
 * the dashboard with no configuration at all and add the first server there.
 * Passing a token fixes the URL, so it can be bookmarked across restarts.
 */
async function start({ client, managementApiUrl, certSha256, domain, port = 8787, store, registry, token } = {}) {
    if (!registry) {
        if (client) {
            registry = registryForClient(client, domain);
        } else {
            registry = createRegistry({
                store: store || createStore(),
                env: managementApiUrl ? { apiUrl: managementApiUrl, certSha256, domain } : null,
            });
        }
    }

    // A caller that wants a URL people can bookmark — the background service,
    // and `ui` alongside it — passes the stored token. Anything else gets a
    // fresh one per run, which is the safer default when nobody is relying on
    // the URL surviving.
    if (!token) token = crypto.randomBytes(24).toString('hex');

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
    handler = createHandler({ registry, token, port: actualPort });
    return { server, port: actualPort, url: `http://127.0.0.1:${actualPort}/?t=${token}`, token };
}

module.exports = { start, createHandler, hostIsLoopback, toBytes, registryForClient };
