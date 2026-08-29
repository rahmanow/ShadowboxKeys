# Changelog

Notable changes to shadowtools. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`provision` installs Outline on a server over SSH**, registers it, and
  creates access keys, so replacing a blocked server is one command rather than
  a round trip through Outline Manager. Works against any host you can SSH into.
  SSH credentials are used for the connection and never written to disk; only
  the resulting access code is saved. The host key is verified, with a new one
  requiring explicit confirmation and a changed one failing outright. The
  installer is uploaded over the SSH channel rather than fetched by the server,
  which does not assume the server can reach GitHub unmolested.
- **The dashboard can provision too** — Servers > Install on a server. The run
  is tracked as a job the page polls, so it survives closing the dialog or
  reloading the page, which matters when an install takes minutes on a poor
  connection. The host-key question is put on screen mid-handshake and the
  connection waits for the answer. The installer's access code is redacted from
  the streamed log: the page has an endpoint for revealing that deliberately,
  and a log is not it.
- `npm run verify:install` provisions a stand-in VPS over SSH with the genuine
  Outline installer and checks what comes back: the access code parses, the
  server registers like a hand-pasted one, the pinned fingerprint is the
  certificate actually served, keys can be created and removed, and a wrong
  fingerprint is refused. That contract lives in Outline's installer rather
  than here, so nothing else in the suite would notice if it changed. Kept out
  of `test/` deliberately — Node's runner collects that directory, and this
  needs Docker and several minutes.
- `SHADOWTOOLS_INSTALL_SCRIPT` points at a local copy of the Outline installer,
  for when the machine running shadowtools cannot reach GitHub either, or when
  you want a copy you have vetted.
- `ssh2` as a runtime dependency, required only by `provision` and loaded
  lazily, so the rest of the CLI works if its optional native parts fail to
  build.

- A public preview of the dashboard, deployed as a Cloudflare Worker on
  invented data, for looking at the interface without setting anything up. It
  serves the page from `lib/web.js` unmodified, so it cannot drift from what
  ships. It is a preview and not a deployment: the Workers runtime cannot
  accept or pin an Outline server's self-signed certificate, so the endpoints
  that would take an access code refuse rather than store one. Not part of the
  npm package.

## [4.1.0] — 2026-08-28

The web interface becomes an admin dashboard that manages servers as well as
keys, and can run in the background with a URL you can bookmark.

### Added

- **The web interface is now a multi-server admin dashboard.** It manages the
  servers as well as the keys: paste a server's access code from Outline
  Manager and it is saved for next time, so one panel covers every server you
  run. Four sections — Overview, Access keys, Servers, Settings — with the
  section in the URL hash so a reload lands where you were.
- **Saved servers**, in `~/.config/shadowtools/config.json`, written `0600`
  inside a `0700` directory and replaced by rename so an interrupted write
  cannot truncate a file full of credentials. `SHADOWTOOLS_CONFIG` moves it.
- **`servers` commands** — `servers`, `servers add`, `servers use`,
  `servers remove` — and `--server` to point one command at a server without
  changing the active one. Access codes are read from stdin, so they stay out
  of shell history.
- **`OUTLINE_TIMEOUT_MS`**, for the new Management API request timeout.
- **The dashboard can run as a background service** — `service install` and
  friends. It registers with the service manager the platform already has,
  launchd on macOS and systemd's user instance on Linux, so it starts at login,
  restarts if it exits, and answers on the same URL every time. Per-user
  agents only: nothing runs as root, nothing installs system-wide, and no step
  asks for a password.

### Changed

- `OUTLINE_API_URL` still takes precedence and now appears in the dashboard as
  a read-only *environment* entry, so existing setups behave exactly as before.
- The dashboard's QR codes are vector rather than block characters, so they
  scan off a screen and survive a screenshot. No new dependency: the encoder
  already vendored inside `qrcode-terminal` is reused, behind a guarded
  require that falls back to the previous block output.
- An unreachable server no longer blanks the page. Overview and Access keys
  report it and point at Servers; Servers and Settings keep working, since
  that is where the problem gets fixed.
- **The dashboard URL is now stable.** The token is stored in
  `~/.config/shadowtools/token` (mode `0600`) rather than minted per run, so a
  bookmark survives a restart. `ui` and the background service read the same
  file, so both hand out the same URL. `service url --rotate` mints a new one
  and invalidates every link given out before it.

### Fixed

- **A short access-code secret was displayed in full.** The redaction that
  shortens a Management API URL for display only truncated secrets longer than
  its cap, so a shorter one passed through intact. It now keeps at most half.
