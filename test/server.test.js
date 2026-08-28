'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { createHandler, hostIsLoopback, toBytes } = require('../lib/server');
const { createRegistry } = require('../lib/registry');
const { createMemoryStore } = require('../lib/config');
const { UserError } = require('../lib/errors');

const GB = 1024 ** 3;
const TOKEN = 'a'.repeat(48);

test('hostIsLoopback accepts the loopback interface, with or without the port', () => {
    for (const host of ['127.0.0.1:8787', '127.0.0.1', 'localhost:8787', 'localhost', '[::1]:8787']) {
        assert.strictEqual(hostIsLoopback(host, 8787), true, host);
    }
});

test('hostIsLoopback rejects anything else, which is what blocks DNS rebinding', () => {
    for (const host of ['evil.example.com', 'evil.example.com:8787', '10.0.0.5:8787', '', undefined]) {
        assert.strictEqual(hostIsLoopback(host, 8787), false, String(host));
    }
});

test('hostIsLoopback rejects a loopback name carrying someone else\'s port', () => {
    assert.strictEqual(hostIsLoopback('127.0.0.1:9999', 8787), false);
});

test('toBytes accepts sizes, byte counts and "no limit"', () => {
    assert.strictEqual(toBytes('10GB'), 10 * GB);
    assert.strictEqual(toBytes(1024), 1024);
    assert.strictEqual(toBytes(null), null);
    assert.strictEqual(toBytes(''), null);
    assert.strictEqual(toBytes(undefined), null);
});

test('toBytes rejects sizes it cannot parse', () => {
    assert.throws(() => toBytes('nonsense'), UserError);
    assert.throws(() => toBytes(-5), UserError);
    assert.throws(() => toBytes(Infinity), UserError);
});

/** A stand-in for OutlineClient, so these tests need no Outline server. */
function fakeClient() {
    const calls = [];
    let nextId = 2;
    const keys = [
        { id: '0', name: 'Alice', port: 443, accessUrl: 'ss://a@10.0.0.1:443/?outline=1', dataLimit: { bytes: 10 * GB } },
        { id: '1', name: 'Bob', port: 444, accessUrl: 'ss://b@10.0.0.1:444/?outline=1' },
    ];
    let serverLimit = null;

    const find = id => keys.find(k => k.id === id);

    return {
        calls,
        hostname: '10.0.0.1',
        async listKeys() { return keys.map(k => ({ ...k })); },
        async getTransferMetrics() { return { '0': 3 * GB, '1': 0 }; },
        async getServerInfo() {
            return { name: 'Test', accessKeyDataLimit: serverLimit ? { bytes: serverLimit } : undefined };
        },
        async createKey(name) {
            const key = { id: String(nextId++), name, port: 500, accessUrl: `ss://n@10.0.0.1:500/?outline=1` };
            keys.push(key);
            calls.push(['create', name]);
            return key;
        },
        async removeKey(id) {
            calls.push(['remove', id]);
            const i = keys.findIndex(k => k.id === id);
            if (i >= 0) keys.splice(i, 1);
        },
        async renameKey(id, name) { calls.push(['rename', id, name]); const k = find(id); if (k) k.name = name; },
        async setKeyDataLimit(id, bytes) {
            calls.push(['limit', id, bytes]);
            const k = find(id); if (k) k.dataLimit = { bytes };
        },
        async clearKeyDataLimit(id) { calls.push(['clearLimit', id]); const k = find(id); if (k) delete k.dataLimit; },
        async setServerDataLimit(bytes) { calls.push(['serverLimit', bytes]); serverLimit = bytes; },
        async clearServerDataLimit() { calls.push(['clearServerLimit']); serverLimit = null; },
    };
}

