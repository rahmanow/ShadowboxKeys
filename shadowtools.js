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
const { createStore, readToken, rotateToken, tokenPath } = require('./lib/config');
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
  ui                          Serve the admin dashboard until you stop it
  service install             Run the dashboard in the background, from login on
  service status              Whether it is running, and the URL to open
  service start|stop|restart  Control the background service
  service logs                Show what the background service has printed
  service url                 Print the dashboard URL
  service uninstall           Stop it and remove the service definition

<key> may be either a key id or a key name.
<server> may be either a server id or a server name.

Options:
  --qr        Also print a QR code for each key (list, add)
  --json      Output JSON instead of a table (list, usage, servers)
  --csv       Output CSV instead of a table (list, usage, servers)
  --limit <size>  Data limit for a newly created key (add)
  --server <s>    Act on this server instead of the active one
  --port <n>  Port for the dashboard (ui, service install; default 8787)
  --lines <n> How many log lines to show (service logs, default 50)
  --follow    Keep printing new log lines (service logs)
  --rotate    Mint a new token, invalidating existing links (service url)
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
  node shadowtools.js service install
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
        } else if (arg === '--lines') {
            flags.lines = argv[++i];
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

/** Validates a --port value, since a typo here is otherwise a confusing crash. */
function parsePort(given, fallback = 8787) {
    if (given === undefined) return fallback;
    const port = Number(given);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new UserError(`"${given}" is not a valid port.`);
    }
    return port;
}

async function uiCommand(registry, args, flags) {
    const { start } = require('./lib/server');

    const port = parsePort(flags.port);

    let started;
    try {
        // The stored token, so this URL and the background service's agree and
        // a bookmark keeps working whichever one is serving.
        started = await start({ registry, port, token: readToken() });
    } catch (err) {
        if (err.code === 'EADDRINUSE') {
            throw new UserError(
                `Port ${port} is already in use. If that is the background service, ` +
                'it is already serving the dashboard — run "shadowtools service status" ' +
                'for its URL. Otherwise choose another port with --port.'
            );
        }
        throw err;
    }

    // Under a service manager stdout is a log file, not a terminal — and the
    // token in that URL is the only thing standing between another local user
    // and this dashboard. A log is the wrong place for it, so print the URL
    // whole only when a person is looking at it.
    if (process.stdout.isTTY) {
        console.log('Dashboard running. Open this URL:');
        console.log(`\n  ${started.url}\n`);
        console.log('It listens on localhost only, and the token in the URL authorises it.');
        if (!registry.list().length) {
            console.log('No servers configured yet — add your first one from the Servers section.');
        }
        console.log('Press Ctrl+C to stop.');
    } else {
        console.log(
            `[${new Date().toISOString()}] dashboard listening on 127.0.0.1:${started.port} — ` +
            'run "shadowtools service url" for the address to open'
        );
    }

    // Resolve only when the server closes, so the CLI stays alive serving it.
    await new Promise(resolve => {
        const stop = () => started.server.close(resolve);
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        started.server.once('close', resolve);
    });
}

/* ---------------------------------------------------------------------------
 * The background service.
 * ------------------------------------------------------------------------- */

const dashboardUrl = port => `http://127.0.0.1:${port}/?t=${readToken()}`;

