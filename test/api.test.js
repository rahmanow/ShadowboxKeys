'use strict';

const test = require('node:test');
const assert = require('node:assert');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { listKeys, getUsage, getKeys } = require('../index');

const GB = 1024 ** 3;

const hasOpenssl = (() => {
    try {
        execFileSync('openssl', ['version'], { stdio: 'ignore' });
        return true;
    } catch (err) {
        return false;
    }
})();

/** Creates a throwaway self-signed certificate, mimicking an Outline server's. */
function createCertificate() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowbox-keys-test-'));
    const keyPath = path.join(dir, 'key.pem');
    const certPath = path.join(dir, 'cert.pem');

    execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyPath, '-out', certPath,
        '-days', '1', '-subj', '/CN=localhost',
    ], { stdio: 'ignore' });

    const fingerprint = execFileSync('openssl', [
        'x509', '-in', certPath, '-noout', '-fingerprint', '-sha256',
    ]).toString().split('=')[1].trim();

    return {
        dir,
        fingerprint,
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath),
    };
}

const KEYS = [
    { id: '0', name: 'Alice', port: 443, accessUrl: 'ss://a@127.0.0.1:443/?outline=1', dataLimit: { bytes: 10 * GB } },
    { id: '1', name: '', port: 444, accessUrl: 'ss://b@127.0.0.1:444/?outline=1' },
];
const TRANSFER = { '0': 3 * GB, '1': 512 * 1024 ** 2 };

/** Serves just enough of the Management API for these tests. */
function startServer(credentials) {
    const server = https.createServer(credentials, (req, res) => {
        const body = req.url.endsWith('/metrics/transfer')
            ? { bytesTransferredByUserId: TRANSFER }
            : { accessKeys: KEYS };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
    });

    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

/** Runs fn with console.log captured, returning the lines it printed. */
async function captureOutput(fn) {
    const lines = [];
    const original = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
        await fn();
    } finally {
        console.log = original;
    }
    return lines;
}

test('programmatic API', { skip: hasOpenssl ? false : 'openssl is not available' }, async t => {
    const credentials = createCertificate();
    const server = await startServer(credentials);
    const apiUrl = `https://127.0.0.1:${server.address().port}/SecretPath`;

    try {
        await t.test('listKeys returns structured keys', async () => {
            const keys = await listKeys(apiUrl);
            assert.strictEqual(keys.length, 2);
            assert.deepStrictEqual(keys[0], {
                id: '0',
                name: 'Alice',
                port: 443,
                dataLimitBytes: 10 * GB,
                accessUrl: 'ss://a@127.0.0.1:443/?outline=1',
            });
            assert.strictEqual(keys[1].dataLimitBytes, null, 'a key with no cap reports null');
        });

        await t.test('listKeys rewrites the host when a domain is given', async () => {
            const keys = await listKeys(apiUrl, { domain: 'vpn.example.com' });
            assert.strictEqual(keys[0].accessUrl, 'ss://a@vpn.example.com:443/?outline=1');
        });

        await t.test('getUsage reports transfer per key, busiest first', async () => {
            const usage = await getUsage(apiUrl);
            assert.deepStrictEqual(usage.map(row => row.id), ['0', '1']);
            assert.strictEqual(usage[0].bytes, 3 * GB);
            assert.strictEqual(usage[0].dataLimitBytes, 10 * GB);
            assert.strictEqual(usage[1].dataLimitBytes, null);
        });

        await t.test('getKeys prints outline-br\'s format and returns the lines', async () => {
            let returned;
            const printed = await captureOutput(async () => {
                returned = await getKeys(apiUrl, 'vpn.example.com');
            });

            assert.deepStrictEqual(printed, [
                'Alice -> ss://a@vpn.example.com:443',
                'Noname -> ss://b@vpn.example.com:444',
            ]);
            assert.deepStrictEqual(returned, printed, 'the printed lines are also returned');
        });

        await t.test('getKeys keeps the server host when no domain is given', async () => {
            const printed = await captureOutput(() => getKeys(apiUrl));
            assert.deepStrictEqual(printed, [
                'Alice -> ss://a@127.0.0.1:443',
                'Noname -> ss://b@127.0.0.1:444',
            ]);
        });

        await t.test('a matching certificate fingerprint is accepted', async () => {
            const keys = await listKeys(apiUrl, { certSha256: credentials.fingerprint });
            assert.strictEqual(keys.length, 2);
        });

        await t.test('pinning still holds on requests after the first', async () => {
            // Regression: with TLS session resumption enabled, the second
            // connection skips the certificate exchange, so the check saw no
            // certificate and rejected the legitimate server. Any command
            // issuing more than one request hit this.
            const { certSha256 } = { certSha256: credentials.fingerprint };
            await listKeys(apiUrl, { certSha256 });
            await listKeys(apiUrl, { certSha256 });
            const usage = await getUsage(apiUrl, { certSha256 });
            assert.strictEqual(usage.length, 2);
        });

        await t.test('a mismatched certificate fingerprint is refused', async () => {
            await assert.rejects(
                listKeys(apiUrl, { certSha256: 'a'.repeat(64) }),
                /unexpected TLS certificate/
            );
        });
    } finally {
        server.close();
        fs.rmSync(credentials.dir, { recursive: true, force: true });
    }
});
