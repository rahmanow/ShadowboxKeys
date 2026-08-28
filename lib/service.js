'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { UserError } = require('./errors');

/**
 * Running the dashboard as a background service on this machine.
 *
 * The `ui` command serves the dashboard for as long as you keep a terminal
 * open, which is the wrong shape for a panel you want to leave running and
 * bookmark. This installs it with whichever service manager the platform
 * already has — launchd on macOS, systemd's user instance on Linux — so it
 * starts at login, comes back if it crashes, and answers on the same URL every
 * time.
 *
 * Nothing here runs as root and nothing installs system-wide: these are
 * per-user agents, which is the correct privilege level for something holding
 * one user's Outline credentials, and it means no step needs a password.
 *
 * The file-generating functions are pure so they can be tested without a
 * service manager present; everything that touches launchctl or systemctl is
 * kept to thin wrappers below them.
 */

const LABEL = 'com.rahmanow.shadowtools';
const UNIT = 'shadowtools';
const DEFAULT_PORT = 8787;

/** Which service manager to drive here, or null when there is none we support. */
function platform() {
    if (process.platform === 'darwin') return 'launchd';
    if (process.platform === 'linux') return 'systemd';
    return null;
}

function requirePlatform() {
    const kind = platform();
    if (!kind) {
        throw new UserError(
            `Running as a background service is not supported on ${process.platform}. ` +
            'Run "shadowtools ui" in a terminal instead, or start it with whatever ' +
            'service manager this system provides.'
        );
    }
    return kind;
}

/** Where the service definition, the log and the runtime state live. */
function paths(kind = platform()) {
    const home = os.homedir();
    if (kind === 'launchd') {
        return {
            definition: path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
            log: path.join(home, 'Library', 'Logs', 'shadowtools', 'service.log'),
        };
    }
    const base = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    return {
        definition: path.join(base, 'systemd', 'user', `${UNIT}.service`),
        // systemd collects stdout itself; `service logs` reads it back out.
        log: null,
    };
}

