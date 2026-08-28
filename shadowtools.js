#!/usr/bin/env node
'use strict';

// BEGIN Variables to change
// Prefer setting these via environment variables (OUTLINE_API_URL, OUTLINE_DOMAIN)
// so the Management API URL never ends up committed to version control.
//
// These are no longer the only way to configure a server: the dashboard saves
// servers to a config file, and the CLI reads the same file. An environment
// variable still wins, so an existing setup keeps behaving as it always has.
const managementApiUrl = process.env.OUTLINE_API_URL || 'https://xx.xx.xx.xxx:16942/xxxxxxxxxxxxxxxxxxxxxx'; // Management API URL from Outline Manager > Settings
const domain = process.env.OUTLINE_DOMAIN || ''; // set your custom domain if you have one, e.g. 'vpn.example.com'
const certSha256 = process.env.OUTLINE_CERT_SHA256 || ''; // recommended: certSha256 from Outline Manager, to pin the server's certificate
// END Variables to change

const qrcode = require('qrcode-terminal');
const { UserError } = require('./lib/errors');
const { createStore } = require('./lib/config');
const { createRegistry } = require('./lib/registry');
const { formatBytes, parseBytes, rewriteAccessUrl, printTable, printCsv } = require('./lib/format');

const USAGE = `shadowtools - manage access keys on your Outline VPN servers

Usage: node shadowtools.js <command> [options]

Commands:
  list                        List every access key with its access URL
  add <name>                  Create a new access key
  remove <key>                Delete an access key
  rename <key> <new name>     Rename an access key
  limit <key> <size|none>     Set or clear a key's data limit (use "server" as
                              the key to set the server-wide default limit)
  usage                       Show data transferred per key
  qr <key>                    Print an access key as a scannable QR code
  servers                     List the Outline servers this machine knows about
  servers add <name>          Save a server, reading its access code from stdin
  servers use <server>        Choose the server other commands act on
  servers remove <server>     Forget a saved server (the server itself is untouched)
  ui                          Open the admin dashboard in your browser

<key> may be either a key id or a key name.
<server> may be either a server id or a server name.

Options:
  --qr        Also print a QR code for each key (list, add)
  --json      Output JSON instead of a table (list, usage, servers)
  --csv       Output CSV instead of a table (list, usage, servers)
  --limit <size>  Data limit for a newly created key (add)
  --server <s>    Act on this server instead of the active one
  --port <n>  Port for the dashboard (ui, default 8787)
  -h, --help  Show this help

Sizes accept a unit suffix, e.g. 10GB, 500MB, 2TB.

Configuration:
  Servers added in the dashboard are saved to a config file readable only by
  you. These environment variables define one more server, which takes
  precedence and is never written to that file:

  OUTLINE_API_URL      Management API URL from Outline Manager > Settings
  OUTLINE_DOMAIN       Optional custom domain to use in place of the server IP
  OUTLINE_CERT_SHA256  Recommended. The server's certSha256, from the same place
                       in Outline Manager. When set, the tool refuses to talk to
                       any server presenting a different certificate.
  SHADOWTOOLS_CONFIG   Override where saved servers are stored.

Examples:
  node shadowtools.js list --qr
  node shadowtools.js add Alice --limit 50GB
  node shadowtools.js limit Alice 10GB
  node shadowtools.js usage --csv
  node shadowtools.js servers use Frankfurt
  node shadowtools.js ui --port 9000
`;

/** Splits argv into positional arguments and a flag map. */
function parseArgs(argv) {
    const positional = [];
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '-h' || arg === '--help') {
            flags.help = true;
        } else if (arg === '--limit') {
            flags.limit = argv[++i];
        } else if (arg === '--port') {
            flags.port = argv[++i];
        } else if (arg === '--server') {
            flags.server = argv[++i];
        } else if (arg.startsWith('--')) {
            flags[arg.slice(2)] = true;
        } else {
            positional.push(arg);
        }
    }
    return { positional, flags };
}

