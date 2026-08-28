# ShadowboxKeys

A small Node.js utility that lists all access keys from your [Outline VPN](https://getoutline.org/) (Shadowbox) server and prints each key's access URL — optionally rewritten to use your own custom domain instead of the server's raw IP address.

This is handy when you have pointed a domain at your Outline server and want to hand out `ss://` access keys that reference the domain rather than the IP.

## How it works

The script calls the Outline **Management API** (`GET /access-keys/`), which returns every access key on the server. For each key it prints the key's name followed by its access URL. If you set a custom domain, the IP address in each URL is replaced with your domain.

## Prerequisites

- [Node.js](https://nodejs.org/) 12 or newer (with npm)
- An Outline server set up via [Outline Manager](https://getoutline.org/get-started/)
- Your server's **Management API URL** — in Outline Manager open your server, go to **Settings**, and copy the *Management API URL* (it looks like `https://1.2.3.4:16942/AbCdEf123...`)

## Installation

```bash
git clone https://github.com/rahmanow/ShadowboxKeys.git
cd ShadowboxKeys
npm install
```

## Configuration

You can configure the script either with environment variables (recommended — keeps secrets out of the code) or by editing the two constants at the top of `shadowboxKey.js`.

| Setting | Environment variable | Description |
| --- | --- | --- |
| Management API URL | `OUTLINE_API_URL` | The Management API URL copied from Outline Manager. **Required.** |
| Custom domain | `OUTLINE_DOMAIN` | A domain that points at your Outline server. Optional — leave empty to keep the raw IP in the access URLs. |

> ⚠️ The Management API URL grants full administrative control of your Outline server. Treat it like a password: don't commit it to version control or share it.

## Usage

With environment variables:

```bash
OUTLINE_API_URL="https://1.2.3.4:16942/AbCdEf123" OUTLINE_DOMAIN="vpn.example.com" npm start
```

Or edit the variables at the top of `shadowboxKey.js`, then run:

```bash
npm start
```

Example output:

```
Alice  ss://Y2hhY2hhMjAt...@vpn.example.com:443/?outline=1
Bob    ss://Y2hhY2hhMjAt...@vpn.example.com:443/?outline=1
Completed. These are all you have!
```

## A note on TLS verification

Outline servers use a self-signed TLS certificate for the Management API, so the script disables certificate verification (`rejectUnauthorized: false`) for that one request. This is normal for the Outline Management API, but it does mean the connection is not protected against man-in-the-middle attacks. Only run this against servers you control, ideally from a trusted network.

## Troubleshooting

- **`FetchError: request to ... failed`** — check that the Management API URL is correct and that port `16942` (or whichever port your URL shows) is reachable from your machine.
- **`Cannot find module 'node-fetch'`** — run `npm install` in the project directory first.
- **Keys print with the IP instead of your domain** — make sure `OUTLINE_DOMAIN` (or the `domain` constant) is set and non-empty.

## License

No license has been specified yet. Until one is added, all rights are reserved by the author.