- **A Management API request had no timeout.** An address that drops packets
  rather than refusing the connection — a wrong IP in a pasted access code, a
  firewall — hung for the operating system's TCP timeout, well over a minute,
  which in the dashboard looked like a frozen page. Requests now give up after
  15 seconds and say which host did not answer.

### Security

- **The service never writes a credential into its own definition.** A launchd
  plist and a systemd unit are ordinary files that other tooling reads and
  backup software copies, so `OUTLINE_API_URL` and `OUTLINE_CERT_SHA256` are
  deliberately not carried into one — only locations and tunables are.
  `service install` says so when it sees them set, since a server configured
  only that way will not appear in the background dashboard.
- **The token is kept out of the service log.** launchd creates a log file
  world-readable, and the dashboard prints its URL at startup, which would have
  handed the token to any other user on the machine. The URL is now printed
  only when stdout is a terminal; the log records that it is listening and
  nothing more, and the log and its directory are created `0600`/`0700`.
- Adding servers to the dashboard could have ended the guarantee that a
  Management API URL never reaches the browser. It does not: the server list
  the page receives carries redacted URLs, and the full access code is served
  by a single endpoint that exists to reveal it, only when someone clicks the
  button that asks for it.

## [4.0.1] — 2026-08-28

### Changed

- Republished so the npm package page carries the current README. 4.0.0 was
  published by hand before the npm badge and the release documentation were
  written, and npm renders a package's page from the README inside the
  published tarball. The shipped code is byte-identical to 4.0.0.

This was also the first release published through the release workflow rather
than by hand, and so the first with a signed provenance attestation.

## [4.0.0] — 2026-08-28

The first release published to npm, as `shadowtools`.

### Changed

- **Renamed from ShadowboxKeys to `shadowtools`** — the repository, the package,
  the `shadowtools` command, and the entry point, which moved from
  `shadowboxKey.js` to `shadowtools.js`. References to "Shadowbox" that name
  Outline's own server component were deliberately left alone.

### Added

- A release workflow publishing on GitHub Release via npm trusted publishing
  (OIDC), so no long-lived token exists in repository secrets or on a machine.
  It refuses to publish when the release tag disagrees with `package.json`.
- A `prepublishOnly` hook, so a failing test suite stops a publish.

## Before 4.0.0

These versions existed in the repository but were **never published to npm**.
They are recorded because the version numbers appear in the git history.

### 3.0.0 — a web interface, and outline-br absorbed

- **Local web interface** (`shadowtools ui`) covering every command, with no new
  dependencies: the page is inlined, and QR codes reuse the terminal renderer's
  block output. The Management API URL never reaches the browser — the local
  server holds it and proxies, bound to loopback, gated on a per-run token, and
  refusing requests whose `Host` header is not the loopback address, which is
  what stops DNS rebinding.
- **Absorbed [outline-br](https://github.com/rahmanow/outline-br)**, which is now
  deprecated. Its `getKeys()` is exported here with the same signature, output
  format and printing behaviour, so migrating changes only the import.
- **Programmatic API**: `listKeys()`, `getUsage()` and `OutlineClient` alongside
  the CLI.
- MIT licence and a code of conduct, carried over from outline-br.
- Fixed certificate pinning on any command issuing more than one request. TLS
  session resumption skipped the certificate exchange, so the check saw no
  certificate and rejected the legitimate server. Found by the integration tests
  added in the same change, before the code was ever published.

### 2.0.0 — from a script to a tool

- Commands for creating, renaming and deleting keys, per-key and server-wide
  data limits, usage reporting, and QR codes, with JSON and CSV output.
- **Optional TLS certificate pinning** via `OUTLINE_CERT_SHA256`, aborting
  before any request bytes are written if the server presents an unexpected
  certificate — which matters because the path in the Management API URL is
  itself the admin credential.
- Replaced `node-fetch` with the built-in `node:https`, leaving
  `qrcode-terminal` as the only runtime dependency.
- Continuous integration on Node 18, 20 and 22, plus a dependency audit, and a
  test suite covering the pure logic and the HTTP layer.

### 1.1.0 — configuration and documentation

- Configuration moved to environment variables (`OUTLINE_API_URL`,
  `OUTLINE_DOMAIN`), so the Management API URL need not live in a tracked file.
- A real README, and `node-fetch` updated to 2.7.0 to clear two advisories.

### 1.0.0 — 2020-02-21

- The original script: list access keys, rewriting the server IP to a custom
  domain.

[Unreleased]: https://github.com/rahmanow/shadowtools/compare/v4.1.0...HEAD
[4.1.0]: https://github.com/rahmanow/shadowtools/releases/tag/v4.1.0
[4.0.1]: https://github.com/rahmanow/shadowtools/releases/tag/v4.0.1