/** Finds a key by exact id, then by exact name, then by case-insensitive name. */
function findKey(keys, needle) {
    const byId = keys.find(key => String(key.id) === needle);
    if (byId) return byId;

    const matches = keys.filter(key => key.name === needle);
    const found = matches.length ? matches : keys.filter(
        key => (key.name || '').toLowerCase() === needle.toLowerCase()
    );

    if (found.length === 0) {
        throw new UserError(`No access key matches "${needle}". Run "list" to see the available keys.`);
    }
    if (found.length > 1) {
        const ids = found.map(key => key.id).join(', ');
        throw new UserError(`"${needle}" matches more than one key (ids: ${ids}). Use the key id instead.`);
    }
    return found[0];
}

/** The same id-then-name resolution, over the configured servers. */
function findServer(servers, needle) {
    const byId = servers.find(server => server.id === needle);
    if (byId) return byId;

    const exact = servers.filter(server => server.name === needle);
    const found = exact.length
        ? exact
        : servers.filter(server => (server.name || '').toLowerCase() === needle.toLowerCase());

    if (found.length === 0) {
        throw new UserError(`No server matches "${needle}". Run "servers" to see the configured servers.`);
    }
    if (found.length > 1) {
        throw new UserError(`"${needle}" matches more than one server. Use the server id instead.`);
    }
    return found[0];
}

/** Reads an access code piped or typed into stdin, so it stays out of shell history. */
function readStdin() {
    return new Promise((resolve, reject) => {
        let text = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => (text += chunk));
        process.stdin.on('end', () => resolve(text));
        process.stdin.on('error', reject);
    });
}

function printQr(label, accessUrl) {
    console.log(`\n${label}:`);
    qrcode.generate(accessUrl, { small: true });
}

/** Chooses table, JSON or CSV output based on the flags given. */
function output(columns, rows, flags) {
    if (flags.json) console.log(JSON.stringify(rows, null, 2));
    else if (flags.csv) printCsv(columns, rows);
    else printTable(columns, rows);
}

