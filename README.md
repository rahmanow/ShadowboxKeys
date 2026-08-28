# shadowtools

[![CI](https://github.com/rahmanow/shadowtools/actions/workflows/ci.yml/badge.svg)](https://github.com/rahmanow/shadowtools/actions/workflows/ci.yml)

Manage access keys on your [Outline VPN](https://getoutline.org/) (Shadowbox) server, from the terminal, a local web interface, or your own code. It lists, creates, renames and deletes keys, sets per-key data limits, reports how much data each key has used, and prints scannable QR codes so people can onboard with the Outline app instead of copy-pasting `ss://` strings.

It can also rewrite every access URL to use your own domain in place of the server's raw IP address — handy when you have pointed a domain at your Outline server, or when your provider's IP has been blocked and you have restored the server elsewhere.

This project supersedes [outline-br](https://github.com/rahmanow/outline-br), whose `getKeys()` module lives on here. See [migrating from outline-br](#migrating-from-outline-br).

## Prerequisites

- [Node.js](https://nodejs.org/) 14 or newer (with npm)
- An Outline server set up via [Outline Manager](https://getoutline.org/get-started/)
- Your server's **Management API URL** — in Outline Manager open your server, go to **Settings**, and copy the *Management API URL* (it looks like `https://1.2.3.4:16942/AbCdEf123...`)

## Installation

```bash
git clone https://github.com/rahmanow/shadowtools.git
cd shadowtools
npm install
```

## Configuration

Configure the tool either with environment variables (recommended — keeps secrets out of the code) or by editing the constants at the top of `shadowtools.js`.

| Setting | Environment variable | Description |
| --- | --- | --- |
| Management API URL | `OUTLINE_API_URL` | The Management API URL copied from Outline Manager. **Required.** |
| Certificate fingerprint | `OUTLINE_CERT_SHA256` | The server's `certSha256`. Optional but **recommended** — see [certificate pinning](#certificate-pinning). |
| Custom domain | `OUTLINE_DOMAIN` | A domain that points at your Outline server. Optional — leave empty to keep the raw IP in the access URLs. |

Outline Manager gives you the first two together. Under **Settings → Management API URL** it shows a line like:

```json
{"apiUrl":"https://1.2.3.4:16942/AbCdEf123","certSha256":"E3823F9BB490D354...52F5A584"}
```

A convenient way to keep these out of your shell history is a `.env` file (already git-ignored) that you source before running:

```bash
# .env
export OUTLINE_API_URL="https://1.2.3.4:16942/AbCdEf123"
export OUTLINE_CERT_SHA256="E3823F9BB490D354...52F5A584"
export OUTLINE_DOMAIN="vpn.example.com"
```

```bash
source .env
```

> ⚠️ The Management API URL grants full administrative control of your Outline server. Treat it like a password: don't commit it to version control or share it.

## Commands

```
node shadowtools.js <command> [options]
```

| Command | What it does |
| --- | --- |
| `list` | List every access key with its id, name, data limit and access URL |
| `add <name>` | Create a new access key |
| `remove <key>` | Delete an access key |
| `rename <key> <new name>` | Rename an access key |
| `limit <key> <size\|none>` | Set or clear a key's data limit |
| `limit server <size\|none>` | Set or clear the server-wide default data limit |
| `usage` | Show how much data each key has transferred |
| `qr <key>` | Print a key's access URL as a scannable QR code |
| `ui` | Open a local web interface covering all of the above |

`<key>` may be either a key id or a key name. Running with no command at all is the same as `list`, so the original behaviour still works.

| Option | Applies to | Effect |
| --- | --- | --- |
| `--qr` | `list`, `add` | Also print a QR code for each key |
| `--json` | `list`, `usage` | Output JSON instead of a table |
| `--csv` | `list`, `usage` | Output CSV instead of a table |
| `--limit <size>` | `add` | Give the new key a data limit straight away |
| `--port <n>` | `ui` | Port for the web interface (default 8787) |
| `-h`, `--help` | — | Show usage |

Sizes accept a unit suffix: `10GB`, `500MB`, `2TB`, or a plain byte count.

## Examples

List every key:

```console
$ node shadowtools.js list
ID  NAME   LIMIT  ACCESS URL
--  -----  -----  -----------------------------------------------------
0   Alice  10 GB  ss://YWVzOnBhc3N3b3Jk@vpn.example.com:443/?outline=1
1   Bob    -      ss://YWVzOnBhc3N3b3Jk2@vpn.example.com:444/?outline=1
```

Create a key with a 50 GB cap and show its QR code:

```console
$ node shadowtools.js add Carol --limit 50GB --qr
Created key "Carol" (id 2)
Data limit: 50 GB
ss://bmV3a2V5@vpn.example.com:502/?outline=1

Carol:
█▀▀▀▀▀█ ▀▄█▀▄ █▀▀▀▀▀█
█ ███ █ █▄▀ ▀ █ ███ █
...
```

See who is using how much:

```console
$ node shadowtools.js usage
ID  NAME   USED    LIMIT  OF LIMIT
--  -----  ------  -----  --------
0   Alice  3.0 GB  10 GB  30%
1   Bob    512 MB  -      -

Total transferred: 3.5 GB
```

Cap a heavy user, then lift the cap later:

```bash
node shadowtools.js limit Alice 10GB
node shadowtools.js limit Alice none
```

Export usage for a spreadsheet:

```bash
node shadowtools.js usage --csv > usage.csv
```

## Web interface

If you would rather click than type:

```bash
node shadowtools.js ui
```

It prints a URL to open:

```
Web interface running. Open this URL:

  http://127.0.0.1:8787/?t=979ea2e12d7c5ba8e1d38631b2effd32583bca3b035775f3

It listens on localhost only, and the token in the URL authorises it.
Press Ctrl+C to stop.
```

The page lists every key with its usage, limit and access URL, and lets you add,
rename, delete, cap and show a QR code for any of them, plus set the server-wide
default cap. It follows your system light or dark theme. Use `--port` to move it
off 8787.

### How it is secured

The Management API URL is full administrative control of your Outline server, so
the interface is deliberately narrow:

- **It never leaves the process.** The browser talks only to this local server,
  which holds the credential and proxies each call. Nothing sensitive is sent to
  the page.
- **Loopback only.** It binds `127.0.0.1`, so nothing else on your network can
  reach it — not a shared-hosting concern, a deliberate limit.
- **Token-gated.** A random token is minted at each start and carried in the
  printed URL. Every API call must present it in a header, so another page open
  in the same browser cannot drive it, and requiring a custom header means a
  cross-origin attempt hits a CORS preflight that is never answered.
- **Host-checked.** Requests whose `Host` header is not the loopback address are
  refused, which is what stops DNS rebinding from turning an attacker's domain
  into a route to your machine.

The token changes every run, so old URLs stop working once you restart it. This
is a single-user local tool: do not put it behind a reverse proxy or expose the
port.

## Using it from code

Everything the CLI does is available as a module. `require` the package and you get three helpers plus the underlying client:

```js
const { listKeys, getUsage, getKeys, OutlineClient } = require('shadowtools');

const API = 'https://1.2.3.4:16942/AbCdEf123';
const options = { domain: 'vpn.example.com', certSha256: 'E3823F9B...52F5A584' };

// Structured key data
const keys = await listKeys(API, options);
// [{ id: '0', name: 'Alice', port: 443, dataLimitBytes: 10737418240,
//    accessUrl: 'ss://...@vpn.example.com:443/?outline=1' }, ...]

// Who is using how much
const usage = await getUsage(API, options);
// [{ id: '0', name: 'Alice', bytes: 3221225472, dataLimitBytes: 10737418240 }, ...]
```

`options` is optional throughout: `domain` swaps the host in each access URL, and `certSha256` pins the server's certificate exactly as the CLI does.

For anything the helpers do not cover — creating, renaming and deleting keys, or setting data limits — use the client directly:

```js
const client = new OutlineClient(API, 'E3823F9B...52F5A584');

const key = await client.createKey('Alice');
await client.setKeyDataLimit(key.id, 50 * 1024 ** 3);   // 50 GB
await client.renameKey(key.id, 'Alice B');
await client.clearKeyDataLimit(key.id);
await client.removeKey(key.id);

await client.setServerDataLimit(100 * 1024 ** 3);       // server-wide default
await client.clearServerDataLimit();
```

Failures caused by bad input or a bad response throw `UserError`, which is also exported, so you can tell them apart from bugs:

```js
const { UserError } = require('shadowtools');

try {
    await listKeys(API, { certSha256: expected });
} catch (err) {
    if (err instanceof UserError) console.error(err.message);  // e.g. wrong certificate
    else throw err;
}
```

### Migrating from outline-br

This project absorbed [outline-br](https://github.com/rahmanow/outline-br). Its `getKeys(managementApiUrl, newDomain)` is exported here with the same signature, the same `Name -> ss://...` output and the same printing behaviour, so existing code only needs its import changed:

```js
// before
const keys = require('outline-br');
keys('https://1.2.3.4:16942/AbCdEf123', '87.65.43.21');

// after
const { getKeys } = require('shadowtools');
await getKeys('https://1.2.3.4:16942/AbCdEf123', '87.65.43.21');
```

Two differences, both additive: `getKeys` now also returns the lines it printed, and it accepts a third `options` argument for `certSha256`. Nothing that worked before behaves differently.

New code should prefer `listKeys()`, which returns structured data and leaves presentation to you, rather than printing to stdout.

## Project layout

```
index.js           Programmatic API: listKeys, getUsage, getKeys
shadowtools.js     CLI entry point: argument parsing and commands
lib/outline.js     Outline Management API client
lib/format.js      Byte formatting, size parsing, table/CSV output
lib/errors.js      UserError, for messages shown without a stack trace
lib/server.js      Local web interface: HTTP routes and their guards
lib/web.js         The interface's page, inlined so it needs no assets
test/              Tests, run with the built-in Node test runner
```

## Development

Run the test suite:

```bash
npm test
```

The tests cover the pure logic — size parsing and formatting, access-URL rewriting, table and CSV rendering, argument parsing and key lookup — and need Node 18 or newer for the built-in test runner, even though the tool itself runs on Node 14+.

Every push and pull request runs the suite on Node 18, 20 and 22 via GitHub Actions, along with a syntax check and an audit of production dependencies. See [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## Releasing

Releases publish from CI, so no npm token exists on anyone's machine or in
repository secrets. Authentication uses npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers): GitHub Actions
proves its identity to the registry over OIDC, and npm attests the package's
provenance automatically.

To ship a version:

```bash
npm version minor        # or patch / major - commits and tags
git push --follow-tags
```

Then publish a GitHub Release for that tag. [`release.yml`](.github/workflows/release.yml)
installs, verifies the tag matches `package.json`, runs the tests through the
`prepublishOnly` hook, and publishes. A tag that disagrees with the version
fails before anything reaches the registry, which matters because a published
npm version can never be replaced.

### One-time setup

Trusted publishing has to be enabled on the registry side once, by a package
maintainer:

1. Open the package on npmjs.com, then **Settings → Trusted Publisher**.
2. Choose GitHub Actions and enter the organization (`rahmanow`), the repository
   (`shadowtools`), and the workflow filename (`release.yml`).

Until that is configured, the workflow's publish step fails with an
authentication error — which is the safe direction to fail in.

## Certificate pinning

Outline servers use a self-signed TLS certificate for the Management API, so the usual chain validation cannot apply and the tool disables it (`rejectUnauthorized: false`). On its own that would leave the connection open to a man-in-the-middle: anything that can answer on the server's address would be trusted.

Setting `OUTLINE_CERT_SHA256` closes that gap. The tool then checks the certificate the server presents against the fingerprint you configured, and **aborts before sending anything** if they differ:

```console
$ OUTLINE_CERT_SHA256=aaaa...aaaa node shadowtools.js list
The server presented an unexpected TLS certificate, so the request was not sent.
  expected: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  received: e3823f9bb490d35487ee013ec7d23a3662f76b95eb01a40f4851905152f5a584
Check OUTLINE_CERT_SHA256 against certSha256 in Outline Manager. If it has not
changed there, you may be talking to the wrong server.
```

The check runs at the end of the TLS handshake, before any request bytes leave your machine. That ordering matters: the path in the Management API URL *is* the admin credential, so it must never be sent to a server that hasn't been authenticated.

The fingerprint is accepted in either form — the bare hex Outline Manager reports as `certSha256`, or the colon-separated form `openssl x509 -noout -fingerprint -sha256` prints — in any case.

Pinning is optional for backwards compatibility. Leave `OUTLINE_CERT_SHA256` unset and the tool behaves as before, connecting without verifying which server answered. Set it whenever you can, especially on an untrusted network.

If you rebuild or migrate your server, its certificate changes; copy the new `certSha256` from Outline Manager.

### Why `node:https` rather than `fetch()`

The HTTP calls use the built-in `node:https` module because the global `fetch()` has no supported way to relax certificate checks or inspect the peer certificate for a single request — it ignores the `agent` option, and its dispatcher lives in `undici`, which would mean taking on a dependency to do what `node:https` already does.

## Troubleshooting

- **`Please configure your Management API URL first`** — set `OUTLINE_API_URL`, or replace the placeholder in `shadowtools.js`.
- **`Could not reach the Outline server`** — check that the Management API URL is correct and that its port (usually `16942`) is reachable from your machine.
- **`Cannot find module 'qrcode-terminal'`** — run `npm install` in the project directory first.
- **`The server presented an unexpected TLS certificate`** — either `OUTLINE_CERT_SHA256` is stale (recopy `certSha256` from Outline Manager after rebuilding or migrating the server), or something other than your Outline server answered. See [certificate pinning](#certificate-pinning).
- **`is not a SHA-256 certificate fingerprint`** — `OUTLINE_CERT_SHA256` must be 64 hex characters, with or without colons.
- **`Port 8787 is already in use`** — something else has the port; pass `--port 9000` (or any free port).
- **The web interface says the token is invalid** — it is regenerated on every start, so reopen the URL currently printed in your terminal.
- **`Management API responded with 404`** — your Outline server may be running an older release that lacks data-limit or metrics endpoints. Upgrade the server, or stick to `list`, `add`, `remove` and `rename`.
- **Keys print with the IP instead of your domain** — make sure `OUTLINE_DOMAIN` (or the `domain` constant) is set and non-empty.

## License

[MIT](LICENSE), carried over from outline-br when the two projects merged.
