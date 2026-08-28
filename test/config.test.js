'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    createStore,
    normalizeConfig,
    parseAccessCode,
    redactApiUrl,
    ENV_SERVER_ID,
} = require('../lib/config');
const { UserError } = require('../lib/errors');

const API_URL = 'https://1.2.3.4:16942/AbCdEf123';
const FINGERPRINT = 'E3823F9BB490D35487EE013EC7D23A3662F76B95EB01A40F4851905152F5A584';

/** A scratch config path that is cleaned up with the test. */
function tempConfig(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowtools-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, 'nested', 'config.json');
}

test('parseAccessCode reads the JSON blob Outline Manager shows', () => {
    const code = `{"apiUrl":"${API_URL}","certSha256":"${FINGERPRINT}"}`;
    assert.deepStrictEqual(parseAccessCode(code), { apiUrl: API_URL, certSha256: FINGERPRINT });
});

test('parseAccessCode ignores prose pasted around the blob', () => {
    const code = `Here it is: {"apiUrl":"${API_URL}","certSha256":"${FINGERPRINT}"} — enjoy`;
    assert.strictEqual(parseAccessCode(code).apiUrl, API_URL);
});

test('parseAccessCode survives a URL wrapped across lines by a mail client', () => {
    const wrapped = `{"apiUrl":"https://1.2.3.4:16942/\n  AbCdEf123","certSha256":"${FINGERPRINT}"}`;
    assert.strictEqual(parseAccessCode(wrapped).apiUrl, API_URL);
});

test('parseAccessCode accepts a bare Management API URL, with no fingerprint', () => {
    assert.deepStrictEqual(parseAccessCode(`  ${API_URL}  `), { apiUrl: API_URL, certSha256: '' });
});

test('parseAccessCode drops a trailing slash so the same server is not saved twice', () => {
    assert.strictEqual(parseAccessCode(API_URL + '/').apiUrl, API_URL);
});

test('parseAccessCode refuses a URL with no secret path', () => {
    // The path is the admin secret; without it the URL cannot administer anything.
    assert.throws(() => parseAccessCode('https://1.2.3.4:16942'), /no secret path/);
    assert.throws(() => parseAccessCode('https://1.2.3.4:16942/'), /no secret path/);
});

test('parseAccessCode refuses plaintext http and unparseable input', () => {
    assert.throws(() => parseAccessCode('http://1.2.3.4:16942/AbC'), /must use https/);
    assert.throws(() => parseAccessCode('not a url'), UserError);
    assert.throws(() => parseAccessCode(''), UserError);
    assert.throws(() => parseAccessCode('{"apiUrl": broken}'), /could not be parsed/);
});

test('redactApiUrl keeps the host and only a stub of the secret', () => {
    assert.strictEqual(redactApiUrl(API_URL), 'https://1.2.3.4:16942/AbCd…');
    assert.strictEqual(redactApiUrl('nonsense'), '');
});

test('redactApiUrl never shows a whole secret, however short it is', () => {
    // A short secret must not slip through simply by fitting under the cap.
    for (const secret of ['a', 'ab', 'abcd', 'abcdef', 'abcdefghij']) {
        const shown = redactApiUrl(`https://1.2.3.4:16942/${secret}`);
        assert.ok(!shown.includes(secret), `"${secret}" survived redaction as ${shown}`);
    }
});

test('a store round-trips a config and creates its directory', async t => {
    const file = tempConfig(t);
    const store = createStore(file);

    assert.deepStrictEqual(store.load(), { version: 1, activeServerId: null, servers: [] });

    store.save({
        version: 1,
        activeServerId: 'abc',
        servers: [{ id: 'abc', name: 'Frankfurt', apiUrl: API_URL, certSha256: FINGERPRINT, domain: 'vpn.example.com' }],
    });

    const loaded = store.load();
    assert.strictEqual(loaded.activeServerId, 'abc');
    assert.strictEqual(loaded.servers.length, 1);
    assert.strictEqual(loaded.servers[0].domain, 'vpn.example.com');
});

test('a saved config is readable only by its owner', async t => {
    // It holds Management API URLs, so the file mode is the last line of defence
    // on a shared machine.
    const file = tempConfig(t);
    createStore(file).save({ version: 1, activeServerId: null, servers: [] });

    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
});

test('saving twice leaves no temporary files behind', async t => {
    const file = tempConfig(t);
    const store = createStore(file);
    store.save({ version: 1, activeServerId: null, servers: [] });
    store.save({ version: 1, activeServerId: null, servers: [] });

    assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['config.json']);
});

test('a corrupt config is reported rather than silently replaced', async t => {
    const file = tempConfig(t);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ this is not json');

    assert.throws(() => createStore(file).load(), /not valid JSON/);
    // The unreadable file must still be there to rescue by hand.
    assert.ok(fs.existsSync(file));
});

test('normalizeConfig drops entries with no credential and unknown active ids', () => {
    const config = normalizeConfig({
        activeServerId: 'gone',
        servers: [{ id: 'a', apiUrl: API_URL }, { name: 'no url' }, null],
    });

    assert.strictEqual(config.servers.length, 1);
    assert.strictEqual(config.activeServerId, null);
});

test('normalizeConfig keeps the environment server as a valid active choice', () => {
    // It is never written to the file, so it would otherwise be pruned on load
    // and the dashboard would forget which server you picked.
    const config = normalizeConfig({ activeServerId: ENV_SERVER_ID, servers: [] });
    assert.strictEqual(config.activeServerId, ENV_SERVER_ID);
});
