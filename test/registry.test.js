'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createRegistry } = require('../lib/registry');
const { createMemoryStore } = require('../lib/config');
const { UserError } = require('../lib/errors');

const API_A = 'https://1.2.3.4:16942/AaAaAa';
const API_B = 'https://5.6.7.8:16942/BbBbBb';
const FINGERPRINT = 'e3823f9bb490d35487ee013ec7d23a3662f76b95eb01a40f4851905152f5a584';

/** A registry whose clients are stubs, so nothing here touches the network. */
function registry({ env = null, servers = [], activeServerId = null } = {}) {
    return createRegistry({
        store: createMemoryStore({ version: 1, activeServerId, servers }),
        env,
        clientFactory: server => ({ hostname: new URL(server.apiUrl).hostname, apiUrl: server.apiUrl }),
    });
}

test('a registry with nothing configured lists nothing and says how to fix it', () => {
    const reg = registry();
    assert.deepStrictEqual(reg.list(), []);
    assert.strictEqual(reg.active(), null);
    assert.throws(() => reg.activeClient(), /No Outline server is configured/);
});

test('adding a server saves it, makes it active, and reports it', () => {
    const reg = registry();
    const id = reg.add({ name: 'Frankfurt', accessCode: API_A, domain: 'vpn.example.com' });

    const [server] = reg.list();
    assert.strictEqual(server.id, id);
    assert.strictEqual(server.name, 'Frankfurt');
    assert.strictEqual(server.host, '1.2.3.4');
    assert.strictEqual(server.domain, 'vpn.example.com');
    assert.strictEqual(server.active, true);
    assert.strictEqual(server.source, 'file');
    assert.strictEqual(server.editable, true);
});

test('a listed server carries a redacted URL, never the credential', () => {
    // The browser has no use for the secret, so it must not ride along in state.
    const reg = registry();
    reg.add({ name: 'Frankfurt', accessCode: API_A });

    const [server] = reg.list();
    assert.ok(!JSON.stringify(server).includes('AaAaAa'), 'the secret leaked into the server list');
    assert.match(server.apiUrlPreview, /^https:\/\/1\.2\.3\.4:16942\//);
});

test('the access code is available on its own, for the one place that needs it', () => {
    const reg = registry();
    const id = reg.add({ name: 'Frankfurt', accessCode: `{"apiUrl":"${API_A}","certSha256":"${FINGERPRINT}"}` });

    const code = reg.accessCode(id);
    assert.strictEqual(code.apiUrl, API_A);
    assert.strictEqual(code.certSha256, FINGERPRINT);
    assert.deepStrictEqual(JSON.parse(code.json), { apiUrl: API_A, certSha256: FINGERPRINT });
});

test('adding the same server twice is refused as the paste slip it is', () => {
    const reg = registry();
    reg.add({ name: 'Frankfurt', accessCode: API_A });
    assert.throws(() => reg.add({ name: 'Again', accessCode: API_A }), /already saved as "Frankfurt"/);
});

test('a bad access code is refused before anything is stored', () => {
    const reg = registry();
    assert.throws(() => reg.add({ name: 'Bad', accessCode: 'nonsense' }), UserError);
    assert.deepStrictEqual(reg.list(), []);
});

test('a bad fingerprint is caught when the server is added, not on first use', () => {
    // clientFactory here is the real one, so construction validates the digest.
    const reg = createRegistry({ store: createMemoryStore() });
    assert.throws(
        () => reg.add({ name: 'Bad', accessCode: `{"apiUrl":"${API_A}","certSha256":"nope"}` }),
        /not a SHA-256 certificate fingerprint/
    );
    assert.deepStrictEqual(reg.list(), []);
});

test('updating changes name, domain and the access code itself', () => {
    const reg = registry();
    const id = reg.add({ name: 'Old', accessCode: API_A });

    reg.update(id, { name: 'New', domain: 'vpn.example.com', accessCode: API_B });

    const [server] = reg.list();
    assert.strictEqual(server.name, 'New');
    assert.strictEqual(server.domain, 'vpn.example.com');
    assert.strictEqual(server.host, '5.6.7.8');
    assert.strictEqual(reg.accessCode(id).apiUrl, API_B);
});

test('updating without an access code keeps the existing one', () => {
    const reg = registry();
    const id = reg.add({ name: 'Old', accessCode: API_A });
    reg.update(id, { name: 'Renamed', accessCode: '' });
    assert.strictEqual(reg.accessCode(id).apiUrl, API_A);
});

test('replacing the access code retires the client built from the old one', () => {
    // A rebuilt server keeps its name but gets a new secret; a cached client
    // would keep talking to the address that no longer works.
    const reg = registry();
    const id = reg.add({ name: 'Frankfurt', accessCode: API_A });
    const before = reg.clientById(id).client;

    reg.update(id, { accessCode: API_B });
    const after = reg.clientById(id).client;

    assert.notStrictEqual(before, after);
    assert.strictEqual(after.hostname, '5.6.7.8');
});

test('removing a server clears it as the active choice', () => {
    const reg = registry();
    const first = reg.add({ name: 'One', accessCode: API_A });
    const second = reg.add({ name: 'Two', accessCode: API_B });
    assert.strictEqual(reg.active().id, second);

    reg.remove(second);
    assert.strictEqual(reg.list().length, 1);
    assert.strictEqual(reg.active().id, first);
});

test('an unknown server id is refused everywhere it can be given', () => {
    const reg = registry();
    for (const run of [
        () => reg.remove('nope'),
        () => reg.update('nope', { name: 'x' }),
        () => reg.activate('nope'),
        () => reg.accessCode('nope'),
        () => reg.clientById('nope'),
    ]) {
        assert.throws(run, /No configured server with id "nope"/);
    }
});

test('the environment server is listed first and is always available', () => {
    const reg = registry({ env: { apiUrl: API_A, domain: 'vpn.example.com' }, servers: [] });
    const [server] = reg.list();

    assert.strictEqual(server.id, 'env');
    assert.strictEqual(server.source, 'env');
    assert.strictEqual(server.active, true);
    assert.strictEqual(server.domain, 'vpn.example.com');
});

test('the environment server cannot be edited or removed from the dashboard', () => {
    const reg = registry({ env: { apiUrl: API_A } });
    assert.strictEqual(reg.list()[0].editable, false);

    for (const run of [() => reg.update('env', { name: 'x' }), () => reg.remove('env')]) {
        assert.throws(run, /comes from OUTLINE_API_URL in your environment/);
    }
});

test('a stored choice of active server outranks the environment', () => {
    // Picking a server in the dashboard has to stick, even though the
    // environment entry is the one listed first.
    const reg = registry({ env: { apiUrl: API_A } });
    const saved = reg.add({ name: 'Saved', accessCode: API_B });

    assert.strictEqual(reg.active().id, saved);

    reg.activate('env');
    assert.strictEqual(reg.active().id, 'env');
    assert.strictEqual(reg.list().find(server => server.id === saved).active, false);
});

test('an active id naming a server that is gone falls back rather than failing', () => {
    const reg = registry({ servers: [{ id: 'a', name: 'One', apiUrl: API_A }], activeServerId: 'vanished' });
    assert.strictEqual(reg.active().id, 'a');
});
