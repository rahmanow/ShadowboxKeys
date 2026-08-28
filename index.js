'use strict';

/**
 * Programmatic entry point.
 *
 * The CLI in shadowboxKey.js is one consumer of this API; the exports below are
 * the same building blocks it uses, so anything the CLI can do is reachable from
 * code. getKeys() is kept signature-compatible with the outline-br module this
 * project absorbed, so existing callers keep working.
 */

const { OutlineClient } = require('./lib/outline');
const { formatBytes, parseBytes, rewriteAccessUrl } = require('./lib/format');
const { UserError } = require('./lib/errors');

/**
 * Lists every access key on the server.
 *
 * @param {string} managementApiUrl  Management API URL from Outline Manager.
 * @param {object} [options]
 * @param {string} [options.domain]      Host to use in access URLs instead of the server IP.
 * @param {string} [options.certSha256]  Pin the server's certificate to this fingerprint.
 * @returns {Promise<Array<{id: string, name: string, port: number,
 *                          dataLimitBytes: number|null, accessUrl: string}>>}
 */
async function listKeys(managementApiUrl, options = {}) {
    const client = new OutlineClient(managementApiUrl, options.certSha256);
    const host = options.domain || client.hostname;

    const keys = await client.listKeys();
    return keys.map(key => ({
        id: key.id,
        name: key.name || '',
        port: key.port,
        dataLimitBytes: key.dataLimit ? key.dataLimit.bytes : null,
        accessUrl: rewriteAccessUrl(key.accessUrl, client.hostname, host),
    }));
}

/**
 * Reports how much data each key has transferred, busiest first.
 *
 * @param {string} managementApiUrl
 * @param {object} [options]  Same options as listKeys.
 * @returns {Promise<Array<{id: string, name: string, bytes: number,
 *                          dataLimitBytes: number|null}>>}
 */
async function getUsage(managementApiUrl, options = {}) {
    const client = new OutlineClient(managementApiUrl, options.certSha256);
    const [keys, transferred] = await Promise.all([
        client.listKeys(),
        client.getTransferMetrics(),
    ]);

    return keys
        .map(key => ({
            id: key.id,
            name: key.name || '',
            bytes: transferred[key.id] || 0,
            dataLimitBytes: key.dataLimit ? key.dataLimit.bytes : null,
        }))
        .sort((a, b) => b.bytes - a.bytes);
}

/**
 * Prints every key as "Name -> ss://..." and returns those lines.
 *
 * This is the outline-br entry point, kept for callers migrating from that
 * module: same two arguments, same output format and same printing behaviour.
 * It returns the lines as well, which outline-br did not, so existing callers
 * are unaffected. New code should prefer listKeys(), which returns structured
 * data and leaves the printing to you.
 *
 * @param {string} managementApiUrl
 * @param {string} [newDomain]  Host to use in access URLs instead of the server IP.
 * @param {object} [options]    Additionally accepts certSha256.
 * @returns {Promise<string[]>}
 */
async function getKeys(managementApiUrl, newDomain, options = {}) {
    const keys = await listKeys(managementApiUrl, { ...options, domain: newDomain });

    // outline-br trimmed the /?outline=1 suffix from the printed URL.
    const lines = keys.map(key => `${key.name || 'Noname'} -> ${key.accessUrl.split('/?')[0]}`);
    lines.forEach(line => console.log(line));
    return lines;
}

module.exports = {
    // High-level helpers
    listKeys,
    getUsage,
    getKeys,
    // The full Management API client, for anything the helpers do not cover
    OutlineClient,
    // Utilities shared with the CLI
    formatBytes,
    parseBytes,
    rewriteAccessUrl,
    UserError,
};