const commands = {
    async list(ctx, args, flags) {
        const keys = await ctx.client.listKeys();
        const rows = keys.map(key => ({
            id: key.id,
            name: key.name || '(unnamed)',
            limit: key.dataLimit ? formatBytes(key.dataLimit.bytes) : '-',
            accessUrl: rewriteAccessUrl(key.accessUrl, ctx.client.hostname, ctx.host),
        }));

        output(
            [
                { key: 'id', header: 'ID' },
                { key: 'name', header: 'NAME' },
                { key: 'limit', header: 'LIMIT' },
                { key: 'accessUrl', header: 'ACCESS URL' },
            ],
            rows,
            flags
        );

        if (flags.qr && !flags.json && !flags.csv) {
            for (const row of rows) printQr(row.name, row.accessUrl);
        }
    },

    async add(ctx, args, flags) {
        const name = args.join(' ').trim();
        if (!name) throw new UserError('Please give the new key a name, e.g. add Alice');

        const key = await ctx.client.createKey(name);
        if (flags.limit) {
            await ctx.client.setKeyDataLimit(key.id, parseBytes(flags.limit));
        }

        const accessUrl = rewriteAccessUrl(key.accessUrl, ctx.client.hostname, ctx.host);
        console.log(`Created key "${name}" (id ${key.id})`);
        if (flags.limit) console.log(`Data limit: ${formatBytes(parseBytes(flags.limit))}`);
        console.log(accessUrl);
        if (flags.qr) printQr(name, accessUrl);
    },

    async remove(ctx, args) {
        if (!args[0]) throw new UserError('Please say which key to remove, e.g. remove Alice');
        const key = findKey(await ctx.client.listKeys(), args[0]);
        await ctx.client.removeKey(key.id);
        console.log(`Removed key "${key.name || key.id}" (id ${key.id})`);
    },

    async rename(ctx, args) {
        const newName = args.slice(1).join(' ').trim();
        if (!args[0] || !newName) {
            throw new UserError('Please give both a key and a new name, e.g. rename Alice Bob');
        }
        const key = findKey(await ctx.client.listKeys(), args[0]);
        await ctx.client.renameKey(key.id, newName);
        console.log(`Renamed key ${key.id} from "${key.name || '(unnamed)'}" to "${newName}"`);
    },

    async limit(ctx, args) {
        const [target, size] = args;
        if (!target || !size) {
            throw new UserError('Please give a key and a size, e.g. limit Alice 10GB (or limit Alice none)');
        }
        const clearing = size.toLowerCase() === 'none';

        if (target === 'server') {
            if (clearing) {
                await ctx.client.clearServerDataLimit();
                console.log('Cleared the server-wide default data limit.');
            } else {
                const bytes = parseBytes(size);
                await ctx.client.setServerDataLimit(bytes);
                console.log(`Server-wide default data limit set to ${formatBytes(bytes)}.`);
            }
            return;
        }

        const key = findKey(await ctx.client.listKeys(), target);
        if (clearing) {
            await ctx.client.clearKeyDataLimit(key.id);
            console.log(`Cleared the data limit on "${key.name || key.id}".`);
        } else {
            const bytes = parseBytes(size);
            await ctx.client.setKeyDataLimit(key.id, bytes);
            console.log(`Data limit on "${key.name || key.id}" set to ${formatBytes(bytes)}.`);
        }
    },

    async usage(ctx, args, flags) {
        const [keys, transferred] = await Promise.all([
            ctx.client.listKeys(),
            ctx.client.getTransferMetrics(),
        ]);

        const rows = keys
            .map(key => {
                const bytes = transferred[key.id] || 0;
                const limitBytes = key.dataLimit ? key.dataLimit.bytes : null;
                return {
                    id: key.id,
                    name: key.name || '(unnamed)',
                    used: formatBytes(bytes),
                    limit: limitBytes === null ? '-' : formatBytes(limitBytes),
                    percent: limitBytes ? Math.round((bytes / limitBytes) * 100) + '%' : '-',
                    bytes,
                };
            })
            .sort((a, b) => b.bytes - a.bytes);

        output(
            [
                { key: 'id', header: 'ID' },
                { key: 'name', header: 'NAME' },
                { key: 'used', header: 'USED' },
                { key: 'limit', header: 'LIMIT' },
                { key: 'percent', header: 'OF LIMIT' },
            ],
            rows,
            flags
        );

        if (!flags.json && !flags.csv) {
            const total = rows.reduce((sum, row) => sum + row.bytes, 0);
            console.log(`\nTotal transferred: ${formatBytes(total)}`);
        }
    },

    async qr(ctx, args) {
        if (!args[0]) throw new UserError('Please say which key to show, e.g. qr Alice');
        const key = findKey(await ctx.client.listKeys(), args[0]);
        printQr(key.name || String(key.id), rewriteAccessUrl(key.accessUrl, ctx.client.hostname, ctx.host));
    },
};

/**
 * Commands that manage the servers themselves rather than the keys on one, so
 * they take the registry and never need a reachable Outline server.
 */
const serverCommands = {
    async list(registry, args, flags) {
        const servers = registry.list();

        // JSON is for scripts, so give them the structured records rather than
        // the table's display strings — booleans, not asterisks.
        if (flags.json) {
            console.log(JSON.stringify(servers, null, 2));
            return;
        }

        if (!servers.length) {
            console.log('No Outline servers configured yet.');
            console.log('Add one with "servers add <name>", or open the dashboard with "ui".');
            return;
        }

        const rows = servers.map(server => ({
            active: server.active ? '*' : '',
            id: server.id,
            name: server.name || '(unnamed)',
            host: server.domain || server.host,
            source: server.source === 'env' ? 'environment' : 'saved',
            pinned: server.certPinned ? 'yes' : 'no',
        }));

        output(
            [
                { key: 'active', header: '' },
                { key: 'id', header: 'ID' },
                { key: 'name', header: 'NAME' },
                { key: 'host', header: 'HOST' },
                { key: 'source', header: 'SOURCE' },
                { key: 'pinned', header: 'CERT PINNED' },
            ],
            rows,
            flags
        );

        if (!flags.json && !flags.csv && registry.storePath) {
            console.log(`\nSaved servers live in ${registry.storePath}`);
        }
    },

    async add(registry, args) {
        const name = args.join(' ').trim();
        if (process.stdin.isTTY) {
            console.error('Paste the access code from Outline Manager > Settings, then press Ctrl+D:');
        }
        const accessCode = await readStdin();

        const id = registry.add({ name, accessCode });
        console.log(`Saved server "${name || id}" (id ${id}) and made it active.`);
        if (registry.storePath) console.log(`Stored in ${registry.storePath}`);
    },

    async use(registry, args) {
        if (!args[0]) throw new UserError('Please say which server to use, e.g. servers use Frankfurt');
        const server = findServer(registry.list(), args[0]);
        registry.activate(server.id);
        console.log(`Now acting on "${server.name || server.host}" (id ${server.id}).`);
    },

    async remove(registry, args) {
        if (!args[0]) throw new UserError('Please say which server to remove, e.g. servers remove Frankfurt');
        const server = findServer(registry.list(), args[0]);
        registry.remove(server.id);
        console.log(`Forgot "${server.name || server.host}". The server itself is untouched.`);
    },
};

