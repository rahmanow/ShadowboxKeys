# shadowtools

[![CI](https://github.com/rahmanow/shadowtools/actions/workflows/ci.yml/badge.svg)](https://github.com/rahmanow/shadowtools/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/shadowtools.svg)](https://www.npmjs.com/package/shadowtools)

Manage access keys on your [Outline VPN](https://getoutline.org/) (Shadowbox) servers, from a local admin dashboard, the terminal, or your own code. It lists, creates, renames and deletes keys, sets per-key data limits, reports how much data each key has used, and shows scannable QR codes so people can onboard with the Outline app instead of copy-pasting `ss://` strings.

The dashboard manages the servers too: paste the access code from Outline Manager and it is saved for next time, so one panel covers every server you run rather than one shell per server.

It can also rewrite every access URL to use your own domain in place of the server's raw IP address — handy when you have pointed a domain at your Outline server, or when your provider's IP has been blocked and you have restored the server elsewhere.

This project supersedes [outline-br](https://github.com/rahmanow/outline-br), whose `getKeys()` module lives on here. See [migrating from outline-br](#migrating-from-outline-br).

## Prerequisites

- [Node.js](https://nodejs.org/) 14 or newer (with npm)
- One or more Outline servers set up via [Outline Manager](https://getoutline.org/get-started/)
- Each server's **access code** — in Outline Manager open the server, go to **Settings**, and copy the line under *Management API URL*

## Installation

```bash
git clone https://github.com/rahmanow/shadowtools.git
cd shadowtools
npm install
```

## Configuration

Everything starts from your server's **access code**. In Outline Manager, open your server and go to **Settings → Management API URL**; it shows a line like:

```json
{"apiUrl":"https://1.2.3.4:16942/AbCdEf123","certSha256":"E3823F9BB490D354...52F5A584"}
```

> ⚠️ That line grants full administrative control of your Outline server. Treat it like a password: don't commit it to version control or share it.

There are two ways to give it to shadowtools, and they work together.

### Add it in the dashboard (easiest, and handles several servers)

```bash
node shadowtools.js ui
```

Open the printed URL, go to **Servers → Add server**, and paste the access code. It is saved to a config file readable only by you, so the CLI picks it up too and you do not have to paste it again. Repeat for each server you run, and switch between them from the header.

You can do the same from the terminal — the access code is read from stdin so it stays out of your shell history:

```bash
pbpaste | node shadowtools.js servers add Frankfurt
```

### Or set environment variables (one server, nothing on disk)

| Setting | Environment variable | Description |
| --- | --- | --- |
| Management API URL | `OUTLINE_API_URL` | The `apiUrl` from the access code. |
| Certificate fingerprint | `OUTLINE_CERT_SHA256` | The `certSha256` from the same line. Optional but **recommended** — see [certificate pinning](#certificate-pinning). |
| Custom domain | `OUTLINE_DOMAIN` | A domain that points at your Outline server. Optional — leave empty to keep the raw IP in the access URLs. |
| Config file location | `SHADOWTOOLS_CONFIG` | Override where saved servers are stored. Optional. |
| Request timeout | `OUTLINE_TIMEOUT_MS` | How long to wait for a Management API response, in milliseconds. Optional, default 15000. |

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

A server configured this way appears in the dashboard alongside your saved ones, marked **environment**. It is never written to the config file, and it cannot be edited or removed from the panel — change the variables instead. You can still make it the active server with one click.

### Where saved servers live

`$XDG_CONFIG_HOME/shadowtools/config.json`, or `~/.config/shadowtools/config.json` when that is unset. The file is written mode `0600` inside a `0700` directory, because it holds Management API URLs: anyone who can read it can administer every server listed in it. Point `SHADOWTOOLS_CONFIG` somewhere else if you prefer.

The editing constants at the top of `shadowtools.js` still work, if you would rather not use either mechanism.

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
| `servers` | List the Outline servers this machine knows about |
| `servers add <name>` | Save a server, reading its access code from stdin |
| `servers use <server>` | Choose the server other commands act on |
| `servers remove <server>` | Forget a saved server (the server itself is untouched) |
| `ui` | Serve the admin dashboard until you stop it |
| `service install` | Run the dashboard in the background, from login on |
| `service status` | Whether it is running, and the URL to open |
| `service start` / `stop` / `restart` | Control the background service |
| `service logs` | Show what the background service has printed |
| `service url` | Print the dashboard URL |
| `service uninstall` | Stop it and remove the service definition |

`<key>` may be either a key id or a key name, and `<server>` either a server id or a server name. Running with no command at all is the same as `list`, so the original behaviour still works.

Key commands act on whichever server is active. Use `servers use` to change that, or `--server` to redirect a single command without changing it.

| Option | Applies to | Effect |
| --- | --- | --- |
| `--qr` | `list`, `add` | Also print a QR code for each key |
| `--json` | `list`, `usage`, `servers` | Output JSON instead of a table |
| `--csv` | `list`, `usage`, `servers` | Output CSV instead of a table |
| `--limit <size>` | `add` | Give the new key a data limit straight away |
| `--server <s>` | key commands | Act on this server instead of the active one |
| `--port <n>` | `ui`, `service install` | Port for the dashboard (default 8787) |
| `--lines <n>` | `service logs` | How many log lines to show (default 50) |
| `--follow` | `service logs` | Keep printing new lines |
| `--rotate` | `service url` | Mint a new token, invalidating existing links |
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

Work across servers:

```console
$ node shadowtools.js servers
   ID            NAME       HOST          SOURCE  CERT PINNED
-  ------------  ---------  ------------  ------  -----------
*  7009f5d5ff9d  Frankfurt  198.51.100.7  saved   yes
   d1cf000628fc  Singapore  203.0.113.4   saved   no

$ node shadowtools.js list --server Singapore
$ node shadowtools.js servers use Singapore
```

## Admin dashboard

If you would rather click than type:

```bash
node shadowtools.js ui
```

It prints a URL to open:

```
Dashboard running. Open this URL:

  http://127.0.0.1:8787/?t=979ea2e12d7c5ba8e1d38631b2effd32583bca3b035775f3

It listens on localhost only, and the token in the URL authorises it.
Press Ctrl+C to stop.
```

You can run it before configuring anything: with no servers yet, it opens on the
Servers section so you can paste your first access code. Use `--port` to move it
off 8787. It follows your system light or dark theme.

Four sections, switched from the sidebar:

| Section | What it covers |
| --- | --- |
| **Overview** | Key count, total transferred, the default cap, and which keys have hit their limit |
| **Access keys** | Every key with its usage, limit and access URL — add, rename, cap, delete, copy, or show a QR code |
| **Servers** | Add, edit, test, switch between and remove servers; reveal a server's access code to copy elsewhere |
| **Settings** | The active server's domain and default data cap, and where saved servers are stored |

The server picker in the header switches everything at once, with a dot showing
whether that server is answering. When one is unreachable, Overview and Access
keys say so and point you at Servers rather than showing a blank page — and
Servers and Settings keep working, since that is where you go to fix it.

### Running it in the background

`ui` serves the dashboard for as long as you keep the terminal open. To leave it
running and bookmark it:

```bash
node shadowtools.js service install
```

That registers it with whatever service manager the platform already has —
**launchd** on macOS, **systemd's user instance** on Linux — so it starts at
login, comes back if it crashes, and answers on the same URL every time.

```console
$ node shadowtools.js service status
running  pid 4821  port 8787
Dashboard: http://127.0.0.1:8787/?t=979ea2e12d7c5ba8e1d38631b2effd32583bca3b035775f3
Definition: ~/Library/LaunchAgents/com.rahmanow.shadowtools.plist
Log:        ~/Library/Logs/shadowtools/service.log
```

| Command | What it does |
| --- | --- |
| `service install` | Write the service definition and start it (`--port` to choose a port) |
| `service status` | Whether it is running, its pid and port, and the URL to open |
| `service start` / `stop` / `restart` | Control it |
| `service logs` | What it has printed (`--lines`, `--follow`) |
| `service url` | Print the dashboard URL (`--rotate` to invalidate existing links) |
| `service uninstall` | Stop it and remove the definition; saved servers are untouched |

Nothing here runs as root and nothing is installed system-wide. These are
per-user agents, which is the right privilege level for something holding one
user's Outline credentials, and it means no step asks for your password.
Windows has no equivalent here — run `ui` in a terminal instead.

Two consequences worth knowing:

- **The URL is now stable.** The token lives in `~/.config/shadowtools/token`
  (mode `0600`) instead of being minted per run, so a bookmark keeps working
  across restarts. `ui` reads the same file, so both ways of starting the
  dashboard hand out the same URL. If a link ends up somewhere it should not,
  `service url --rotate` mints a new one and kills every old link.
- **The service cannot see your shell.** A background agent does not inherit
  the environment you installed it from, and a service definition is an
  ordinary file that other tooling reads — so `OUTLINE_API_URL` and
  `OUTLINE_CERT_SHA256` are deliberately *not* written into it. A server
  configured only through those variables will not appear in the background
  dashboard; save it with `servers add` first. `install` warns you when it
  sees them set.

### Trying the interface without a server

A preview of the dashboard runs at
**[shadowtools-preview.rahmanow.workers.dev](https://shadowtools-preview.rahmanow.workers.dev)**,
on invented data. It serves the page from `lib/web.js` unmodified, so it cannot
drift from what the tool actually shows; only the data behind it is made up.
Useful for looking at the interface — including the states that are awkward to
reach on purpose, like a key over its limit and a server that will not answer —
without setting anything up.

It is a preview and not a deployment, and it cannot become one. An Outline
server's Management API is served with a self-signed certificate, which
shadowtools authenticates by [pinning the fingerprint](#certificate-pinning).
The Workers runtime has no equivalent: `fetch()` refuses any origin whose
certificate is not publicly trusted, and `connect()` exposes neither
verification control nor the peer certificate. So a Worker cannot talk to an
Outline server at all. The endpoints that would take an access code refuse
instead of storing one.

Deploy your own copy with `npx wrangler deploy`; see [`worker/`](worker/) and
[`wrangler.jsonc`](wrangler.jsonc). Neither is part of the npm package.

## Installing Outline on a new server

When a server gets blocked, the slow part of replacing it is standing up the
next one. Given SSH credentials, shadowtools does that for you:

```console
$ shadowtools provision 203.0.113.9 --keys 3 --qr
SSH username [root]:
Password for root@203.0.113.9:

203.0.113.9:22 is new. Its host key fingerprint is:

  SHA256:+VmCzKSFyvNZKhyK+ck3iMd1ayrM/wiH4J8mZ4p7gtM

Check that against your provider's console before accepting.
yes

Uploading the Outline installer to /tmp/outline-install-...
Running the installer. This takes a few minutes on a fresh server.
...
Installed Outline and saved it as "203.0.113.9" (id ef4a08d6d7cf).

Creating 3 access keys:

ss://...@203.0.113.9:443/?outline=1
```

Or from the dashboard: **Servers → Install on a server**. It asks for the same
details, shows the host key for you to confirm, and streams the installer's
output as it runs. A run outlives the dialog, so you can close it, reload, or
come back later and it will still be going.

The server is registered as it finishes, so `list`, `usage` and the dashboard
see it immediately. It works on any host you can SSH into — a large provider or
a small one, it makes no difference.

| Option | Effect |
| --- | --- |
| `--user`, `--key`, `--passphrase`, `--port` | How to authenticate over SSH |
| `--hostname` | Hostname or IP the server advertises in its access URLs |
| `--api-port`, `--keys-port` | Ports for the management API and the keys |
| `--name`, `--domain` | How the server is saved |
| `--keys <n>` | Access keys to create once it is up (default 1) |

`SHADOWTOOLS_INSTALL_SCRIPT` points at a local copy of `install_server.sh`, for
when this machine cannot reach GitHub either, or when you want to use a copy you
have vetted yourself.

Three things it does differently from the documented one-liner, each for a
reason that matters when the network is hostile:

- **SSH credentials are never stored.** They are used for one connection and
  dropped; only the resulting access code is saved. A panel that remembers root
  passwords hands over every server at once if the machine is seized.
- **The host key is checked, and a new one must be accepted explicitly.** The
  fingerprint shown is the same string `ssh-keyscan` and your provider's console
  print, so it can be compared. A key that *changes* is a hard failure, not a
  prompt — rerun with `provision forget <host>` if you genuinely rebuilt it.
- **The installer is uploaded over SSH rather than fetched by the server.**
  Outline's own instructions have the server pull the script from GitHub, which
  assumes it can reach GitHub unmolested — not a safe assumption for a host in
  a censored network, and one more thing for somebody else to answer.

### How it is secured

A Management API URL is full administrative control of an Outline server, so the
dashboard is deliberately narrow:

- **Credentials never leave the process.** The browser talks only to this local
  server, which holds them and proxies each call. The server list the page
  receives carries redacted URLs — enough to tell two servers apart, not enough
  to use. The full access code is served by one endpoint that exists for that
  purpose, and only when you click the button that asks for it.
- **Loopback only.** It binds `127.0.0.1`, so nothing else on your network can
  reach it — not a shared-hosting concern, a deliberate limit.
- **Token-gated.** A random token is minted at each start and carried in the
  printed URL. Every API call must present it in a header, so another page open
  in the same browser cannot drive it, and requiring a custom header means a
  cross-origin attempt hits a CORS preflight that is never answered.
- **Host-checked.** Requests whose `Host` header is not the loopback address are
  refused, which is what stops DNS rebinding from turning an attacker's domain
  into a route to your machine.

When you run `ui` yourself the URL is printed to your terminal. Under the
background service stdout is a log file, so the URL is deliberately *not*
printed there — the log says only that the dashboard is listening, and
`service url` is how you get the address. The log and its directory are created
`0600`/`0700` rather than left at the service manager's world-readable default.

This is a single-user local tool: do not put it behind a reverse proxy or
expose the port.

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
lib/config.js      Saved servers: access-code parsing and the on-disk store
lib/registry.js    The servers this install knows about, and their clients
lib/format.js      Byte formatting, size parsing, table/CSV output
lib/errors.js      UserError, for messages shown without a stack trace
lib/server.js      Dashboard: HTTP routes and their guards
lib/service.js     Running the dashboard as a launchd or systemd user service
lib/provision.js   Installing Outline on a server over SSH
lib/jobs.js        Tracking a provisioning run so the dashboard can watch it
lib/web.js         The dashboard page, inlined so it needs no assets
lib/qr.js          Vector QR codes for the dashboard
worker/            A Cloudflare Worker serving the dashboard on demo data
test/              Tests, run with the built-in Node test runner
```

## Development

Run the test suite:

```bash
npm test
```

The tests cover the pure logic — size parsing and formatting, access-URL rewriting, table and CSV rendering, argument parsing and key lookup — along with the config store, the server registry, the dashboard's HTTP routes and its guards, driven over a real socket against a stand-in Outline server. They need Node 18 or newer for the built-in test runner, even though the tool itself runs on Node 14+.

Every push and pull request runs the suite on Node 18, 20 and 22 via GitHub Actions, along with a syntax check and an audit of production dependencies. See [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## Releasing

Past releases are listed in [CHANGELOG.md](CHANGELOG.md).

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

- **`No Outline server is configured yet`** — add one in the dashboard (`node shadowtools.js ui`), pipe an access code into `servers add`, or set `OUTLINE_API_URL`.
- **`That server is already saved as ...`** — the same Management API URL is already in your config; edit that entry instead of adding a second one.
- **`comes from OUTLINE_API_URL in your environment`** — that server is defined by environment variables, so the dashboard will not rewrite it. Change the variables, or add it as a saved server.
- **`... is not valid JSON, so it was left untouched`** — the config file was hand-edited into an invalid state. Fix or delete it; nothing is overwritten until it parses.
- **`Could not reach the Outline server`** — check that the Management API URL is correct and that its port (usually `16942`) is reachable from your machine.
- **`did not respond within 15 seconds`** — the address accepted nothing and refused nothing, which usually means a wrong IP or a firewall dropping the port. Raise `OUTLINE_TIMEOUT_MS` if your link is genuinely that slow.
- **`Cannot find module 'qrcode-terminal'`** — run `npm install` in the project directory first.
- **`The server presented an unexpected TLS certificate`** — either `OUTLINE_CERT_SHA256` is stale (recopy `certSha256` from Outline Manager after rebuilding or migrating the server), or something other than your Outline server answered. See [certificate pinning](#certificate-pinning).
- **`is not a SHA-256 certificate fingerprint`** — `OUTLINE_CERT_SHA256` must be 64 hex characters, with or without colons.
- **`Port 8787 is already in use`** — often the background service is already serving it; run `shadowtools service status` for its URL. Otherwise pass `--port 9000` (or any free port).
- **`service status` says running but nothing answers** — the process started and then failed to bind, usually because something else holds the port. Check `shadowtools service logs`.
- **The background dashboard shows no servers, but the CLI does** — the server is configured through `OUTLINE_API_URL`, which a background service cannot see. Save it with `shadowtools servers add` instead.
- **The dashboard says the token is invalid** — it is regenerated on every start, so reopen the URL currently printed in your terminal.
- **`Management API responded with 404`** — your Outline server may be running an older release that lacks data-limit or metrics endpoints. Upgrade the server, or stick to `list`, `add`, `remove` and `rename`.
- **Keys print with the IP instead of your domain** — make sure `OUTLINE_DOMAIN` (or the `domain` constant) is set and non-empty.

## License

[MIT](LICENSE), carried over from outline-br when the two projects merged.
