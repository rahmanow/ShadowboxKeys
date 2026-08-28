import { page } from '../lib/web.js';
import { toSvgPath } from '../lib/qr.js';
import { freshState, accessUrlFor } from './demo.js';

/**
 * A public preview of the shadowtools dashboard, on invented data.
 *
 * Why this is a preview and not the tool: an Outline server's Management API is
 * served with a self-signed certificate, and shadowtools authenticates it by
 * pinning the fingerprint. The Workers runtime has no equivalent — fetch()
 * refuses any origin whose certificate is not publicly trusted, and connect()
 * exposes neither verification control nor the peer certificate. So a Worker
 * cannot talk to an Outline server at all, whatever else it does.
 *
 * That leaves the interface, which is the part worth previewing anyway: it is
 * most of the code, and iterating on it otherwise means running a local server
 * against a fake one. The page comes from lib/web.js unmodified, so this can
 * never drift from what ships; only the data behind it is invented.
 *
 * No credential ever reaches this Worker. The endpoints that would accept one
 * refuse, by design — see REFUSAL below.
 */

const REFUSAL =
    'This is a UI preview running on invented data. It cannot reach a real Outline server, ' +
    'and nothing you type here is stored or sent anywhere. Install shadowtools locally to ' +
    'manage real servers: npm install -g shadowtools';

// Kept per isolate rather than in storage: edits should feel real while you
// click around, and a preview has nothing worth persisting. It resets on its
// own, which is the behaviour you want from a scratchpad.
let state = freshState();

const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Robots-Tag': 'noindex, nofollow',
        },
    });

const refuse = () => json({ error: REFUSAL }, 400);

function activeServer() {
    return state.servers.find(server => server.id === state.activeServerId) || null;
}

/** The same shape lib/server.js builds, minus the preview-only underscored fields. */
function dashboardState() {
    const active = activeServer();
    const servers = state.servers.map(server => ({
        id: server.id,
        name: server.name,
        host: server.host,
        domain: server.domain,
        apiUrlPreview: server.apiUrlPreview,
        certPinned: server.certPinned,
        createdAt: server.createdAt,
        source: server.source,
        active: Boolean(active) && server.id === active.id,
        editable: server.editable,
    }));

    if (!active) {
        return {
            servers, activeServerId: null, configPath: null, host: '', serverName: null,
            serverLimitBytes: null, keys: [], reachable: false, unreachableReason: null,
        };
    }

    return {
        servers,
        activeServerId: active.id,
        configPath: '~/.config/shadowtools/config.json (preview — nothing is written)',
        host: active.domain || active.host,
        serverName: active._reachable ? active._serverName || null : null,
        serverLimitBytes: active._reachable ? active._serverLimitBytes ?? null : null,
        reachable: Boolean(active._reachable),
        unreachableReason: active._reachable ? null : active._unreachableReason || null,
        keys: active._reachable
            ? active._keys.map(key => ({
                id: key.id,
                name: key.name,
                port: key.port,
                dataLimitBytes: key.dataLimitBytes,
                bytes: Math.round(key.bytes),
                accessUrl: accessUrlFor(active, key),
            }))
            : [],
    };
}

/** Parses a size the way lib/format.js does, so the limit dialogs behave alike. */
function parseBytes(input) {
    if (input === null || input === undefined || input === '') return null;
    const match = String(input).trim().match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?$/i);
    if (!match) {
        const error = new Error(`Could not understand the size "${input}". Try something like 10GB or 500MB.`);
        error.userFacing = true;
        throw error;
    }
    const units = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
    return Math.round(parseFloat(match[1]) * units[(match[2] || 'B').toUpperCase()]);
}

