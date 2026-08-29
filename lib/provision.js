'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');

const { UserError } = require('./errors');
const { configDir } = require('./config');

/**
 * Installing Outline on a server you have SSH access to.
 *
 * This exists because a blocked server has to be replaced quickly, from
 * whatever host is available — a small provider nobody has heard of as readily
 * as Vultr — and the slow part of that is never the VPN, it is standing up the
 * next server. Given credentials, this connects, installs Shadowbox, and hands
 * back the access code, which goes straight into the same registry a
 * hand-pasted one would.
 *
 * Three decisions here are about the people using it rather than about SSH,
 * and each costs something:
 *
 *  - **Credentials are never written down.** They are used for one connection
 *    and dropped. Somebody whose laptop is seized should not be handing over
 *    root on every server they run, and a panel that remembers passwords is
 *    exactly that. The cost is retyping them next time.
 *
 *  - **The host key is checked, and a new one has to be accepted explicitly.**
 *    Blind first-connect trust is the norm in provisioning tools and wrong
 *    here: the adversary in this threat model is often the network. The
 *    fingerprint is shown, the answer is remembered, and a later change is a
 *    hard failure rather than a prompt.
 *
 *  - **The installer is uploaded, not fetched by the server.** Outline's
 *    documented one-liner has the server pull the script from GitHub, which
 *    assumes the server can reach GitHub unmolested — precisely what cannot be
 *    assumed for a host in a censored network. Sending it over the SSH channel
 *    already established means one less thing to block, and one less fetch for
 *    somebody else to answer.
 */

const INSTALL_SCRIPT_URL =
    'https://raw.githubusercontent.com/OutlineFoundation/outline-server/master/src/server_manager/install_scripts/install_server.sh';

// Where the uploaded installer lands. Under /tmp because it is disposable, and
// with the pid in the name so two runs cannot collide.
const remoteScriptPath = () => `/tmp/outline-install-${process.pid}-${Date.now()}.sh`;

/** ssh2 is only needed to provision, so a broken optional build cannot break the CLI. */
function ssh2() {
    try {
        return require('ssh2');
    } catch (err) {
        throw new UserError(
            'The ssh2 module could not be loaded, so provisioning is unavailable. ' +
            `Run "npm install" in the shadowtools directory. (${err.message})`
        );
    }
}

/** The fingerprint form OpenSSH prints, so it can be compared against ssh-keyscan. */
function fingerprint(hostKey) {
    const digest = crypto.createHash('sha256').update(hostKey).digest('base64').replace(/=+$/, '');
    return `SHA256:${digest}`;
}

const knownHostsPath = () => path.join(configDir(), 'known_hosts');

