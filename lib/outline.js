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
const agent = new https.Agent({ rejectUnauthorized: false });

/** Sends one request and resolves with the status line and raw body text. */
function send(url, method, body) {
    return new Promise((resolve, reject) => {
        const options = { method, agent };
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

        req.on('error', reject);
        if (body !== undefined) req.write(body);
        req.end();
    });
}

class OutlineClient {
    constructor(managementApiUrl) {
        this.baseUrl = managementApiUrl.replace(/\/+$/, '');
        this.hostname = new URL(this.baseUrl).hostname;
    }

    async request(method, path, body) {
        const payload = body === undefined ? undefined : JSON.stringify(body);

        let response;
        try {
            response = await send(this.baseUrl + path, method, payload);
        } catch (err) {
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

    async getTransferMetrics() {
        const data = await this.request('GET', '/metrics/transfer');
        return (data && data.bytesTransferredByUserId) || {};
    }
}

module.exports = { OutlineClient };
