# Verifying against a real Outline install

The test suite proves the pieces. This proves the one contract that cannot be
faked in a unit test: that the genuine `install_server.sh`, run over SSH on a
real Linux host, produces something shadowtools can read, register and manage.

That contract lives in [Outline's installer][installer] rather than in this
repository, so it can change without a single test here going red. Running this
is how you find out.

```bash
npm run verify:install
```

It lives outside `test/` on purpose. Node's test runner collects everything
under that directory, so a file placed there would run during `npm test` — and
this needs Docker, reaches the network, pulls the Shadowbox image, and takes a
few minutes. It is opt-in by construction rather than by convention.

## What it does

Builds a stand-in for a fresh VPS — a privileged Debian container running sshd
and a working Docker daemon, which is what a provider image gives you and what
the installer needs — then provisions it exactly as the tool would provision a
real server, and checks what comes back:

- the host key fingerprint the tool reports matches what `ssh-keyscan` reports,
  since comparing those is precisely what a user is told to do
- the installer runs to `CONGRATULATIONS` and its access code is extracted
- that code parses with the ordinary `parseAccessCode`, so a provisioned server
  is indistinguishable from a hand-pasted one
- the pinned fingerprint is the certificate the server actually serves
- the management API answers through that pin, and keys can be created, listed
  and removed
- a **wrong** fingerprint is refused, because pinning that only ever succeeds is
  decoration

It removes the container afterwards, and uses a scratch config throughout, so a
real `~/.config/shadowtools/config.json` is never touched.

## What it cannot tell you

Anything about a provider's network. Firewall defaults, whether the management
and key ports are reachable from outside, and how a particular image differs
from stock Debian are all invisible to a container on your own machine — and
they are what the installer's own closing warning is about. For those, provision
a real host and try to connect a client to it.

[installer]: https://github.com/OutlineFoundation/outline-server/blob/master/src/server_manager/install_scripts/install_server.sh
