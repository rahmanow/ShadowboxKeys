#!/usr/bin/env node
'use strict';

/**
 * End-to-end check against a real Outline install.
 *
 * The rest of the suite proves the pieces; this proves the contract that
 * matters and cannot be faked: that the genuine install_server.sh, run over
 * SSH on a real Linux host, produces something shadowtools can read, register
 * and manage. Everything about that contract lives in Outline's script rather
 * than in this repository, so it can change without anything here failing.
 *
 * Not part of `npm test`. It needs Docker, reaches the network, pulls the
 * Shadowbox image and takes a few minutes. Run it deliberately:
 *
 *     npm run verify:install
 *
 * The stand-in is a privileged Debian container with sshd and a working Docker
 * daemon - what a fresh VPS gives you and what the installer needs. What it
 * cannot reproduce is a provider's networking: firewall defaults, and whether
 * the ports are reachable from outside. Those need a real host.
 */

const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const IMAGE = 'shadowtools-vps';
const CONTAINER = 'shadowtools-vps-verify';
const SSH_PORT = 22023;
const API_PORT = 41443;
const KEYS_PORT = 41444;
const PASSWORD = 'vpstestpassword';

const here = __dirname;
const root = path.resolve(here, '..', '..');

let passed = 0;
const check = (label, condition, detail) => {
    if (condition) {
        console.log(`  ok    ${label}`);
        passed++;
        return;
    }
    console.log(`  FAIL  ${label}${detail ? ' - ' + detail : ''}`);
    process.exitCode = 1;
};

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function docker(...args) {
    const result = sh('docker', args);
    if (result.error) throw new Error(`docker: ${result.error.message}`);
    return result;
}

function teardown() {
    docker('rm', '-f', CONTAINER);
}

async function main() {
    if (docker('info').status !== 0) {
        console.error('Docker is not running. Start it and try again.');
        process.exit(1);
    }

    // A scratch config, so a real one is never touched.
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowtools-verify-'));
    process.env.SHADOWTOOLS_CONFIG = path.join(configDir, 'config.json');

    const { connect, install, fingerprint } = require(path.join(root, 'lib', 'provision'));
    const { createStore, parseAccessCode } = require(path.join(root, 'lib', 'config'));
    const { createRegistry } = require(path.join(root, 'lib', 'registry'));
    const { OutlineClient } = require(path.join(root, 'lib', 'outline'));

    console.log('Building the stand-in host (Debian, sshd, dockerd)...');
    teardown();
    if (docker('build', '-q', '-t', IMAGE, here).status !== 0) {
        throw new Error('could not build the fixture image');
    }

    if (docker('run', '-d', '--privileged', '--name', CONTAINER,
        '-p', `${SSH_PORT}:22`, '-p', `${API_PORT}:${API_PORT}`, '-p', `${KEYS_PORT}:${KEYS_PORT}`,
        IMAGE).status !== 0) {
        throw new Error('could not start the fixture container');
    }

    try {
        process.stdout.write('Waiting for dockerd and sshd inside it');
        let ready = false;
        for (let i = 0; i < 60 && !ready; i++) {
            await sleep(1000);
            process.stdout.write('.');
            ready = docker('exec', CONTAINER, 'docker', 'info').status === 0;
        }
        console.log(ready ? ' ready' : ' NOT ready');
        if (!ready) throw new Error('the inner Docker daemon never came up');

        console.log('\nProvisioning over SSH with the real Outline installer.');
        console.log('(pulls the Shadowbox image; expect a few minutes)\n');

        // The fingerprint the tool reports must be the one OpenSSH reports,
        // because comparing them is exactly what a user is told to do.
        let reported = null;
        const client = await connect({
            host: '127.0.0.1', port: SSH_PORT, username: 'root', password: PASSWORD,
            onUnknownHost: info => { reported = info.fingerprint; return true; },
        });

        const keyscan = sh('bash', ['-c',
            `ssh-keyscan -p ${SSH_PORT} -t ssh-ed25519 127.0.0.1 2>/dev/null | ssh-keygen -lf - 2>/dev/null`]);
        const fromOpenssh = (keyscan.stdout || '').trim().split(/\s+/)[1] || '(none)';
        check('the host fingerprint matches ssh-keyscan', reported === fromOpenssh,
            `tool ${reported} vs openssh ${fromOpenssh}`);

        const { accessCode, output } = await install(client, {
            hostname: '127.0.0.1', apiPort: API_PORT, keysPort: KEYS_PORT,
            onOutput: chunk => process.stdout.write(chunk),
        });
        client.end();

        console.log('\nChecking what came back:\n');

        check('the installer reported success', /CONGRATULATIONS/.test(output));
        check('an access code was extracted', Boolean(accessCode));

        const parsed = parseAccessCode(accessCode);
        check('it parses with the ordinary parser', Boolean(parsed.apiUrl));
        check('it carries a certificate fingerprint', parsed.certSha256.length === 64,
            `got ${parsed.certSha256.length} characters`);

        // Registering it is the whole point: a provisioned server has to be
        // indistinguishable from one added by hand.
        const registry = createRegistry({ store: createStore() });
        const id = registry.add({ name: 'verify', accessCode });
        const saved = registry.list().find(server => server.id === id);
        check('it registers like a hand-pasted server', Boolean(saved) && saved.certPinned);

        // The pinned fingerprint has to be the certificate actually served.
        const live = sh('bash', ['-c',
            `echo | openssl s_client -connect 127.0.0.1:${API_PORT} 2>/dev/null ` +
            '| openssl x509 -noout -fingerprint -sha256 | sed "s/.*=//;s/://g"']);
        check('the pinned fingerprint is the certificate served',
            (live.stdout || '').trim().toLowerCase() === parsed.certSha256.toLowerCase());

        const outline = registry.clientById(id).client;
        const before = await outline.listKeys();
        check('the management API answers through the pin', Array.isArray(before));

        const created = await outline.createKey('verify-key');
        check('a key can be created', Boolean(created && created.id));
        const after = await outline.listKeys();
        check('the new key is listed', after.length === before.length + 1);
        check('the key has a usable access URL', /^ss:\/\//.test(created.accessUrl || ''),
            created.accessUrl);

        // Pinning has to refuse the wrong certificate, or it is decoration.
        let refused = false;
        try {
            await new OutlineClient(parsed.apiUrl, 'a'.repeat(64)).listKeys();
        } catch (err) {
            refused = /unexpected TLS certificate/.test(err.message);
        }
        check('a wrong fingerprint is refused', refused);

        await outline.removeKey(created.id);
        check('a key can be removed', (await outline.listKeys()).length === before.length);
    } finally {
        teardown();
        fs.rmSync(configDir, { recursive: true, force: true });
    }

    console.log(`\n${passed} checks passed${process.exitCode ? ', with failures above' : ''}.`);
}

main().catch(err => {
    console.error(`\nverification failed: ${err.message}`);
    teardown();
    process.exit(1);
});
