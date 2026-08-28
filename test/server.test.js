'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { createHandler, hostIsLoopback, toBytes } = require('../lib/server');
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
            assert.match(res.text, /<title>Outline access keys<\/title>/);
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