/** Escapes text for an XML text node, since a path may contain & or <. */
function xmlEscape(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * The environment the service runs with.
 *
 * Deliberately not everything in the current shell. A launchd plist and a
 * systemd unit are ordinary files that other tooling reads and back-up software
 * copies, so a Management API URL must never be written into one — the config
 * file exists for that, with a mode that suits it. Only settings that are
 * locations or tunables are carried over.
 */
function serviceEnvironment(env = process.env) {
    const carried = {};
    for (const name of ['SHADOWTOOLS_CONFIG', 'XDG_CONFIG_HOME', 'OUTLINE_TIMEOUT_MS']) {
        if (env[name]) carried[name] = env[name];
    }
    return carried;
}

/** The variables that configure a server directly, which must not be baked in. */
function secretsInEnvironment(env = process.env) {
    return ['OUTLINE_API_URL', 'OUTLINE_CERT_SHA256'].filter(name => env[name]);
}

/** A launchd agent that starts at login and is restarted if it exits. */
function launchdPlist({ node, script, port, log, environment }) {
    const entries = Object.entries(environment)
        .map(([key, value]) =>
            `\t\t<key>${xmlEscape(key)}</key>\n\t\t<string>${xmlEscape(value)}</string>`)
        .join('\n');

    const env = entries
        ? `\t<key>EnvironmentVariables</key>\n\t<dict>\n${entries}\n\t</dict>\n`
        : '';

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${xmlEscape(node)}</string>
\t\t<string>${xmlEscape(script)}</string>
\t\t<string>ui</string>
\t\t<string>--port</string>
\t\t<string>${port}</string>
\t</array>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
${env}\t<key>StandardOutPath</key>
\t<string>${xmlEscape(log)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xmlEscape(log)}</string>
\t<key>ProcessType</key>
\t<string>Background</string>
</dict>
</plist>
`;
}

/** A systemd user unit with the same lifecycle as the launchd agent above. */
function systemdUnit({ node, script, port, environment }) {
    const env = Object.entries(environment)
        .map(([key, value]) => `Environment=${key}=${value}`)
        .join('\n');

    return `[Unit]
Description=shadowtools dashboard
Documentation=https://github.com/rahmanow/shadowtools
After=network.target

[Service]
Type=simple
ExecStart=${node} ${script} ui --port ${port}
Restart=on-failure
RestartSec=5
${env}${env ? '\n' : ''}
[Install]
WantedBy=default.target
`;
}

/** Absolute paths to the running Node binary and this installation's CLI. */
function programPaths() {
    return {
        node: process.execPath,
        script: path.resolve(__dirname, '..', 'shadowtools.js'),
    };
}

/** Runs a service-manager command, returning its output and exit status. */
function run(command, args) {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    if (result.error && result.error.code === 'ENOENT') {
        throw new UserError(`${command} was not found, so the service cannot be managed here.`);
    }
    return {
        code: result.status,
        stdout: (result.stdout || '').trim(),
        stderr: (result.stderr || '').trim(),
    };
}

/** The port a previously written definition was installed with, if any. */
function installedPort(kind = platform()) {
    const { definition } = paths(kind);
    let text;
    try {
        text = fs.readFileSync(definition, 'utf8');
    } catch (err) {
        return null;
    }
    const match = kind === 'launchd'
        ? text.match(/<string>--port<\/string>\s*<string>(\d+)<\/string>/)
        : text.match(/ExecStart=.*--port\s+(\d+)/);
    return match ? Number(match[1]) : null;
}

function isInstalled(kind = platform()) {
    return fs.existsSync(paths(kind).definition);
}

/** Blocks for a moment, so a poll loop can stay synchronous like its callers. */
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Whether the service manager still has the job registered.
 *
 * Distinct from "running": launchd keeps a job registered but stopped, and a
 * job mid-unload is registered with no pid. Bootstrapping over either fails.
 */
function isLoaded(kind = platform()) {
    if (kind === 'launchd') return run('launchctl', ['list', LABEL]).code === 0;
    return run('systemctl', ['--user', 'is-active', UNIT]).stdout === 'active';
}

/**
 * Waits for an unload to actually finish.
 *
 * launchctl bootout returns as soon as it has asked, not when the job is gone,
 * so a bootstrap issued straight afterwards fails with a bare "Input/output
 * error" — which is what a restart used to do.
 */
function waitUntilUnloaded(kind = platform(), timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!isLoaded(kind)) return true;
        sleepSync(100);
    }
    return false;
}

function requireInstalled(kind) {
    if (!isInstalled(kind)) {
        throw new UserError('The service is not installed. Run "shadowtools service install" first.');
    }
}

/** Writes the service definition and hands it to the service manager. */
function install({ port = DEFAULT_PORT, env = process.env } = {}) {
    const kind = requirePlatform();
    const { definition, log } = paths(kind);
    const { node, script } = programPaths();
    const environment = serviceEnvironment(env);

    if (!fs.existsSync(script)) {
        throw new UserError(`Could not find ${script}, so there is nothing to install.`);
    }

    // Replacing an installed service means unloading the old definition first,
    // or launchd keeps running the one it already has.
    if (isInstalled(kind)) stop({ quiet: true });

    fs.mkdirSync(path.dirname(definition), { recursive: true });
    if (log) {
        // launchd would create this world-readable, and a log of an
        // administrative interface is nobody else's business. Creating it
        // first fixes the mode, since launchd appends to what it finds.
        fs.mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
        fs.closeSync(fs.openSync(log, 'a', 0o600));
        try {
            fs.chmodSync(log, 0o600);
            fs.chmodSync(path.dirname(log), 0o700);
        } catch (err) { /* not all filesystems */ }
    }

    const contents = kind === 'launchd'
        ? launchdPlist({ node, script, port, log, environment })
        : systemdUnit({ node, script, port, environment });

    // 0600 even though nothing secret goes in: this file names the paths and
    // port of an administrative interface, and nothing else needs to read it.
    fs.writeFileSync(definition, contents, { mode: 0o600 });

    if (kind === 'systemd') run('systemctl', ['--user', 'daemon-reload']);
    start();

    return { kind, definition, log, port, environment, skipped: secretsInEnvironment(env) };
}

function start() {
    const kind = requirePlatform();
    requireInstalled(kind);
    const { definition } = paths(kind);

    const result = kind === 'launchd'
        ? run('launchctl', ['bootstrap', `gui/${process.getuid()}`, definition])
        : run('systemctl', ['--user', 'enable', '--now', UNIT]);

    // Already loaded is the state we wanted, not a failure worth reporting.
    if (result.code !== 0 && !/already (bootstrapped|loaded)/i.test(result.stderr)) {
        throw new UserError(`Could not start the service: ${result.stderr || result.stdout}`);
    }
}

function stop({ quiet = false } = {}) {
    const kind = requirePlatform();
    const { definition } = paths(kind);

    const result = kind === 'launchd'
        ? run('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`])
        : run('systemctl', ['--user', 'disable', '--now', UNIT]);

    if (result.code !== 0 && !quiet && !/not (find|loaded)|No such process/i.test(result.stderr)) {
        throw new UserError(`Could not stop the service: ${result.stderr || result.stdout}`);
    }

    waitUntilUnloaded(kind);
    return definition;
}