/** Starts the handler on a real socket so headers and status codes are exercised. */
async function startServer(client, domain) {
    let handler;
    const server = http.createServer((req, res) => {
        handler(req, res).catch(() => { res.writeHead(500); res.end(); });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    handler = createHandler({ client, domain, token: TOKEN, port });
    return { server, port };
}

/** One request, with full control over headers including Host. */
function request(port, method, path, { token, host, body } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const headers = {};
        if (token !== null) headers['X-Auth-Token'] = token === undefined ? TOKEN : token;
        if (host) headers.Host = host;
        if (payload) headers['Content-Type'] = 'application/json';

        const req = http.request({ host: '127.0.0.1', port, method, path, headers }, res => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', c => (text += c));
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(text); } catch (err) { /* HTML or empty */ }
                resolve({ status: res.statusCode, headers: res.headers, text, json });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

test('web interface', async t => {
    const client = fakeClient();
    const { server, port } = await startServer(client, 'vpn.example.com');
    const call = (method, path, opts) => request(port, method, path, opts);

    try {
        await t.test('serves the page without a token', async () => {
            const res = await call('GET', '/', { token: null });
            assert.strictEqual(res.status, 200);
            assert.match(res.headers['content-type'], /text\/html/);
            assert.match(res.text, /<title>shadowtools<\/title>/);
        });

        await t.test('the page policy allows its own fetch calls', async () => {
            // connect-src falls back to default-src, so 'none' would break the UI.
            const res = await call('GET', '/', { token: null });
            assert.match(res.headers['content-security-policy'], /connect-src 'self'/);
        });

        await t.test('the API refuses a request with no token', async () => {
            const res = await call('GET', '/api/state', { token: null });
            assert.strictEqual(res.status, 401);
        });

        await t.test('the API refuses a wrong token of either length', async () => {
            for (const token of ['b'.repeat(48), 'short']) {
                const res = await call('GET', '/api/state', { token });
                assert.strictEqual(res.status, 401, token);
            }
        });

        await t.test('the API refuses a foreign Host header', async () => {
            const res = await call('GET', '/api/state', { host: 'evil.example.com' });
            assert.strictEqual(res.status, 403);
        });

        await t.test('state lists keys with usage and the configured domain', async () => {
            const res = await call('GET', '/api/state');
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.json.host, 'vpn.example.com');
            assert.strictEqual(res.json.keys.length, 2);
            assert.deepStrictEqual(res.json.keys[0], {
                id: '0', name: 'Alice', port: 443,
                dataLimitBytes: 10 * GB, bytes: 3 * GB,
                accessUrl: 'ss://a@vpn.example.com:443/?outline=1',
            });
            assert.strictEqual(res.json.keys[1].dataLimitBytes, null);
        });

        await t.test('creating a key applies an optional limit', async () => {
            const res = await call('POST', '/api/keys', { body: { name: 'Carol', limitBytes: '5GB' } });
            assert.strictEqual(res.status, 200);
            assert.deepStrictEqual(client.calls.at(-1), ['limit', '2', 5 * GB]);
            assert.strictEqual(res.json.keys.length, 3);
        });

        await t.test('renaming rejects an empty name', async () => {
            const res = await call('PUT', '/api/keys/0/name', { body: { name: '   ' } });
            assert.strictEqual(res.status, 400);
            assert.match(res.json.error, /cannot be empty/);
        });

        await t.test('a limit can be set and cleared', async () => {
            let res = await call('PUT', '/api/keys/1/limit', { body: { bytes: '2GB' } });
            assert.strictEqual(res.status, 200);
            assert.deepStrictEqual(client.calls.at(-1), ['limit', '1', 2 * GB]);

            res = await call('PUT', '/api/keys/1/limit', { body: { bytes: null } });
            assert.strictEqual(res.status, 200);
            assert.deepStrictEqual(client.calls.at(-1), ['clearLimit', '1']);
        });

        await t.test('the server-wide limit round-trips into state', async () => {
            let res = await call('PUT', '/api/server/limit', { body: { bytes: '100GB' } });
            assert.strictEqual(res.json.serverLimitBytes, 100 * GB);

            res = await call('PUT', '/api/server/limit', { body: { bytes: null } });
            assert.strictEqual(res.json.serverLimitBytes, null);
        });

        await t.test('an unparseable size is a clear 400, not a crash', async () => {
            const res = await call('PUT', '/api/keys/0/limit', { body: { bytes: 'nonsense' } });
            assert.strictEqual(res.status, 400);
            assert.match(res.json.error, /Could not understand the size/);
        });

        await t.test('the QR endpoint returns a code for the rewritten URL', async () => {
            const res = await call('GET', '/api/keys/0/qr');
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.json.accessUrl, 'ss://a@vpn.example.com:443/?outline=1');
            assert.ok(res.json.qr.includes('█'), 'expected block characters');
        });

        await t.test('the QR endpoint 400s on an unknown key', async () => {
            const res = await call('GET', '/api/keys/nope/qr');
            assert.strictEqual(res.status, 400);
        });

        await t.test('deleting removes the key', async () => {
            const res = await call('DELETE', '/api/keys/2');
            assert.strictEqual(res.status, 200);
            assert.deepStrictEqual(res.json.keys.map(k => k.id), ['0', '1']);
        });

        await t.test('unknown paths 404 and wrong methods 405', async () => {
            assert.strictEqual((await call('GET', '/api/nope')).status, 404);
            assert.strictEqual((await call('GET', '/nope', { token: null })).status, 404);
            assert.strictEqual((await call('POST', '/api/state')).status, 405);
        });

        await t.test('a malformed body is rejected without touching the server', async () => {
            const before = client.calls.length;
            const res = await new Promise((resolve, reject) => {
                const req = http.request({
                    host: '127.0.0.1', port, method: 'POST', path: '/api/keys',
                    headers: { 'X-Auth-Token': TOKEN, 'Content-Type': 'application/json' },
                }, r => {
                    let text = '';
                    r.on('data', c => (text += c));
                    r.on('end', () => resolve({ status: r.statusCode, text }));
                });
                req.on('error', reject);
                req.write('{not json');
                req.end();
            });
            assert.strictEqual(res.status, 400);
            assert.strictEqual(client.calls.length, before, 'no Outline call should have been made');
        });
    } finally {
        server.close();
    }
});

test('the interface falls back to the server hostname when no domain is set', async () => {
    const client = fakeClient();
    const { server, port } = await startServer(client, '');
    try {
        const res = await request(port, 'GET', '/api/state');
        assert.strictEqual(res.json.host, '10.0.0.1');
        assert.strictEqual(res.json.keys[0].accessUrl, 'ss://a@10.0.0.1:443/?outline=1');
    } finally {
        server.close();
    }
});

/* --------------------------------------------------------------------------
 * Server management, which is what turned the key list into a dashboard.
 * ------------------------------------------------------------------------ */

const API_A = 'https://1.2.3.4:16942/AaAaAaAaAa';
const API_B = 'https://5.6.7.8:16942/BbBbBbBbBb';

/** Starts the handler over a registry whose clients are the fake above. */
async function startDashboard({ env = null, clients = {} } = {}) {
    const registry = createRegistry({
        store: createMemoryStore(),
        env,
        clientFactory: server => {
            const host = new URL(server.apiUrl).hostname;
            if (clients[host]) return clients[host];
            // A server nobody stubbed stands in for one that cannot be reached.
            const fail = () => Promise.reject(new UserError('Could not reach the Outline server: timeout'));
            return {
                hostname: host,
                listKeys: fail, getTransferMetrics: fail, getServerInfo: fail,
            };
        },
    });

    let handler;
    const server = http.createServer((req, res) => {
        handler(req, res).catch(() => { res.writeHead(500); res.end(); });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    handler = createHandler({ registry, token: TOKEN, port });
    return { server, port, registry };
}

test('the dashboard manages servers', async t => {
    const client = fakeClient();
    const { server, port } = await startDashboard({ clients: { '1.2.3.4': client } });
    const call = (method, path, opts) => request(port, method, path, opts);
    let addedId;

    try {
        await t.test('state before any server is configured is empty, not an error', async () => {
            const res = await call('GET', '/api/state');
            assert.strictEqual(res.status, 200);
            assert.deepStrictEqual(res.json.servers, []);
            assert.strictEqual(res.json.activeServerId, null);
            assert.strictEqual(res.json.reachable, false);
            assert.deepStrictEqual(res.json.keys, []);
        });

        await t.test('a server added by access code becomes active immediately', async () => {
            const res = await call('POST', '/api/servers', {
                body: { name: 'Frankfurt', accessCode: API_A, domain: 'vpn.example.com' },
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.json.servers.length, 1);

            const [added] = res.json.servers;
            addedId = added.id;
            assert.strictEqual(added.active, true);
            assert.strictEqual(res.json.reachable, true);
            assert.strictEqual(res.json.host, 'vpn.example.com');
            assert.strictEqual(res.json.keys.length, 2);
        });

        await t.test('state never carries a server credential to the browser', async () => {
            const res = await call('GET', '/api/state');
            assert.ok(!res.text.includes('AaAaAaAaAa'), 'the access code leaked into state');
        });

        await t.test('the access code is served only by the endpoint that exists for it', async () => {
            const res = await call('GET', '/api/servers/' + addedId + '/access-code');
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.json.apiUrl, API_A);
        });

        await t.test('a rejected access code is a clear 400 and changes nothing', async () => {
            const res = await call('POST', '/api/servers', { body: { name: 'Bad', accessCode: 'nonsense' } });
            assert.strictEqual(res.status, 400);
            assert.match(res.json.error, /not a Management API URL/);
            assert.strictEqual((await call('GET', '/api/state')).json.servers.length, 1);
        });

        await t.test('editing a server updates the host used in access URLs', async () => {
            const res = await call('PUT', '/api/servers/' + addedId, { body: { domain: '' } });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.json.host, '1.2.3.4');
            assert.strictEqual(res.json.keys[0].accessUrl, 'ss://a@1.2.3.4:443/?outline=1');
        });

        await t.test('an unreachable server reports why instead of blanking the page', async () => {
            // Nothing stubs 5.6.7.8, so every Management API call fails.
            const res = await call('POST', '/api/servers', { body: { name: 'Broken', accessCode: API_B } });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.json.reachable, false);
            assert.match(res.json.unreachableReason, /Could not reach the Outline server/);
            assert.strictEqual(res.json.servers.length, 2, 'the servers list must survive the failure');
        });

        await t.test('switching back to a working server restores the keys', async () => {
            const res = await call('POST', '/api/servers/' + addedId + '/activate');
            assert.strictEqual(res.json.activeServerId, addedId);
            assert.strictEqual(res.json.reachable, true);
            assert.strictEqual(res.json.keys.length, 2);
        });

        await t.test('a key operation lands on the active server', async () => {
            const before = client.calls.length;
            await call('POST', '/api/keys', { body: { name: 'Dave' } });
            assert.deepStrictEqual(client.calls.at(-1), ['create', 'Dave']);
            assert.ok(client.calls.length > before);
        });

        await t.test('testing a server checks it without switching to it', async () => {
            const servers = (await call('GET', '/api/state')).json.servers;
            const broken = servers.find(entry => entry.name === 'Broken');

            const res = await call('POST', '/api/servers/' + broken.id + '/test');
            assert.strictEqual(res.status, 400);
            assert.match(res.json.error, /Could not reach/);

            const ok = await call('POST', '/api/servers/' + addedId + '/test');
            assert.strictEqual(ok.status, 200);
            assert.strictEqual(ok.json.name, 'Test');
            assert.strictEqual((await call('GET', '/api/state')).json.activeServerId, addedId);
        });

        await t.test('removing a server leaves the remaining one active', async () => {
            const servers = (await call('GET', '/api/state')).json.servers;
            const broken = servers.find(entry => entry.name === 'Broken');

            const res = await call('DELETE', '/api/servers/' + broken.id);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.json.servers.length, 1);
            assert.strictEqual(res.json.activeServerId, addedId);
        });

        await t.test('an unknown server id is a 400, not a crash', async () => {
            assert.strictEqual((await call('DELETE', '/api/servers/nope')).status, 400);
            assert.strictEqual((await call('POST', '/api/servers/nope/activate')).status, 400);
            assert.strictEqual((await call('GET', '/api/servers/nope/access-code')).status, 400);
        });

        await t.test('server routes still need the token and a loopback Host', async () => {
            assert.strictEqual((await call('GET', '/api/state', { token: null })).status, 401);
            assert.strictEqual(
                (await call('POST', '/api/servers', { host: 'evil.example.com', body: {} })).status, 403);
        });
    } finally {
        server.close();
    }
});

