'use strict';

const fetch = require('node-fetch');
const https = require('https');
const { UserError } = require('./errors');

// Outline's Management API is served with a self-signed certificate, so
// certificate verification has to be disabled. Only point this client at
// servers you control.
const agent = new https.Agent({ rejectUnauthorized: false });

class OutlineClient {
    constructor(managementApiUrl) {
        this.baseUrl = managementApiUrl.replace(/\/+$/, '');
        this.hostname = new URL(this.baseUrl).hostname;
    }

    async request(method, path, body) {
        const options = { method, agent };
        if (body !== undefined) {
            options.body = JSON.stringify(body);
            options.headers = { 'Content-Type': 'application/json' };
        }

        let response;
        try {
            response = await fetch(this.baseUrl + path, options);
        } catch (err) {
            throw new UserError(`Could not reach the Outline server: ${err.message}`);
        }

        if (!response.ok) {
            throw new UserError(
                `Management API responded with ${response.status} ${response.statusText} for ${method} ${path}`
            );
        }

        // 204 No Content, which most write endpoints return.
        if (response.status === 204) return null;

        const text = await response.text();
        return text ? JSON.parse(text) : null;
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
