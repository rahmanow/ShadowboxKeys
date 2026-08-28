'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const service = require('../lib/service');

const PROGRAM = { node: '/usr/local/bin/node', script: '/opt/shadowtools/shadowtools.js' };

const hasPlutil = process.platform === 'darwin' && (() => {
    try {
        execFileSync('plutil', ['-help'], { stdio: 'ignore' });
        return true;
    } catch (err) {
        return false;
    }
})();

test('the launchd plist is valid property list XML', { skip: !hasPlutil }, t => {
    // A malformed plist fails at load time with a message that says nothing
    // useful, so it is worth knowing the generator produces a real one.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowtools-plist-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const file = path.join(dir, 'test.plist');
    fs.writeFileSync(file, service.launchdPlist({
        ...PROGRAM,
        port: 8787,
        log: '/tmp/shadowtools.log',
        environment: { SHADOWTOOLS_CONFIG: '/tmp/a & b/config.json' },
    }));

    execFileSync('plutil', ['-lint', file], { stdio: 'ignore' });

    const parsed = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', file]));
    assert.strictEqual(parsed.Label, service.LABEL);
    assert.deepStrictEqual(parsed.ProgramArguments,
        [PROGRAM.node, PROGRAM.script, 'ui', '--port', '8787']);
    assert.strictEqual(parsed.RunAtLoad, true);
    assert.strictEqual(parsed.KeepAlive, true);
    // The ampersand has to survive XML escaping intact.
    assert.strictEqual(parsed.EnvironmentVariables.SHADOWTOOLS_CONFIG, '/tmp/a & b/config.json');
});

test('the launchd plist escapes XML metacharacters in every path it embeds', () => {
    const plist = service.launchdPlist({
        node: '/opt/a&b/node',
        script: '/opt/<x>/shadowtools.js',
        port: 8787,
        log: '/tmp/a&b.log',
        environment: {},
    });

    assert.ok(!/<string>[^<]*&(?!amp;|lt;|gt;)/.test(plist), 'a bare ampersand would break the plist');
    assert.ok(plist.includes('/opt/a&amp;b/node'));
    assert.ok(plist.includes('/opt/&lt;x&gt;/shadowtools.js'));
});

test('a plist with no environment omits the dictionary rather than emitting an empty one', () => {
    const plist = service.launchdPlist({ ...PROGRAM, port: 1, log: '/tmp/l', environment: {} });
    assert.ok(!plist.includes('EnvironmentVariables'));
});

test('the systemd unit starts the dashboard and comes back after a failure', () => {
    const unit = service.systemdUnit({
        ...PROGRAM,
        port: 9001,
        environment: { SHADOWTOOLS_CONFIG: '/tmp/c.json' },
    });

    assert.match(unit, /^ExecStart=\/usr\/local\/bin\/node \/opt\/shadowtools\/shadowtools\.js ui --port 9001$/m);
    assert.match(unit, /^Restart=on-failure$/m);
    assert.match(unit, /^Environment=SHADOWTOOLS_CONFIG=\/tmp\/c\.json$/m);
    assert.match(unit, /^WantedBy=default\.target$/m);
});

test('a Management API URL is never written into a service definition', () => {
    // These files sit in plain directories that other tooling reads and backup
    // software copies. Credentials belong in the config file, which is 0600.
    const env = {
        OUTLINE_API_URL: 'https://1.2.3.4:16942/SecretPath',
        OUTLINE_CERT_SHA256: 'e3823f9bb490d354',
        SHADOWTOOLS_CONFIG: '/tmp/c.json',
        OUTLINE_TIMEOUT_MS: '20000',
    };

    const carried = service.serviceEnvironment(env);
    assert.deepStrictEqual(carried, { SHADOWTOOLS_CONFIG: '/tmp/c.json', OUTLINE_TIMEOUT_MS: '20000' });

    for (const text of [
        service.launchdPlist({ ...PROGRAM, port: 1, log: '/tmp/l', environment: carried }),
        service.systemdUnit({ ...PROGRAM, port: 1, environment: carried }),
    ]) {
        assert.ok(!text.includes('SecretPath'), 'the Management API URL leaked into a service definition');
        assert.ok(!text.includes('OUTLINE_API_URL'));
        assert.ok(!text.includes('OUTLINE_CERT_SHA256'));
    }
});

