'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    extractAccessCode,
    fingerprint,
    forgetHost,
    installCommand,
    knownHost,
    knownHostsPath,
    rememberHost,
} = require('../lib/provision');
const { parseAccessCode } = require('../lib/config');
const { UserError } = require('../lib/errors');

/** Points the config helpers at a scratch directory for one test. */
function tempConfigHome(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowtools-prov-'));
    const previous = process.env.SHADOWTOOLS_CONFIG;
    process.env.SHADOWTOOLS_CONFIG = path.join(dir, 'config.json');
    t.after(() => {
        if (previous === undefined) delete process.env.SHADOWTOOLS_CONFIG;
        else process.env.SHADOWTOOLS_CONFIG = previous;
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return dir;
}

/* -------------------------------------------------------------------------
 * Reading the installer's result.
 * ---------------------------------------------------------------------- */

// install_server.sh wraps the access code in ANSI colour before printing it.
const ESC = String.fromCharCode(27);
const GREEN = ESC + '[1;32m';
const RESET = ESC + '[0m';

const API_URL = 'https://203.0.113.9:41234/Xy7QpLmNbVcZaSdF';
const CERT = 'E3823F9BB490D35487EE013EC7D23A3662F76B95EB01A40F4851905152F5A584';
const CODE = '{"apiUrl":"' + API_URL + '","certSha256":"' + CERT + '"}';

const REAL_TAIL = [
    'Creating persistent state dir ................ OK',
    'Starting Shadowbox ........................... OK',
    '',
    'CONGRATULATIONS! Your Outline server is up and running.',
    '',
    'To manage your Outline server, please copy the following line (including curly',
    'brackets) into Step 2 of the Outline Manager interface:',
    '',
    GREEN + CODE + RESET,
    '',
    'If you have connection problems, it may be that your router or cloud provider',
    'blocks inbound connections, even though your machine seems to allow them.',
].join('\n');

test("the access code is read out of the installer's real output", () => {
    const code = extractAccessCode(REAL_TAIL);
    assert.ok(code, 'nothing was extracted');
    // The colour codes sit outside the braces, so the JSON survives whole.
    assert.ok(!code.includes(ESC), 'an escape sequence leaked into the code');
    assert.strictEqual(code, CODE);
});

test('what the installer prints feeds straight into the existing parser', () => {
    // The whole point: a provisioned server joins the registry by the same
    // route as one whose code was pasted by hand.
    const parsed = parseAccessCode(extractAccessCode(REAL_TAIL));
    assert.strictEqual(parsed.apiUrl, API_URL);
    assert.strictEqual(parsed.certSha256.length, 64);
});

test('the last access code wins, so an example earlier in the log cannot', () => {
    const output = REAL_TAIL + '\nrerun\n{"apiUrl":"https://198.51.100.1:1/Second","certSha256":""}';
    assert.match(extractAccessCode(output), /Second/);
});

test('output with no access code reads as no access code', () => {
    for (const junk of ['', 'Installing...\nfailed\n', '{"apiUrl":"missing the other field"}']) {
        assert.strictEqual(extractAccessCode(junk), null, JSON.stringify(junk));
    }
});

/* -------------------------------------------------------------------------
 * The command that reaches a root shell.
 * ---------------------------------------------------------------------- */

test('the install command passes the flags the installer documents', () => {
    const command = installCommand('/tmp/x.sh', {
        hostname: 'vpn.example.org', apiPort: 41234, keysPort: 443,
    });
    assert.match(command, /--hostname vpn\.example\.org/);
    assert.match(command, /--api-port 41234/);
    assert.match(command, /--keys-port 443/);
});

test('the install command works as root and as a sudoer, without hanging', () => {
    const command = installCommand('/tmp/x.sh');
    assert.match(command, /id -u/, 'should detect root rather than assume');
    // -n matters: without it, a sudo password prompt blocks forever on a
    // connection with no pty attached.
    assert.match(command, /sudo -n /);
});

test('anything reaching the shell is validated, not quoted and hoped for', () => {
    // The hostname is interpolated into a command line that runs as root. The
    // defence is refusing anything that is not a hostname, so no shell
    // metacharacter is ever present to matter.
    for (const bad of [
        'example.com; rm -rf /',
        '$(curl evil.example.com)',
        'a b',
        'x|y',
        "'",
        'x&&y',
        'x\nid',
    ]) {
        assert.throws(() => installCommand('/tmp/x.sh', { hostname: bad }), UserError, bad);
    }
    for (const good of ['vpn.example.com', '203.0.113.9', 'a-b.example.co.uk', '2001:db8::1']) {
        assert.doesNotThrow(() => installCommand('/tmp/x.sh', { hostname: good }), good);
    }
});

test('ports are validated as ports, including the falsy one', () => {
    // 0 is the interesting case: it is falsy, so a truthiness check would drop
    // it silently and hand back a server on a port nobody asked for.
    for (const bad of [0, '0', 65536, -1, 'http', '80; id', 1.5]) {
        assert.throws(() => installCommand('/tmp/x.sh', { apiPort: bad }), UserError, String(bad));
        assert.throws(() => installCommand('/tmp/x.sh', { keysPort: bad }), UserError, String(bad));
    }

    // Genuinely absent still means "installer's choice", with no flag emitted.
    for (const absent of [undefined, null, '']) {
        const command = installCommand('/tmp/x.sh', { apiPort: absent, keysPort: absent });
        assert.ok(!command.includes('--api-port'), String(absent));
        assert.ok(!command.includes('--keys-port'), String(absent));
    }
});

/* -------------------------------------------------------------------------
 * Host keys.
 * ---------------------------------------------------------------------- */

test('the fingerprint matches the form OpenSSH prints', () => {
    // Users are told to compare this against their provider's console or
    // ssh-keyscan, so it has to be the format those produce: unpadded base64
    // SHA-256, prefixed.
    const print = fingerprint(Buffer.from('a host key'));
    assert.match(print, /^SHA256:[A-Za-z0-9+/]+$/);
    assert.ok(!print.endsWith('='), 'OpenSSH strips base64 padding');
});

test('a host is remembered and read back', async t => {
    tempConfigHome(t);
    assert.strictEqual(knownHost('198.51.100.9:22'), null);

    rememberHost('198.51.100.9:22', 'SHA256:abc');
    assert.strictEqual(knownHost('198.51.100.9:22'), 'SHA256:abc');
    // A different port is a different host, not the same one.
    assert.strictEqual(knownHost('198.51.100.9:2222'), null);
});

test('the known-hosts file is readable only by its owner', async t => {
    tempConfigHome(t);
    rememberHost('198.51.100.9:22', 'SHA256:abc');
    assert.strictEqual(fs.statSync(knownHostsPath()).mode & 0o777, 0o600);
});

test('forgetting a host removes only that host', async t => {
    tempConfigHome(t);
    rememberHost('a:22', 'SHA256:one');
    rememberHost('b:22', 'SHA256:two');

    assert.strictEqual(forgetHost('a:22'), true);
    assert.strictEqual(knownHost('a:22'), null);
    assert.strictEqual(knownHost('b:22'), 'SHA256:two');
    assert.strictEqual(forgetHost('nobody:22'), false);
});