/** The whole `servers` command family, dispatched on its first argument. */
async function serversCommand(registry, args, flags) {
    const [sub, ...rest] = args;
    const run = serverCommands[sub || 'list'];
    if (!run) {
        throw new UserError(`Unknown servers command "${sub}". Try: servers, servers add, servers use, servers remove.`);
    }
    await run(registry, rest, flags);
}

async function uiCommand(registry, args, flags) {
    const { start } = require('./lib/server');

    const port = flags.port === undefined ? 8787 : Number(flags.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new UserError(`"${flags.port}" is not a valid port.`);
    }

    let started;
    try {
        started = await start({ registry, port });
    } catch (err) {
        if (err.code === 'EADDRINUSE') {
            throw new UserError(`Port ${port} is already in use. Choose another with --port.`);
        }
        throw err;
    }

    console.log('Dashboard running. Open this URL:');
    console.log(`\n  ${started.url}\n`);
    console.log('It listens on localhost only, and the token in the URL authorises it.');
    if (!registry.list().length) {
        console.log('No servers configured yet — add your first one from the Servers section.');
    }
    console.log('Press Ctrl+C to stop.');

    // Resolve only when the server closes, so the CLI stays alive serving it.
    await new Promise(resolve => {
        const stop = () => started.server.close(resolve);
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        started.server.once('close', resolve);
    });
}

/** Builds the registry from the environment and the saved config file. */
function buildRegistry() {
    // The placeholder means "not configured", not "a server at xx.xx.xx.xxx".
    const configured = managementApiUrl && !managementApiUrl.includes('xx.xx.xx.xxx');
    return createRegistry({
        store: createStore(),
        env: configured ? { apiUrl: managementApiUrl, certSha256, domain } : null,
    });
}

/** Picks the server a key command acts on: --server if given, else the active one. */
function contextFor(registry, flags) {
    if (flags.server) {
        const chosen = findServer(registry.list(), flags.server);
        const { server, client } = registry.clientById(chosen.id);
        return { registry, server, client, host: server.domain || client.hostname };
    }

    const { server, client } = registry.activeClient();
    return { registry, server, client, host: server.domain || client.hostname };
}

async function main() {
    const { positional, flags } = parseArgs(process.argv.slice(2));
    const [commandName, ...args] = positional;

    if (flags.help || commandName === 'help') {
        console.log(USAGE);
        return;
    }

    const registry = buildRegistry();

    // These two manage or serve the configuration itself, so they must work
    // before any Outline server exists — that is how the first one gets added.
    if (commandName === 'servers') return serversCommand(registry, args, flags);
    if (commandName === 'ui') return uiCommand(registry, args, flags);

    // Listing is the historical default, so bare `node shadowtools.js` still works.
    const command = commands[commandName || 'list'];
    if (!command) {
        throw new UserError(`Unknown command "${commandName}". Run with --help to see what is available.`);
    }

    await command(contextFor(registry, flags), args, flags);
}

// Only run when invoked directly, so the tests can import the helpers below.
if (require.main === module) {
    main().catch(err => {
        console.error(err instanceof UserError ? err.message : `Error: ${err.message}`);
        process.exit(1);
    });
}

module.exports = { parseArgs, findKey, findServer };