test('a server from the environment is offered but cannot be rewritten', async () => {
    const client = fakeClient();
    const { server, port } = await startDashboard({
        env: { apiUrl: API_A, domain: 'vpn.example.com' },
        clients: { '1.2.3.4': client },
    });

    try {
        const res = await request(port, 'GET', '/api/state');
        assert.strictEqual(res.json.servers.length, 1);
        assert.strictEqual(res.json.servers[0].source, 'env');
        assert.strictEqual(res.json.servers[0].editable, false);
        assert.strictEqual(res.json.host, 'vpn.example.com');

        const edit = await request(port, 'PUT', '/api/servers/env', { body: { name: 'Renamed' } });
        assert.strictEqual(edit.status, 400);
        assert.match(edit.json.error, /environment/);
    } finally {
        server.close();
    }
});

test('the QR endpoint returns a vector code as well as the terminal one', async () => {
    const client = fakeClient();
    const { server, port } = await startServer(client, 'vpn.example.com');
    try {
        const res = await request(port, 'GET', '/api/keys/0/qr');
        assert.strictEqual(res.status, 200);
        assert.ok(res.json.svgSize > 0, 'expected a module count');
        assert.match(res.json.svgPath, /^M\d+ \d+h/);
        // Nothing about the access URL may appear in the markup the page builds.
        assert.ok(!res.json.svgPath.includes('vpn.example.com'));
    } finally {
        server.close();
    }
});