const routes = [
    ['GET', /^\/api\/state$/, () => dashboardState()],

    ['POST', /^\/api\/keys$/, (m, body) => {
        const server = activeServer();
        const id = String(Math.max(-1, ...server._keys.map(k => Number(k.id))) + 1);
        server._keys.push({
            id,
            name: (body.name || '').trim(),
            port: 9000 + Number(id),
            dataLimitBytes: parseBytes(body.limitBytes),
            bytes: 0,
        });
        return dashboardState();
    }],

    ['DELETE', /^\/api\/keys\/([^/]+)$/, m => {
        const server = activeServer();
        const index = server._keys.findIndex(k => k.id === decodeURIComponent(m[1]));
        if (index >= 0) server._keys.splice(index, 1);
        return dashboardState();
    }],

    ['PUT', /^\/api\/keys\/([^/]+)\/name$/, (m, body) => {
        const name = (body.name || '').trim();
        if (!name) {
            const error = new Error('A key name cannot be empty.');
            error.userFacing = true;
            throw error;
        }
        const key = activeServer()._keys.find(k => k.id === decodeURIComponent(m[1]));
        if (key) key.name = name;
        return dashboardState();
    }],

    ['PUT', /^\/api\/keys\/([^/]+)\/limit$/, (m, body) => {
        const key = activeServer()._keys.find(k => k.id === decodeURIComponent(m[1]));
        if (key) key.dataLimitBytes = parseBytes(body.bytes);
        return dashboardState();
    }],

    ['PUT', /^\/api\/server\/limit$/, (m, body) => {
        activeServer()._serverLimitBytes = parseBytes(body.bytes);
        return dashboardState();
    }],

    ['GET', /^\/api\/keys\/([^/]+)\/qr$/, m => {
        const server = activeServer();
        const key = server._keys.find(k => k.id === decodeURIComponent(m[1]));
        if (!key) {
            const error = new Error(`No key with id "${decodeURIComponent(m[1])}".`);
            error.userFacing = true;
            throw error;
        }
        const url = accessUrlFor(server, key);
        const svg = toSvgPath(url);
        return {
            qr: null,
            svgPath: svg ? svg.path : null,
            svgSize: svg ? svg.size : 0,
            accessUrl: url,
            name: key.name || '',
        };
    }],

    ['POST', /^\/api\/servers\/([^/]+)\/activate$/, m => {
        const id = decodeURIComponent(m[1]);
        if (state.servers.some(server => server.id === id)) state.activeServerId = id;
        return dashboardState();
    }],

    ['POST', /^\/api\/servers\/([^/]+)\/test$/, m => {
        const server = state.servers.find(s => s.id === decodeURIComponent(m[1]));
        if (!server || !server._reachable) {
            const error = new Error(
                (server && server._unreachableReason) || 'No configured server with that id.'
            );
            error.userFacing = true;
            throw error;
        }
        return { ok: true, name: server._serverName, version: '1.9.2' };
    }],

    ['DELETE', /^\/api\/servers\/([^/]+)$/, m => {
        const id = decodeURIComponent(m[1]);
        const index = state.servers.findIndex(server => server.id === id);
        if (index >= 0) state.servers.splice(index, 1);
        if (state.activeServerId === id) {
            state.activeServerId = state.servers.length ? state.servers[0].id : null;
        }
        return dashboardState();
    }],

    ['PUT', /^\/api\/servers\/([^/]+)$/, (m, body) => {
        // Renaming and re-pointing a domain are safe; a new access code is not.
        if (body.accessCode) return refuse();
        const server = state.servers.find(s => s.id === decodeURIComponent(m[1]));
        if (server) {
            if (body.name !== undefined) server.name = String(body.name).trim();
            if (body.domain !== undefined) server.domain = String(body.domain).trim();
        }
        return dashboardState();
    }],

    // The two that would take a credential. Neither parses nor stores it: the
    // refusal is the whole handler, so a pasted access code is discarded with
    // the request. The dialog shows the message inline, which is a UI state
    // worth being able to look at anyway.
    ['POST', /^\/api\/servers$/, () => refuse()],
    ['GET', /^\/api\/servers\/([^/]+)\/access-code$/, () => refuse()],
];

/**
 * A banner making it unmistakable that this is not anyone's real dashboard.
 *
 * Injected here rather than added to lib/web.js: the page must stay exactly the
 * one the tool serves, or the preview stops being evidence about the tool.
 */
function withBanner(html) {
    const banner = `<div id="preview-banner" role="status">
<strong>Preview</strong> — invented data, no real server. Nothing you type is stored.
<a href="https://github.com/rahmanow/shadowtools">shadowtools on GitHub</a>
</div>
<style>
#preview-banner {
  position: sticky; top: 0; z-index: 99; display: flex; gap: 10px; flex-wrap: wrap;
  align-items: baseline; padding: 8px 16px; font: 13px/1.4 system-ui, sans-serif;
  background: #7c2d12; color: #fff;
}
#preview-banner strong { font-weight: 650; }
#preview-banner a { color: #fff; margin-left: auto; }
@media (prefers-color-scheme: dark) { #preview-banner { background: #9a3412; } }
</style>`;
    return html.replace('<body>', `<body>\n${banner}`);
}

export default {
    async fetch(request) {
        const url = new URL(request.url);

        if (url.pathname === '/' || url.pathname === '/index.html') {
            // The page reports a missing token as an error, which is right in
            // the tool and noise here. Nothing authorises this preview.
            if (!url.searchParams.get('t')) {
                url.searchParams.set('t', 'preview');
                return Response.redirect(url.toString(), 302);
            }
            return new Response(withBanner(page()), {
                headers: {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-store',
                    'X-Content-Type-Options': 'nosniff',
                    'X-Robots-Tag': 'noindex, nofollow',
                    'Referrer-Policy': 'no-referrer',
                },
            });
        }

        if (!url.pathname.startsWith('/api/')) return json({ error: 'Not found.' }, 404);

        const matched = routes
            .map(([method, pattern, run]) => ({ method, run, match: pattern.exec(url.pathname) }))
            .filter(route => route.match);

        if (!matched.length) return json({ error: 'Not found.' }, 404);

        const route = matched.find(candidate => candidate.method === request.method);
        if (!route) return json({ error: 'Method not allowed.' }, 405);

        try {
            const body = route.method === 'GET' || route.method === 'DELETE'
                ? {}
                : await request.json().catch(() => ({}));
            const result = route.run(route.match, body);
            return result instanceof Response ? result : json(result);
        } catch (err) {
            if (err.userFacing) return json({ error: err.message }, 400);
            console.error(err);
            return json({ error: 'Something went wrong.' }, 500);
        }
    },
};