/** The fingerprint recorded for a host, or null if it has not been seen. */
function knownHost(hostPort) {
    let text;
    try {
        text = fs.readFileSync(knownHostsPath(), 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw new UserError(`Could not read ${knownHostsPath()}: ${err.message}`);
    }

    for (const line of text.split('\n')) {
        const [entry, print] = line.trim().split(/\s+/);
        if (entry === hostPort && print) return print;
    }
    return null;
}

function rememberHost(hostPort, print) {
    const file = knownHostsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${hostPort} ${print}\n`, { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch (err) { /* not all filesystems */ }
}

/** Removes a host's recorded key, for a server that was genuinely rebuilt. */
function forgetHost(hostPort) {
    const file = knownHostsPath();
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return false;
        throw new UserError(`Could not read ${file}: ${err.message}`);
    }

    const kept = text.split('\n').filter(line => line.trim().split(/\s+/)[0] !== hostPort);
    fs.writeFileSync(file, kept.join('\n'), { mode: 0o600 });
    return kept.length !== text.split('\n').length;
}

/**
 * Obtains the Outline installer, so the target server never has to fetch it.
 *
 * SHADOWTOOLS_INSTALL_SCRIPT points at a local copy. That matters for the same
 * reason the script is uploaded rather than pulled: the machine running this
 * may itself be somewhere GitHub is awkward to reach, and someone who has
 * vetted a copy should be able to use exactly that one.
 */
function fetchInstallScript(url = INSTALL_SCRIPT_URL) {
    const local = process.env.SHADOWTOOLS_INSTALL_SCRIPT;
    if (local) {
        let text;
        try {
            text = fs.readFileSync(local, 'utf8');
        } catch (err) {
            throw new UserError(`Could not read the installer at ${local}: ${err.message}`);
        }
        if (!text.startsWith('#!')) {
            throw new UserError(`${local} does not look like a shell script.`);
        }
        return Promise.resolve(text);
    }

    return new Promise((resolve, reject) => {
        https.get(url, { timeout: 30000 }, res => {
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new UserError(
                    `Could not download the Outline installer: HTTP ${res.statusCode} from ${url}`
                ));
            }
            let text = '';
            res.setEncoding('utf8');
            res.on('data', chunk => (text += chunk));
            res.on('end', () => {
                // A proxy or captive portal answering 200 with an HTML error page
                // would otherwise be piped into a root shell.
                if (!text.startsWith('#!')) {
                    return reject(new UserError(
                        `What came back from ${url} is not a shell script. ` +
                        'Check whether something on this network is intercepting the request.'
                    ));
                }
                resolve(text);
            });
            res.on('error', reject);
        }).on('error', err => reject(new UserError(
            `Could not download the Outline installer: ${err.message}`
        ))).on('timeout', function () {
            this.destroy(new UserError('Timed out downloading the Outline installer.'));
        });
    });
}

/**
 * Opens an SSH connection, refusing to continue past an unverified host key.
 *
 * onUnknownHost is asked only when the host has never been seen. Returning
 * false, or not supplying it, aborts — the safe default for a non-interactive
 * caller. It may return a promise, which is what lets the dashboard put the
 * question to somebody and hold the connection open until they answer. A host
 * key that has *changed* is never a question.
 */
function connect({
    host, port = 22, username = 'root', password, privateKey, passphrase,
    onUnknownHost, readyTimeout = 30000,
}) {
    if (!host) throw new UserError('A server address is required.');
    if (!password && !privateKey) {
        throw new UserError('Provide either a password or a private key to connect with.');
    }

    const { Client } = ssh2();
    const hostPort = port === 22 ? host : `${host}:${port}`;
    const expected = knownHost(hostPort);

    return new Promise((resolve, reject) => {
        const client = new Client();
        let settled = false;
        const fail = err => {
            if (settled) return;
            settled = true;
            client.end();
            reject(err instanceof UserError ? err : new UserError(`SSH to ${hostPort} failed: ${err.message}`));
        };

        client
            .on('ready', () => {
                if (settled) return;
                settled = true;
                resolve(client);
            })
            .on('error', fail)
            .connect({
                host,
                port,
                username,
                password,
                privateKey,
                passphrase,
                readyTimeout,
                // Runs before authentication, so nothing secret is sent to a
                // server that cannot prove it is the one we mean. Taking the
                // verify callback rather than returning makes the answer
                // allowed to arrive later, from a person looking at a screen.
                hostVerifier: (key, verify) => {
                    const actual = fingerprint(key);

                    if (expected && expected === actual) return verify(true);

                    if (expected) {
                        fail(new UserError(
                            `The host key for ${hostPort} has changed.\n` +
                            `  expected: ${expected}\n` +
                            `  received: ${actual}\n` +
                            'This is what a machine-in-the-middle looks like. It is also what a ' +
                            'genuinely rebuilt server looks like — if you rebuilt it, run ' +
                            `"shadowtools provision forget ${hostPort}" and try again.`
                        ));
                        return verify(false);
                    }

                    if (!onUnknownHost) {
                        fail(new UserError(
                            `${hostPort} has not been seen before, and its key was not confirmed.\n` +
                            `  fingerprint: ${actual}\n` +
                            'Check it against your provider\'s console, then connect interactively ' +
                            'to accept it.'
                        ));
                        return verify(false);
                    }

                    // Sync answers resolve immediately; a promise holds the
                    // handshake open until somebody decides.
                    Promise.resolve(onUnknownHost({ hostPort, fingerprint: actual }))
                        .then(accepted => {
                            if (!accepted) {
                                fail(new UserError('The host key was not accepted, so nothing was sent.'));
                                return verify(false);
                            }
                            rememberHost(hostPort, actual);
                            verify(true);
                        })
                        .catch(err => {
                            fail(err);
                            verify(false);
                        });
                },
            });
    });
}

/** Runs one command, streaming its output, and resolves with the exit code. */
function exec(client, command, { onOutput } = {}) {
    return new Promise((resolve, reject) => {
        client.exec(command, { pty: false }, (err, stream) => {
            if (err) return reject(new UserError(`Could not run a command on the server: ${err.message}`));

            let stdout = '';
            let stderr = '';
            stream
                .on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
                .on('data', chunk => {
                    stdout += chunk;
                    if (onOutput) onOutput(String(chunk));
                })
                .stderr.on('data', chunk => {
                    stderr += chunk;
                    if (onOutput) onOutput(String(chunk));
                });
        });
    });
}

/** Writes text to a remote path over SFTP, with the mode given. */
function upload(client, remotePath, contents, mode = 0o700) {
    return new Promise((resolve, reject) => {
        client.sftp((err, sftp) => {
            if (err) return reject(new UserError(`Could not open SFTP: ${err.message}`));
            const stream = sftp.createWriteStream(remotePath, { mode });
            stream.on('error', e => reject(new UserError(`Could not write ${remotePath}: ${e.message}`)));
            stream.on('close', () => resolve());
            stream.end(contents);
        });
    });
}

/**
 * Pulls the access code out of the installer's final message.
 *
 * The script prints it wrapped in ANSI colour, which lands outside the braces,
 * so the JSON survives intact — the same parser that reads a hand-pasted code
 * reads this without special handling.
 */
function extractAccessCode(output) {
    const matches = String(output).match(/\{"apiUrl"\s*:\s*"[^"]+"\s*,\s*"certSha256"\s*:\s*"[^"]*"\}/g);
    if (!matches || !matches.length) return null;
    // The last one, so a script that echoes an example first cannot win.
    return matches[matches.length - 1];
}

/** Builds the installer invocation, quoting anything that reaches a shell. */
function installCommand(scriptPath, { hostname, apiPort, keysPort } = {}) {
    const args = [];

    // Absent means "let the installer choose". Anything else has to be valid:
    // silently dropping a port someone typed would hand them a random one and
    // no reason to suspect it. Port 0 is the case that made this explicit.
    const given = value => value !== undefined && value !== null && value !== '';

    const number = (value, label) => {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new UserError(`"${value}" is not a valid ${label}.`);
        }
        return port;
    };

    if (given(hostname)) {
        if (!/^[A-Za-z0-9.:_-]+$/.test(hostname)) {
            throw new UserError(`"${hostname}" is not a valid hostname or IP address.`);
        }
        args.push('--hostname', hostname);
    }
    if (given(apiPort)) args.push('--api-port', String(number(apiPort, 'API port')));
    if (given(keysPort)) args.push('--keys-port', String(number(keysPort, 'keys port')));

    // sudo -n so a password prompt fails fast rather than hanging on a pty we
    // are not attached to. Root sessions skip sudo entirely.
    return `if [ "$(id -u)" = "0" ]; then bash ${scriptPath} ${args.join(' ')}; ` +
        `else sudo -n bash ${scriptPath} ${args.join(' ')}; fi`;
}

/**
 * Installs Outline on an already-connected server.
 *
 * @returns {Promise<{accessCode: string, output: string}>}
 */
async function install(client, { hostname, apiPort, keysPort, script, onOutput } = {}) {
    const contents = script || await fetchInstallScript();
    const remotePath = remoteScriptPath();

    if (onOutput) onOutput(`Uploading the Outline installer to ${remotePath}\n`);
    await upload(client, remotePath, contents);

    const command = installCommand(remotePath, { hostname, apiPort, keysPort });
    if (onOutput) onOutput('Running the installer. This takes a few minutes on a fresh server.\n');
    const result = await exec(client, command, { onOutput });

    // Best effort: leaving it behind is untidy, not dangerous.
    await exec(client, `rm -f ${remotePath}`).catch(() => {});

    const combined = `${result.stdout}\n${result.stderr}`;
    const accessCode = extractAccessCode(combined);

    if (!accessCode) {
        const tail = combined.trim().split('\n').slice(-12).join('\n');
        throw new UserError(
            `The installer did not print an access code, so the server is not ready.\n\n${tail}\n\n` +
            (result.code === 0
                ? 'It exited successfully, which usually means an older installer with different output.'
                : `It exited with status ${result.code}.`)
        );
    }

    return { accessCode, output: combined };
}

module.exports = {
    INSTALL_SCRIPT_URL,
    connect,
    exec,
    extractAccessCode,
    fetchInstallScript,
    fingerprint,
    forgetHost,
    install,
    installCommand,
    knownHost,
    knownHostsPath,
    rememberHost,
    upload,
};
