'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { UserError } = require('./errors');

/**
 * Where the dashboard keeps the servers it manages.
 *
 * Until now the Management API URL only ever came from the environment, which
 * is fine for one server driven from one shell. The dashboard manages several,
 * and adding one there has to outlive the process, so the credential lands on
 * disk. That is a real widening of the blast radius, so the file is written
 * 0600 inside a 0700 directory and never leaves this machine — the same
 * treatment an SSH private key gets, for the same reason: whoever reads it has
 * full administrative control of every server listed in it.
 *
 * Environment variables still win over anything stored here, so an existing
 * setup keeps behaving exactly as it did and CI never reads a stray file.
 */

const VERSION = 1;

/**
 * The id of the server configured through OUTLINE_API_URL. It is reserved: the
 * environment entry is never written to the file, but it can be the active
 * choice, so the id has to survive a load/save round trip.
 */
const ENV_SERVER_ID = 'env';

/** Resolves the config file path, honouring SHADOWTOOLS_CONFIG and XDG_CONFIG_HOME. */
function configPath() {
    if (process.env.SHADOWTOOLS_CONFIG) return process.env.SHADOWTOOLS_CONFIG;
    const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return path.join(base, 'shadowtools', 'config.json');
}

function emptyConfig() {
    return { version: VERSION, activeServerId: null, servers: [] };
}

function newId() {
    return crypto.randomBytes(6).toString('hex');
}

/**
 * Pulls an apiUrl and certSha256 out of whatever the user pasted.
 *
 * Outline Manager shows the pair as one JSON blob under Settings, and that blob
 * is what people copy, so accept it verbatim — including when a mail client has
 * wrapped it across lines. A bare Management API URL is accepted too, since
 * that is the other thing that gets passed around, and older docs only mention
 * the URL.
 */
function parseAccessCode(input) {
    const text = String(input == null ? '' : input).trim();
    if (!text) throw new UserError('Paste the access code from Outline Manager > Settings.');

    let apiUrl = text;
    let certSha256 = '';

    // The JSON form, possibly with the surrounding prose people copy along with it.
    const braces = text.indexOf('{');
    if (braces !== -1) {
        const slice = text.slice(braces, text.lastIndexOf('}') + 1);

        // Retry with whitespace removed if the first parse fails. A mail client
        // or chat window that wraps the line puts a raw newline inside a string,
        // which JSON rejects outright — and neither field here can legitimately
        // contain whitespace, so collapsing it can only recover a valid paste.
        let parsed;
        for (const candidate of [slice, slice.replace(/\s+/g, '')]) {
            try {
                parsed = JSON.parse(candidate);
                break;
            } catch (err) { /* try the next form */ }
        }
        if (!parsed || typeof parsed !== 'object') {
            throw new UserError(
                'That looks like the JSON access code but could not be parsed. ' +
                'Copy the whole line from Outline Manager > Settings, braces included.'
            );
        }

        apiUrl = String(parsed.apiUrl || '').trim();
        certSha256 = String(parsed.certSha256 || '').trim();
    }

    // Whitespace inside a copied URL is always a wrapped line, never meaningful.
    apiUrl = apiUrl.replace(/\s+/g, '');

    let url;
    try {
        url = new URL(apiUrl);
    } catch (err) {
        throw new UserError(`"${apiUrl}" is not a Management API URL. It should look like https://1.2.3.4:16942/AbCdEf123.`);
    }

    if (url.protocol !== 'https:') {
        throw new UserError('A Management API URL must use https.');
    }
    // The path component is the admin secret; without it the URL is useless.
    if (url.pathname.replace(/\/+$/, '') === '') {
        throw new UserError(
            'That Management API URL has no secret path. Copy the whole URL from ' +
            'Outline Manager > Settings, including the part after the port.'
        );
    }

    return { apiUrl: apiUrl.replace(/\/+$/, ''), certSha256 };
}

/**
 * Shortens a Management API URL for display, keeping enough of the secret to
 * tell two servers apart without putting the whole credential on screen.
 *
 * Never more than half the secret, so a short one is not simply printed in
 * full: the point is that this string can appear anywhere — a dashboard, a
 * screenshot, a support thread — without being usable.
 */
function redactApiUrl(apiUrl) {
    try {
        const url = new URL(apiUrl);
        const secret = url.pathname.replace(/^\/+/, '');
        const keep = Math.min(6, Math.floor(secret.length / 2));
        return `${url.protocol}//${url.host}/${secret.slice(0, keep)}…`;
    } catch (err) {
        return '';
    }
}

/** Fills in defaults and drops anything unrecognised from a file we did not write. */
function normalizeConfig(raw) {
    const config = emptyConfig();
    if (!raw || typeof raw !== 'object') return config;

    const servers = Array.isArray(raw.servers) ? raw.servers : [];
    config.servers = servers
        .filter(server => server && typeof server.apiUrl === 'string' && server.apiUrl)
        .map(server => ({
            id: String(server.id || newId()),
            name: String(server.name || '').trim(),
            apiUrl: String(server.apiUrl).replace(/\/+$/, ''),
            certSha256: String(server.certSha256 || ''),
            domain: String(server.domain || '').trim(),
            createdAt: String(server.createdAt || ''),
        }));

    const active = raw.activeServerId ? String(raw.activeServerId) : null;
    const known = active === ENV_SERVER_ID || config.servers.some(s => s.id === active);
    config.activeServerId = known ? active : null;
    return config;
}

/**
 * A config store backed by a file.
 *
 * Reads are not cached: the CLI and a running dashboard can both be pointed at
 * the same file, and a stale in-memory copy would silently undo the other's
 * edits on the next write.
 */
function createStore(file = configPath()) {
    return {
        path: file,

        load() {
            let text;
            try {
                text = fs.readFileSync(file, 'utf8');
            } catch (err) {
                if (err.code === 'ENOENT') return emptyConfig();
                throw new UserError(`Could not read ${file}: ${err.message}`);
            }

            try {
                return normalizeConfig(JSON.parse(text));
            } catch (err) {
                throw new UserError(
                    `${file} is not valid JSON, so it was left untouched. ` +
                    'Fix or delete it, then try again.'
                );
            }
        },

        save(config) {
            const dir = path.dirname(file);
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

            // Write beside the target and rename, so an interrupted write cannot
            // truncate a file full of credentials into an unrecoverable state.
            const temp = path.join(dir, `.config.${process.pid}.${Date.now()}.tmp`);
            fs.writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
            try {
                fs.renameSync(temp, file);
            } catch (err) {
                try { fs.unlinkSync(temp); } catch (cleanupErr) { /* best effort */ }
                throw new UserError(`Could not write ${file}: ${err.message}`);
            }
            // rename keeps the temp file's mode, but an existing file keeps its
            // own, so re-assert it for a config written before this ran.
            try { fs.chmodSync(file, 0o600); } catch (err) { /* not all filesystems */ }
            return config;
        },
    };
}

/** An in-memory store with the same shape, for tests and for --no-config runs. */
function createMemoryStore(initial) {
    let config = normalizeConfig(initial);
    return {
        path: null,
        load() { return JSON.parse(JSON.stringify(config)); },
        save(next) { config = normalizeConfig(next); return this.load(); },
    };
}

module.exports = {
    VERSION,
    ENV_SERVER_ID,
    configPath,
    createStore,
    createMemoryStore,
    emptyConfig,
    newId,
    normalizeConfig,
    parseAccessCode,
    redactApiUrl,
};
