# ShadowboxKeys

A command-line tool for managing access keys on your [Outline VPN](https://getoutline.org/) (Shadowbox) server. It lists, creates, renames and deletes keys, sets per-key data limits, reports how much data each key has used, and prints scannable QR codes so people can onboard with the Outline app instead of copy-pasting `ss://` strings.

It can also rewrite every access URL to use your own domain in place of the server's raw IP address — handy when you have pointed a domain at your Outline server.

## Prerequisites

- [Node.js](https://nodejs.org/) 14 or newer (with npm)
- An Outline server set up via [Outline Manager](https://getoutline.org/get-started/)
- Your server's **Management API URL** — in Outline Manager open your server, go to **Settings**, and copy the *Management API URL* (it looks like `https://1.2.3.4:16942/AbCdEf123...`)

## Installation

```bash
git clone https://github.com/rahmanow/ShadowboxKeys.git
cd ShadowboxKeys
npm install
```

## Configuration

Configure the tool either with environment variables (recommended — keeps secrets out of the code) or by editing the two constants at the top of `shadowboxKey.js`.

| Setting | Environment variable | Description |
| --- | --- | --- |
| Management API URL | `OUTLINE_API_URL` | The Management API URL copied from Outline Manager. **Required.** |
| Custom domain | `OUTLINE_DOMAIN` | A domain that points at your Outline server. Optional — leave empty to keep the raw IP in the access URLs. |

A convenient way to keep these out of your shell history is a `.env` file (already git-ignored) that you source before running:

```bash
# .env
export OUTLINE_API_URL="https://1.2.3.4:16942/AbCdEf123"
export OUTLINE_DOMAIN="vpn.example.com"
```

```bash
source .env
```

> ⚠️ The Management API URL grants full administrative control of your Outline server. Treat it like a password: don't commit it to version control or share it.

## Commands

```
node shadowboxKey.js <command> [options]
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

`<key>` may be either a key id or a key name. Running with no command at all is the same as `list`, so the original behaviour still works.

| Option | Applies to | Effect |
| --- | --- | --- |
| `--qr` | `list`, `add` | Also print a QR code for each key |
| `--json` | `list`, `usage` | Output JSON instead of a table |
| `--csv` | `list`, `usage` | Output CSV instead of a table |
| `--limit <size>` | `add` | Give the new key a data limit straight away |
| `-h`, `--help` | — | Show usage |

Sizes accept a unit suffix: `10GB`, `500MB`, `2TB`, or a plain byte count.

## Examples

List every key:

```console
$ node shadowboxKey.js list
ID  NAME   LIMIT  ACCESS URL
--  -----  -----  -----------------------------------------------------
0   Alice  10 GB  ss://YWVzOnBhc3N3b3Jk@vpn.example.com:443/?outline=1
1   Bob    -      ss://YWVzOnBhc3N3b3Jk2@vpn.example.com:444/?outline=1
```

Create a key with a 50 GB cap and show its QR code:

```console
$ node shadowboxKey.js add Carol --limit 50GB --qr
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
$ node shadowboxKey.js usage
ID  NAME   USED    LIMIT  OF LIMIT
--  -----  ------  -----  --------
0   Alice  3.0 GB  10 GB  30%
1   Bob    512 MB  -      -

Total transferred: 3.5 GB
```

Cap a heavy user, then lift the cap later:

```bash
node shadowboxKey.js limit Alice 10GB
node shadowboxKey.js limit Alice none
```

Export usage for a spreadsheet:

```bash
node shadowboxKey.js usage --csv > usage.csv
```

## Project layout

```
shadowboxKey.js    CLI entry point: argument parsing and commands
lib/outline.js     Outline Management API client
lib/format.js      Byte formatting, size parsing, table/CSV output
lib/errors.js      UserError, for messages shown without a stack trace
```

## A note on TLS verification

Outline servers use a self-signed TLS certificate for the Management API, so the tool disables certificate verification (`rejectUnauthorized: false`) for those requests. This is normal for the Outline Management API, but it does mean the connection is not protected against man-in-the-middle attacks. Only run this against servers you control, ideally from a trusted network.

## Troubleshooting

- **`Please configure your Management API URL first`** — set `OUTLINE_API_URL`, or replace the placeholder in `shadowboxKey.js`.
- **`Could not reach the Outline server`** — check that the Management API URL is correct and that its port (usually `16942`) is reachable from your machine.
- **`Cannot find module 'node-fetch'`** — run `npm install` in the project directory first.
- **`Management API responded with 404`** — your Outline server may be running an older release that lacks data-limit or metrics endpoints. Upgrade the server, or stick to `list`, `add`, `remove` and `rename`.
- **Keys print with the IP instead of your domain** — make sure `OUTLINE_DOMAIN` (or the `domain` constant) is set and non-empty.
- **`DeprecationWarning: The punycode module is deprecated`** — harmless, and emitted by the `node-fetch` dependency on newer Node versions. Silence it with `NODE_NO_WARNINGS=1`.

## License

No license has been specified yet. Until one is added, all rights are reserved by the author.
