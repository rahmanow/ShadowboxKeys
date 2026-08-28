'use strict';

const https = require('https');
const { UserError } = require('./errors');

// Outline's Management API is served with a self-signed certificate, so
// certificate verification has to be disabled. Only point this client at
// servers you control.
//
// This uses node:https rather than the global fetch() because fetch offers no
// supported way to relax certificate checks for a single request: it ignores
// the agent option, and its dispatcher lives in undici, which is not reachable
// without taking on a dependency.
//
// maxCachedSessions: 0 disables TLS session resumption. A resumed session skips
// the certificate exchange, so getPeerCertificate() returns nothing and the
// pinning check below could not run on any request after the first — which for
// a command issuing several requests meant rejecting the legitimate server.
// Forcing a full handshake each time costs a few milliseconds per request.
const agent = new https.Agent({ rejectUnauthorized: false, maxCachedSessions: 0 });

// A host that drops packets rather than refusing the connection — a wrong IP in
// a pasted access code, a firewall, a server that has moved — would otherwise
// hang for the operating system's TCP timeout, well over a minute, with nothing
// on screen. The Management API answers in milliseconds when it answers at all,
// so anything approaching this is already a failure worth reporting.
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

/** The timeout to use, read per request so a caller can change it at runtime. */
function requestTimeout() {
    const given = Number(process.env.OUTLINE_TIMEOUT_MS);
    return Number.isFinite(given) && given > 0 ? given : DEFAULT_REQUEST_TIMEOUT_MS;
}

/**
 * Normalises a SHA-256 certificate fingerprint to bare lowercase hex, accepting
 * the colon-separated form openssl prints as well as the plain form Outline
 * Manager reports as certSha256. Returns null for empty input.
 */
function normalizeFingerprint(value) {
    if (!value) return null;
    const hex = String(value).replace(/[:\s]/g, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hex)) {
        throw new UserError(
            `"${value}" is not a SHA-256 certificate fingerprint. ` +
            'Expected 64 hex characters, as shown by certSha256 in Outline Manager.'
        );
    }
    return hex;
}

/**
 * Aborts the request unless the server presented the certificate we expect.
 *
 * The check runs on secureConnect, before any request bytes leave the process,
 * because the Management API URL's path component is itself the admin secret
 * and must not be sent to a server we have not authenticated.
 */
function pinCertificate(req, socket, expected) {
    const verify = () => {
        const cert = socket.getPeerCertificate();
        const actual = cert && cert.fingerprint256
            ? cert.fingerprint256.replace(/:/g, '').toLowerCase()
            : null;

        if (actual !== expected) {
            req.destroy(new UserError(
                'The server presented an unexpected TLS certificate, so the request was not sent.\n' +
                `  expected: ${expected}\n` +
                `  received: ${actual || '(none)'}\n` +
                'Check OUTLINE_CERT_SHA256 against certSha256 in Outline Manager. If it has not ' +
                'changed there, you may be talking to the wrong server.'
            ));
        }
    };

    // A pooled socket has already completed its handshake; a fresh one has not.
    const cert = socket.getPeerCertificate && socket.getPeerCertificate();
    if (cert && cert.fingerprint256) verify();
    else socket.once('secureConnect', verify);
}

/** Sends one request and resolves with the status line and raw body text. */
function send(url, method, body, fingerprint) {
    return new Promise((resolve, reject) => {
        // timeout must go in the options rather than on the returned request:
        // req.setTimeout() only arms once the socket is connected, which is
        // exactly the case a black-holed address never reaches.
        const timeout = requestTimeout();
        const options = { method, agent, timeout };
        if (body !== undefined) {
            options.headers = {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            };
        }

        const req = https.request(url, options, res => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', chunk => (text += chunk));
            res.on('end', () => resolve({
                status: res.statusCode,
                statusText: res.statusMessage || '',
                text,
            }));
            res.on('error', reject);
        });

        if (fingerprint) {
            req.on('socket', socket => pinCertificate(req, socket, fingerprint));
        }

        req.on('timeout', () => {
            req.destroy(new UserError(
                `The server at ${new URL(url).host} did not respond within ` +
                `${timeout / 1000} seconds. Check that the address in the Management API ` +
                'URL is right and that its port is reachable from here.'
            ));
        });

        req.on('error', reject);
        if (body !== undefined) req.write(body);
        req.end();
    });
}

class OutlineClient {
    constructor(managementApiUrl, certSha256) {
        this.baseUrl = managementApiUrl.replace(/\/+$/, '');
        this.hostname = new URL(this.baseUrl).hostname;
        this.fingerprint = normalizeFingerprint(certSha256);
    }

    async request(method, path, body) {
        const payload = body === undefined ? undefined : JSON.stringify(body);

        let response;
        try {
            response = await send(this.baseUrl + path, method, payload, this.fingerprint);
        } catch (err) {
            // A pinning failure is already a clear message; don't bury it.
            if (err instanceof UserError) throw err;
            throw new UserError(`Could not reach the Outline server: ${err.message}`);
        }

        if (response.status < 200 || response.status >= 300) {
            throw new UserError(
                `Management API responded with ${response.status} ${response.statusText} for ${method} ${path}`
            );
        }

        // Write endpoints answer 204 No Content, so there is nothing to parse.
        if (!response.text) return null;

        try {
            return JSON.parse(response.text);
        } catch (err) {
            throw new UserError(`Could not read the response from ${method} ${path}: ${err.message}`);
        }
    }

    async listKeys() {
        const data = await this.request('GET', '/access-keys/');
        return (data && data.accessKeys) || [];
    }

    async createKey(name) {
        const key = await this.request('POST', '/access-keys');
        if (name && key) {
            await this.renameKey(key.id, name);
            key.name = name;
        }
        return key;
    }

    removeKey(id) {
        return this.request('DELETE', `/access-keys/${encodeURIComponent(id)}`);
    }

    renameKey(id, name) {
        return this.request('PUT', `/access-keys/${encodeURIComponent(id)}/name`, { name });
    }

    setKeyDataLimit(id, bytes) {
        return this.request('PUT', `/access-keys/${encodeURIComponent(id)}/data-limit`, {
            limit: { bytes },
        });
    }

    clearKeyDataLimit(id) {
        return this.request('DELETE', `/access-keys/${encodeURIComponent(id)}/data-limit`);
    }

    setServerDataLimit(bytes) {
        return this.request('PUT', '/server/access-key-data-limit', { limit: { bytes } });
    }

    clearServerDataLimit() {
        return this.request('DELETE', '/server/access-key-data-limit');
    }

    /** Server-wide configuration, including the default access-key data limit. */
    getServerInfo() {
        return this.request('GET', '/server');
    }

    async getTransferMetrics() {
        const data = await this.request('GET', '/metrics/transfer');
        return (data && data.bytesTransferredByUserId) || {};
    }
}

module.exports = { OutlineClient, normalizeFingerprint, requestTimeout, DEFAULT_REQUEST_TIMEOUT_MS };