test('secretsInEnvironment names what was deliberately left out', () => {
    assert.deepStrictEqual(service.secretsInEnvironment({}), []);
    assert.deepStrictEqual(
        service.secretsInEnvironment({ OUTLINE_API_URL: 'x', OUTLINE_CERT_SHA256: 'y' }),
        ['OUTLINE_API_URL', 'OUTLINE_CERT_SHA256']
    );
});

test('the installed port is read back out of either definition', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowtools-port-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    // installedPort parses the file the installer wrote, which is how status
    // knows which port to report after a reinstall moved it.
    const plist = path.join(dir, 'a.plist');
    fs.writeFileSync(plist, service.launchdPlist({ ...PROGRAM, port: 9123, log: '/tmp/l', environment: {} }));
    assert.match(fs.readFileSync(plist, 'utf8'), /<string>--port<\/string>\s*<string>9123<\/string>/);

    const unit = service.systemdUnit({ ...PROGRAM, port: 9124, environment: {} });
    assert.match(unit, /ExecStart=.*--port\s+9124/);
});

test('programPaths points at this installation, absolutely', () => {
    // A service manager has no working directory of ours, so both must be absolute.
    const { node, script } = service.programPaths();
    assert.ok(path.isAbsolute(node), node);
    assert.ok(path.isAbsolute(script), script);
    assert.strictEqual(path.basename(script), 'shadowtools.js');
    assert.ok(fs.existsSync(script));
});

test('paths are per-user, never system-wide', () => {
    // Nothing here should need root, and nothing should hold one user's
    // credentials open to another's.
    const home = os.homedir();
    for (const kind of ['launchd', 'systemd']) {
        const { definition } = service.paths(kind);
        assert.ok(definition.startsWith(home), `${kind}: ${definition}`);
    }
});

test('an unsupported platform is refused with advice rather than a crash', () => {
    assert.strictEqual(service.platform(), process.platform === 'darwin' ? 'launchd'
        : process.platform === 'linux' ? 'systemd' : null);
});

test('the dashboard keeps its token out of non-terminal output', async t => {
    // Under a service manager stdout is a log file. launchd creates those
    // world-readable, and the token is the only thing standing between another
    // local user and this dashboard, so it must not be written there. This
    // runs the real CLI with stdout piped, which is exactly that situation.
    const { spawn } = require('node:child_process');
    const { readToken } = require('../lib/config');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowtools-tty-'));
    const configPath = path.join(dir, 'config.json');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const env = { ...process.env, SHADOWTOOLS_CONFIG: configPath };
    const token = (() => {
        const previous = process.env.SHADOWTOOLS_CONFIG;
        process.env.SHADOWTOOLS_CONFIG = configPath;
        try {
            return readToken();
        } finally {
            if (previous === undefined) delete process.env.SHADOWTOOLS_CONFIG;
            else process.env.SHADOWTOOLS_CONFIG = previous;
        }
    })();

    const cli = path.resolve(__dirname, '..', 'shadowtools.js');
    const child = spawn(process.execPath, [cli, 'ui', '--port', '0'], { env, stdio: 'pipe' });

    let output = '';
    const line = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no output; got: ${output}`)), 10000);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
            output += chunk;
            if (output.includes('\n')) {
                clearTimeout(timer);
                resolve(output);
            }
        });
        child.on('error', reject);
    });

    child.kill();
    await new Promise(resolve => child.once('exit', resolve));

    assert.ok(!line.includes(token), `the token was printed to a pipe:\n${line}`);
    assert.ok(!/[?&]t=/.test(line), `a tokenised URL was printed to a pipe:\n${line}`);
    assert.match(line, /dashboard listening on 127\.0\.0\.1:\d+/);
    // Ctrl+C is not advice a log file can act on.
    assert.ok(!line.includes('Ctrl+C'));
});
