#!/usr/bin/env node
'use strict';

// BEGIN Variables to change
// Prefer setting these via environment variables (OUTLINE_API_URL, OUTLINE_DOMAIN)
// so the Management API URL never ends up committed to version control.
const managementApiUrl = process.env.OUTLINE_API_URL || 'https://xx.xx.xx.xxx:16942/xxxxxxxxxxxxxxxxxxxxxx'; // Management API URL from Outline Manager > Settings
const domain = process.env.OUTLINE_DOMAIN || ''; // set your custom domain if you have one, e.g. 'vpn.example.com'
const certSha256 = process.env.OUTLINE_CERT_SHA256 || ''; // recommended: certSha256 from Outline Manager, to pin the server's certificate
// END Variables to change

const qrcode = require('qrcode-terminal');
const { OutlineClient } = require('./lib/outline');
const { UserError } = require('./lib/errors');
const { formatBytes, parseBytes, rewriteAccessUrl, printTable, printCsv } = require('./lib/format');

const USAGE = `ShadowboxKeys - manage access keys on your Outline VPN server

Usage: node shadowboxKey.js <command> [options]

Commands:
  list                        List every access key with its access URL
  add <name>                  Create a new access key
  remove <key>                Delete an access key
  rename <key> <new name>     Rename an access key
  limit <key> <size|none>     Set or clear a key's data limit (use "server" as
                              the key to set the server-wide default limit)
  usage                       Show data transferred per key
  qr <key>                    Print an access key as a scannable QR code

<key> may be either a key id or a key name.

Options:
  --qr        Also print a QR code for each key (list, add)
  --json      Output JSON instead of a table (list, usage)
  --csv       Output CSV instead of a table (list, usage)
  --limit <size>  Data limit for a newly created key (add)
  -h, --help  Show this help

Sizes accept a unit suffix, e.g. 10GB, 500MB, 2TB.

Configuration (environment variables):
  OUTLINE_API_URL      Management API URL from Outline Manager > Settings
  OUTLINE_DOMAIN       Optional custom domain to use in place of the server IP
  OUTLINE_CERT_SHA256  Recommended. The server's certSha256, from the same place
                       in Outline Manager. When set, the tool refuses to talk to
                       any server presenting a different certificate.

Examples:
  node shadowboxKey.js list --qr
  node shadowboxKey.js add Alice --limit 50GB
  node shadowboxKey.js limit Alice 10GB
  node shadowboxKey.js usage --csv
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
    async list(client, host, args, flags) {
        const keys = await client.listKeys();
        const rows = keys.map(key => ({
            id: key.id,
            name: key.name || '(unnamed)',
            limit: key.dataLimit ? formatBytes(key.dataLimit.bytes) : '-',
            accessUrl: rewriteAccessUrl(key.accessUrl, client.hostname, host),
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

    async add(client, host, args, flags) {
        const name = args.join(' ').trim();
        if (!name) throw new UserError('Please give the new key a name, e.g. add Alice');

        const key = await client.createKey(name);
        if (flags.limit) {
            await client.setKeyDataLimit(key.id, parseBytes(flags.limit));
        }

        const accessUrl = rewriteAccessUrl(key.accessUrl, client.hostname, host);
        console.log(`Created key "${name}" (id ${key.id})`);
        if (flags.limit) console.log(`Data limit: ${formatBytes(parseBytes(flags.limit))}`);
        console.log(accessUrl);
        if (flags.qr) printQr(name, accessUrl);
    },

    async remove(client, host, args) {
        if (!args[0]) throw new UserError('Please say which key to remove, e.g. remove Alice');
        const key = findKey(await client.listKeys(), args[0]);
        await client.removeKey(key.id);
        console.log(`Removed key "${key.name || key.id}" (id ${key.id})`);
    },

    async rename(client, host, args) {
        const newName = args.slice(1).join(' ').trim();
        if (!args[0] || !newName) {
            throw new UserError('Please give both a key and a new name, e.g. rename Alice Bob');
        }
        const key = findKey(await client.listKeys(), args[0]);
        await client.renameKey(key.id, newName);
        console.log(`Renamed key ${key.id} from "${key.name || '(unnamed)'}" to "${newName}"`);
    },

    async limit(client, host, args) {
        const [target, size] = args;
        if (!target || !size) {
            throw new UserError('Please give a key and a size, e.g. limit Alice 10GB (or limit Alice none)');
        }
        const clearing = size.toLowerCase() === 'none';

        if (target === 'server') {
            if (clearing) {
                await client.clearServerDataLimit();
                console.log('Cleared the server-wide default data limit.');
            } else {
                const bytes = parseBytes(size);
                await client.setServerDataLimit(bytes);
                console.log(`Server-wide default data limit set to ${formatBytes(bytes)}.`);
            }
            return;
        }

        const key = findKey(await client.listKeys(), target);
        if (clearing) {
            await client.clearKeyDataLimit(key.id);
            console.log(`Cleared the data limit on "${key.name || key.id}".`);
        } else {
            const bytes = parseBytes(size);
            await client.setKeyDataLimit(key.id, bytes);
            console.log(`Data limit on "${key.name || key.id}" set to ${formatBytes(bytes)}.`);
        }
    },

    async usage(client, host, args, flags) {
        const [keys, transferred] = await Promise.all([
            client.listKeys(),
            client.getTransferMetrics(),
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

    async qr(client, host, args) {
        if (!args[0]) throw new UserError('Please say which key to show, e.g. qr Alice');
        const key = findKey(await client.listKeys(), args[0]);
        printQr(key.name || String(key.id), rewriteAccessUrl(key.accessUrl, client.hostname, host));
    },
};

async function main() {
    const { positional, flags } = parseArgs(process.argv.slice(2));
    const [commandName, ...args] = positional;

    if (flags.help || commandName === 'help') {
        console.log(USAGE);
        return;
    }

    // Listing is the historical default, so bare `node shadowboxKey.js` still works.
    const command = commands[commandName || 'list'];
    if (!command) {
        throw new UserError(`Unknown command "${commandName}". Run with --help to see what is available.`);
    }

    if (managementApiUrl.includes('xx.xx.xx.xxx')) {
        throw new UserError(
            'Please configure your Management API URL first.\n' +
            'Set the OUTLINE_API_URL environment variable, or edit the managementApiUrl constant in shadowboxKey.js.'
        );
    }

    const client = new OutlineClient(managementApiUrl, certSha256);
    await command(client, domain || client.hostname, args, flags);
}

// Only run when invoked directly, so the tests can import the helpers below.
if (require.main === module) {
    main().catch(err => {
        console.error(err instanceof UserError ? err.message : `Error: ${err.message}`);
        process.exit(1);
    });
}

module.exports = { parseArgs, findKey };
