'use strict';

const { OutlineClient } = require('./outline');
const { UserError } = require('./errors');
const {
    ENV_SERVER_ID,
    createMemoryStore,
    newId,
    parseAccessCode,
    redactApiUrl,
} = require('./config');

/**
 * The set of Outline servers this installation knows about, and the Management
 * API clients that talk to them.
 *
 * Two sources feed it. The environment contributes at most one server, which is
 * how shadowtools has always been configured and which stays read-only here —
 * the dashboard will not silently rewrite someone's shell setup. The config
 * file contributes the rest, and those are the ones the dashboard creates and
 * edits. Everything downstream (the HTTP handler, the CLI) asks the registry
 * for a client rather than constructing one, so there is a single place that
 * decides which server an operation lands on.
 *
 * When direct server access arrives, provisioning a box ends by handing the
 * registry the access code the installer prints, and the new server joins the
 * same list as anything added by hand.
 */

/** Everything about a server except the credential itself. */
function describe(server, { active, source }) {
    return {
        id: server.id,
        name: server.name || '',
        host: hostOf(server),
        domain: server.domain || '',
        apiUrlPreview: redactApiUrl(server.apiUrl),
        certPinned: Boolean(server.certSha256),
        createdAt: server.createdAt || '',
        source,
        active,
        // Servers from the environment are edited by editing the environment.
        editable: source !== 'env',
    };
}

function hostOf(server) {
    try {
        return new URL(server.apiUrl).hostname;
    } catch (err) {
        return '';
    }
}

function createRegistry({ store, env = null, clientFactory } = {}) {
    if (!store) store = createMemoryStore();

    // Clients hold a TLS agent and a validated fingerprint, so build one per
    // server and reuse it rather than re-parsing the credential per request.
    const clients = new Map();
    const makeClient = clientFactory || (server => new OutlineClient(server.apiUrl, server.certSha256));

    const envServer = env && env.apiUrl
        ? {
            id: ENV_SERVER_ID,
            name: env.name || 'Environment',
            apiUrl: env.apiUrl,
            certSha256: env.certSha256 || '',
            domain: env.domain || '',
            createdAt: '',
        }
        : null;

    /** Every server, environment first, in the order the dashboard shows them. */
    function all(config) {
        const stored = config.servers.map(server => ({ ...server, source: 'file' }));
        return envServer ? [{ ...envServer, source: 'env' }, ...stored] : stored;
    }

    function activeIdFor(config) {
        const servers = all(config);
        if (!servers.length) return null;
        const chosen = servers.find(server => server.id === config.activeServerId);
        return chosen ? chosen.id : servers[0].id;
    }

    function find(config, id) {
        const server = all(config).find(candidate => candidate.id === id);
        if (!server) throw new UserError(`No configured server with id "${id}".`);
        return server;
    }

    /**
     * The index of a stored server, or a refusal explaining why there isn't one:
     * either the id names the environment entry, which this cannot rewrite, or
     * it names nothing at all.
     */
    function storedIndex(config, id) {
        const index = config.servers.findIndex(server => server.id === id);
        if (index !== -1) return index;

        // Raises "no such server" for an unknown id.
        const server = find(config, id);
        throw new UserError(
            `"${server.name || server.id}" comes from OUTLINE_API_URL in your environment. ` +
            'Change it there, or add it as a saved server instead.'
        );
    }

    return {
        get storePath() { return store.path; },
        get hasEnvServer() { return Boolean(envServer); },

        list() {
            const config = store.load();
            const active = activeIdFor(config);
            return all(config).map(server =>
                describe(server, { active: server.id === active, source: server.source }));
        },

        /** The server operations run against, or null when nothing is configured. */
        active() {
            const config = store.load();
            const id = activeIdFor(config);
            return id ? find(config, id) : null;
        },

        /** The active server's client, with a message that says how to fix "none". */
        activeClient() {
            const server = this.active();
            if (!server) {
                throw new UserError(
                    'No Outline server is configured yet. Add one with its access code from ' +
                    'Outline Manager > Settings, or set OUTLINE_API_URL.'
                );
            }
            return { server, client: this.clientFor(server) };
        },

        /** One server by id, with its client — for acting on a server that is not active. */
        clientById(id) {
            const server = find(store.load(), id);
            return { server, client: this.clientFor(server) };
        },

        clientFor(server) {
            // Key on the credential, so editing a server's access code retires
            // the client that still points at the old one.
            const cacheKey = `${server.id}:${server.apiUrl}:${server.certSha256 || ''}`;
            if (!clients.has(cacheKey)) clients.set(cacheKey, makeClient(server));
            return clients.get(cacheKey);
        },

        add({ name, accessCode, domain }) {
            const { apiUrl, certSha256 } = parseAccessCode(accessCode);
            const config = store.load();

            // Adding the same server twice is a paste slip, not an intention.
            const clash = config.servers.find(server => server.apiUrl === apiUrl);
            if (clash) {
                throw new UserError(`That server is already saved as "${clash.name || clash.id}".`);
            }

            const server = {
                id: newId(),
                name: String(name || '').trim(),
                apiUrl,
                certSha256,
                domain: String(domain || '').trim(),
                createdAt: new Date().toISOString(),
            };

            // Validate the fingerprint now, so a typo surfaces on the form that
            // introduced it rather than on the first request minutes later.
            makeClient(server);

            config.servers.push(server);
            config.activeServerId = server.id;
            store.save(config);
            return server.id;
        },

        update(id, { name, domain, accessCode }) {
            const config = store.load();
            const index = storedIndex(config, id);
            const server = { ...config.servers[index] };
            if (name !== undefined) server.name = String(name || '').trim();
            if (domain !== undefined) server.domain = String(domain || '').trim();
            if (accessCode) {
                const parsed = parseAccessCode(accessCode);
                server.apiUrl = parsed.apiUrl;
                server.certSha256 = parsed.certSha256;
            }

            makeClient(server);
            config.servers[index] = server;
            store.save(config);
            return server.id;
        },

        remove(id) {
            const config = store.load();
            const index = storedIndex(config, id);
            config.servers.splice(index, 1);
            if (config.activeServerId === id) config.activeServerId = null;
            store.save(config);
        },

        activate(id) {
            const config = store.load();
            find(config, id);
            config.activeServerId = id;
            store.save(config);
        },

        /**
         * The full access code for one server.
         *
         * Everything else in this module deliberately hands out redacted URLs:
         * the credential lives in this process and the browser has no use for
         * it. Reading it back is a distinct, user-initiated act — copying a
         * server into Outline Manager or onto another machine — so it gets its
         * own call rather than riding along in the server list.
         */
        accessCode(id) {
            const server = find(store.load(), id);
            return {
                apiUrl: server.apiUrl,
                certSha256: server.certSha256 || '',
                json: JSON.stringify({ apiUrl: server.apiUrl, certSha256: server.certSha256 || '' }),
            };
        },
    };
}

module.exports = { createRegistry, hostOf };