const serviceCommands = {
    async install(service, args, flags) {
        const port = parsePort(flags.port, service.DEFAULT_PORT);
        const result = service.install({ port });

        console.log(`Installed ${result.kind === 'launchd' ? service.LABEL : service.UNIT} and started it.`);
        console.log(`\nDashboard: ${dashboardUrl(port)}\n`);
        console.log(`Definition: ${result.definition}`);
        if (result.log) console.log(`Log:        ${result.log}`);
        console.log('It starts at login and restarts if it exits. It listens on localhost only.');

        // A service does not inherit the shell it was installed from, so a
        // server that exists only as an environment variable would silently
        // vanish from the dashboard. Say so now rather than let it puzzle.
        if (result.skipped.length) {
            console.log(
                `\n${result.skipped.join(' and ')} ${result.skipped.length > 1 ? 'are' : 'is'} set here but ` +
                'deliberately not written into the service definition, which is not a ' +
                'place for credentials. The service sees only saved servers, so add ' +
                'that one with "servers add" if you want it in the background dashboard.'
            );
        }

        await reportReachable(service, port);
    },

    async uninstall(service) {
        const { log } = service.paths();
        const definition = service.uninstall();

        console.log(`Stopped the service and removed ${definition}.`);
        console.log('Your saved servers and keys are untouched.');
        // Kept deliberately: it is the record of why the service stopped, and
        // the one thing worth reading after an uninstall you did not intend.
        if (log && require('fs').existsSync(log)) console.log(`Its log remains at ${log}.`);
    },

    async start(service) {
        service.start();
        const { port } = service.status();
        console.log(`Started. Dashboard: ${dashboardUrl(port)}`);
        await reportReachable(service, port);
    },

    async stop(service) {
        service.stop();
        console.log('Stopped.');
    },

    async restart(service) {
        service.restart();
        const { port } = service.status();
        console.log(`Restarted. Dashboard: ${dashboardUrl(port)}`);
        await reportReachable(service, port);
    },

    async status(service, args, flags) {
        const state = service.status();

        if (flags.json) {
            console.log(JSON.stringify({ ...state, answering: await service.probe(state.port) }, null, 2));
            return;
        }

        if (!state.installed) {
            console.log('not installed');
            console.log('\nRun "shadowtools service install" to run the dashboard in the background.');
            return;
        }

        const answering = await service.probe(state.port);
        const where = state.running ? `pid ${state.pid || '?'}` : 'not running';
        console.log(`${state.running ? 'running' : 'stopped'}  ${where}  port ${state.port}`);
        console.log(`Dashboard: ${dashboardUrl(state.port)}`);
        console.log(`Definition: ${state.definition}`);
        if (state.log) console.log(`Log:        ${state.log}`);

        // The service manager only knows it launched the process. Whether the
        // dashboard actually bound the port is a different question.
        if (state.running && !answering) {
            console.log(
                `\nIt is running but nothing is answering on port ${state.port}. ` +
                'Check "shadowtools service logs" — the port may be taken by something else.'
            );
        }
    },

    async logs(service, args, flags) {
        const lines = flags.lines === undefined ? 50 : Number(flags.lines);
        if (!Number.isInteger(lines) || lines <= 0) {
            throw new UserError(`"${flags.lines}" is not a number of lines.`);
        }

        const text = service.logs({ lines, follow: Boolean(flags.follow) });
        // A follower streams straight to the terminal and returns nothing.
        if (text === null) return;
        console.log(text || '(the service has printed nothing yet)');
    },

    async url(service, args, flags) {
        if (flags.rotate) {
            rotateToken();
            console.log('Minted a new token. Every link handed out before now is dead.');
            console.log(`Stored in ${tokenPath()}`);
            if (service.isInstalled() && service.status().running) {
                console.log('\nRestart the service to serve with it: shadowtools service restart');
            }
            console.log('');
        }

        // Useful even where no service manager is supported, or none is
        // installed: the URL is the same one `ui` serves.
        const installed = service.platform() && service.isInstalled();
        console.log(dashboardUrl(installed ? service.status().port : service.DEFAULT_PORT));
    },
};

/** Warns when the service is up but the port is not answering yet. */
async function reportReachable(service, port) {
    // Give it a moment: the service manager returns before the process binds.
    for (let attempt = 0; attempt < 10; attempt++) {
        if (await service.probe(port, 500)) return true;
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    console.log(
        `\nNothing is answering on port ${port} yet. If it does not come up, ` +
        'check "shadowtools service logs".'
    );
    return false;
}

async function serviceCommand(args, flags) {
    const service = require('./lib/service');
    const [sub, ...rest] = args;

    const run = serviceCommands[sub || 'status'];
    if (!run) {
        throw new UserError(
            `Unknown service command "${sub}". Try: install, uninstall, start, stop, ` +
            'restart, status, logs, url.'
        );
    }
    await run(service, rest, flags);
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
    if (commandName === 'service') return serviceCommand(args, flags);
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