function uninstall() {
    const kind = requirePlatform();
    requireInstalled(kind);

    stop({ quiet: true });
    const { definition } = paths(kind);
    fs.rmSync(definition, { force: true });
    if (kind === 'systemd') run('systemctl', ['--user', 'daemon-reload']);
    return definition;
}

function restart() {
    const kind = requirePlatform();
    requireInstalled(kind);

    // Restarting a loaded job in one step, rather than unloading and loading
    // again: no window where the job is half-registered, and no race with an
    // unload that has been asked for but not finished.
    if (isLoaded(kind)) {
        const result = kind === 'launchd'
            ? run('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${LABEL}`])
            : run('systemctl', ['--user', 'restart', UNIT]);

        if (result.code === 0) return;
        // Fall through: a job registered but not startable is worth reloading.
    }

    stop({ quiet: true });
    start();
}

/** Whether the service manager currently has it running, and its pid. */
function runningState(kind = platform()) {
    if (kind === 'launchd') {
        const result = run('launchctl', ['list', LABEL]);
        if (result.code !== 0) return { running: false, pid: null };
        const match = result.stdout.match(/"PID"\s*=\s*(\d+)/);
        return { running: Boolean(match), pid: match ? Number(match[1]) : null };
    }

    const active = run('systemctl', ['--user', 'is-active', UNIT]);
    const pid = run('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', UNIT]);
    const parsed = Number(pid.stdout);
    return {
        running: active.stdout === 'active',
        pid: Number.isFinite(parsed) && parsed > 0 ? parsed : null,
    };
}

function status() {
    const kind = requirePlatform();
    const { definition, log } = paths(kind);
    const installed = isInstalled(kind);

    return {
        kind,
        installed,
        definition,
        log,
        port: installedPort(kind) || DEFAULT_PORT,
        ...(installed ? runningState(kind) : { running: false, pid: null }),
    };
}

/**
 * Confirms something is actually answering on the port, and that it is us.
 *
 * The service manager only reports whether it launched the process. A
 * dashboard that started and then failed to bind — because the port was taken
 * — still looks "running" to launchd, so ask the port itself.
 */
function probe(port, timeoutMs = 1500) {
    return new Promise(resolve => {
        const http = require('http');
        const req = http.request(
            { host: '127.0.0.1', port, path: '/', method: 'GET', timeout: timeoutMs },
            res => {
                let text = '';
                res.setEncoding('utf8');
                res.on('data', chunk => {
                    text += chunk;
                    // The title is in the first bytes; no need for the whole page.
                    if (text.length > 4096) req.destroy();
                });
                res.on('end', () => resolve(text.includes('<title>shadowtools</title>')));
                res.on('error', () => resolve(false));
            }
        );
        req.on('timeout', () => req.destroy());
        req.on('error', () => resolve(false));
        req.end();
    });
}

/** The service's recent output, however this platform keeps it. */
function logs({ lines = 50, follow = false } = {}) {
    const kind = requirePlatform();

    if (kind === 'systemd') {
        const args = ['--user', '-u', UNIT, '-n', String(lines), '--no-pager'];
        if (follow) args.push('-f');
        // Inherit stdio so following streams straight through to the terminal.
        const result = spawnSync('journalctl', args, { stdio: 'inherit' });
        if (result.error) throw new UserError(`Could not read the journal: ${result.error.message}`);
        return null;
    }

    const { log } = paths(kind);
    if (!fs.existsSync(log)) return '';
    if (follow) {
        spawnSync('tail', ['-n', String(lines), '-f', log], { stdio: 'inherit' });
        return null;
    }
    return fs.readFileSync(log, 'utf8').split('\n').slice(-lines).join('\n').trim();
}

module.exports = {
    LABEL,
    UNIT,
    DEFAULT_PORT,
    platform,
    paths,
    isLoaded,
    serviceEnvironment,
    secretsInEnvironment,
    launchdPlist,
    systemdUnit,
    programPaths,
    installedPort,
    isInstalled,
    install,
    uninstall,
    start,
    stop,
    restart,
    status,
    probe,
    logs,
};
