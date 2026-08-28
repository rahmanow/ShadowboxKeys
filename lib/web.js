'use strict';

/**
 * The whole UI as one self-contained document — no build step, no bundler, no
 * CDN. The server sends a Content-Security-Policy that forbids loading anything
 * external, so everything the page needs has to live here.
 */

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #f6f7f9;
  --panel: #ffffff;
  --line: #e2e5ea;
  --ink: #1a1d21;
  --muted: #6b7280;
  --accent: #2563eb;
  --danger: #dc2626;
  --ok: #059669;
  --warn: #d97706;
  --radius: 10px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161a; --panel: #1c1f25; --line: #2b3038; --ink: #e8eaed;
    --muted: #9aa2ad; --accent: #60a5fa; --danger: #f87171; --ok: #34d399; --warn: #fbbf24;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
header {
  display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
  padding: 20px 24px; border-bottom: 1px solid var(--line); background: var(--panel);
}
h1 { font-size: 17px; margin: 0; font-weight: 620; letter-spacing: -0.01em; }
.sub { color: var(--muted); font-size: 13px; }
main { max-width: 1100px; margin: 0 auto; padding: 24px; }
.bar {
  display: flex; gap: 10px; flex-wrap: wrap; align-items: center;
  margin-bottom: 18px;
}
.bar .spacer { flex: 1; }
button, input, select {
  font: inherit; color: inherit;
  border: 1px solid var(--line); background: var(--panel);
  border-radius: 8px; padding: 7px 11px;
}
button { cursor: pointer; }
button:hover:not(:disabled) { border-color: var(--accent); }
button:disabled { opacity: 0.5; cursor: default; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 550; }
button.danger { color: var(--danger); }
button.link {
  border: none; background: none; padding: 2px 4px; color: var(--accent);
  text-decoration: underline; text-underline-offset: 2px;
}
input { min-width: 0; }
input:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--line); vertical-align: middle; }
th { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); font-weight: 600; }
tbody tr:last-child td { border-bottom: none; }
td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.actions { text-align: right; white-space: nowrap; }
.url {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  color: var(--muted); max-width: 320px; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; display: inline-block; vertical-align: bottom;
}
.name { font-weight: 550; }
.name.unnamed { color: var(--muted); font-weight: 400; font-style: italic; }
.meter { width: 110px; height: 5px; background: var(--line); border-radius: 3px; overflow: hidden; margin: 4px 0 0 auto; }
.meter i { display: block; height: 100%; background: var(--ok); }
.meter i.warn { background: var(--warn); }
.meter i.over { background: var(--danger); }
.pill {
  display: inline-block; padding: 1px 7px; border-radius: 999px;
  border: 1px solid var(--line); font-size: 12px; color: var(--muted);
}
.empty, .loading { padding: 36px; text-align: center; color: var(--muted); }
.err {
  margin-bottom: 16px; padding: 10px 14px; border-radius: 8px;
  border: 1px solid var(--danger); color: var(--danger);
  background: color-mix(in srgb, var(--danger) 8%, transparent);
  white-space: pre-wrap;
}
dialog {
  border: 1px solid var(--line); border-radius: var(--radius); padding: 0;
  background: var(--panel); color: var(--ink); max-width: 92vw;
}
dialog::backdrop { background: rgba(0,0,0,0.45); }
.dlg { padding: 20px; min-width: 300px; }
.dlg h2 { margin: 0 0 14px; font-size: 15px; }
.dlg label { display: block; font-size: 13px; color: var(--muted); margin: 10px 0 4px; }
.dlg input { width: 100%; }
.dlg .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px; }
.hint { font-size: 12px; color: var(--muted); margin-top: 6px; }
pre.qr {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  line-height: 1; font-size: 9px; letter-spacing: 0; margin: 0; text-align: center;
  background: #fff; color: #000; padding: 12px; border-radius: 8px; overflow: auto;
}
.qr-url {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
  word-break: break-all; color: var(--muted); margin-top: 12px; max-width: 380px;
}
`;

const JS = `
'use strict';
const token = new URLSearchParams(location.search).get('t') || '';
let state = { keys: [], host: '', serverLimitBytes: null, serverName: null };

const $ = sel => document.querySelector(sel);
const el = (tag, props, ...kids) => {
  const n = Object.assign(document.createElement(tag), props || {});
  for (const k of kids.flat()) if (k != null) n.append(k);
  return n;
};

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  if (i === 0) return n + ' B';
  return (v >= 10 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[i];
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: Object.assign({ 'X-Auth-Token': token }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('Request failed with ' + res.status));
  return data;
}

function showError(message) {
  const box = $('#error');
  box.textContent = message || '';
  box.hidden = !message;
}

/** Runs an action, shows any failure, and refreshes from whatever it returns. */
async function act(fn) {
  showError('');
  document.body.style.cursor = 'progress';
  try {
    const next = await fn();
    if (next && next.keys) { state = next; render(); }
  } catch (err) {
    showError(err.message);
  } finally {
    document.body.style.cursor = '';
  }
}

function meter(used, limit) {
  if (!limit) return null;
  const pct = Math.min(100, (used / limit) * 100);
  const cls = pct >= 100 ? 'over' : pct >= 80 ? 'warn' : '';
  const bar = el('i', { className: cls });
  bar.style.width = pct + '%';
  return el('div', { className: 'meter' }, bar);
}

function render() {
  $('#host').textContent = state.host || '';
  $('#server-limit').textContent = state.serverLimitBytes
    ? 'Default cap ' + formatBytes(state.serverLimitBytes)
    : 'No default cap';

  const total = state.keys.reduce((sum, k) => sum + (k.bytes || 0), 0);
  $('#summary').textContent = state.keys.length + (state.keys.length === 1 ? ' key' : ' keys')
    + ' · ' + formatBytes(total) + ' transferred';

  const body = $('#rows');
  body.replaceChildren();

  if (!state.keys.length) {
    $('#table-wrap').replaceChildren(el('div', { className: 'empty' }, 'No access keys yet. Add one to get started.'));
    return;
  }
  if (!document.querySelector('#rows')) return;

  for (const key of state.keys) {
    const nameCell = el('td', {},
      el('div', { className: 'name' + (key.name ? '' : ' unnamed'), textContent: key.name || 'Unnamed' }));

    const usageCell = el('td', { className: 'num' },
      el('div', { textContent: formatBytes(key.bytes) }),
      meter(key.bytes, key.dataLimitBytes));

    const limitCell = el('td', { className: 'num' },
      key.dataLimitBytes
        ? el('span', { className: 'pill', textContent: formatBytes(key.dataLimitBytes) })
        : el('span', { className: 'pill', textContent: '—' }));

    const urlCell = el('td', {},
      el('span', { className: 'url', textContent: key.accessUrl, title: key.accessUrl }),
      ' ',
      el('button', { className: 'link', textContent: 'copy', onclick: () => copy(key.accessUrl) }));

    const actions = el('td', { className: 'actions' },
      el('button', { className: 'link', textContent: 'QR', onclick: () => showQr(key.id) }),
      el('button', { className: 'link', textContent: 'rename', onclick: () => rename(key) }),
      el('button', { className: 'link', textContent: 'limit', onclick: () => setLimit(key) }),
      el('button', { className: 'link danger', textContent: 'delete', onclick: () => remove(key) }));

    body.append(el('tr', {},
      el('td', { className: 'num', textContent: key.id }),
      nameCell, usageCell, limitCell, urlCell, actions));
  }
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    // Clipboard access can be refused; fall back to a selection the user can copy.
    const box = $('#copy-fallback');
    box.value = text; box.hidden = false; box.select();
  }
}

function ask({ title, label, value = '', hint = '', okText = 'Save', placeholder = '' }) {
  return new Promise(resolve => {
    const dlg = $('#prompt');
    $('#prompt-title').textContent = title;
    $('#prompt-label').textContent = label;
    $('#prompt-hint').textContent = hint;
    $('#prompt-ok').textContent = okText;
    const input = $('#prompt-input');
    input.value = value;
    input.placeholder = placeholder;

    const done = result => {
      dlg.close();
      form.removeEventListener('submit', onSubmit);
      dlg.removeEventListener('cancel', onCancel);
      resolve(result);
    };
    const form = $('#prompt-form');
    const onSubmit = ev => { ev.preventDefault(); done(input.value); };
    const onCancel = () => done(null);

    form.addEventListener('submit', onSubmit);
    dlg.addEventListener('cancel', onCancel);
    dlg.showModal();
    input.focus();
    input.select();
  });
}

async function addKey() {
  const name = await ask({
    title: 'New access key', label: 'Name', okText: 'Create', placeholder: 'e.g. Alice',
  });
  if (name === null) return;
  act(() => api('POST', '/api/keys', { name }));
}

async function rename(key) {
  const name = await ask({ title: 'Rename key', label: 'Name', value: key.name });
  if (name === null || name === key.name) return;
  act(() => api('PUT', '/api/keys/' + encodeURIComponent(key.id) + '/name', { name }));
}

async function setLimit(key) {
  const value = await ask({
    title: 'Data limit for ' + (key.name || 'key ' + key.id),
    label: 'Limit',
    value: key.dataLimitBytes ? formatBytes(key.dataLimitBytes).replace(' ', '') : '',
    hint: 'e.g. 50GB, 500MB. Leave empty to remove the limit.',
    placeholder: 'no limit',
  });
  if (value === null) return;
  act(() => api('PUT', '/api/keys/' + encodeURIComponent(key.id) + '/limit', { bytes: value.trim() || null }));
}

async function setServerLimit() {
  const value = await ask({
    title: 'Server-wide default limit',
    label: 'Limit',
    value: state.serverLimitBytes ? formatBytes(state.serverLimitBytes).replace(' ', '') : '',
    hint: 'Applies to keys without their own limit. Leave empty to remove.',
    placeholder: 'no limit',
  });
  if (value === null) return;
  act(() => api('PUT', '/api/server/limit', { bytes: value.trim() || null }));
}

async function remove(key) {
  const label = key.name || 'key ' + key.id;
  if (!confirm('Delete ' + label + '? Anyone using this key loses access immediately.')) return;
  act(() => api('DELETE', '/api/keys/' + encodeURIComponent(key.id)));
}

async function showQr(id) {
  showError('');
  try {
    const data = await api('GET', '/api/keys/' + encodeURIComponent(id) + '/qr');
    $('#qr-title').textContent = data.name || 'Access key';
    $('#qr-code').textContent = data.qr;
    $('#qr-url').textContent = data.accessUrl;
    $('#qr').showModal();
  } catch (err) {
    showError(err.message);
  }
}

function init() {
  if (!token) {
    showError('No access token in the URL. Open the link printed in your terminal.');
  }
  $('#add').onclick = addKey;
  $('#refresh').onclick = () => act(() => api('GET', '/api/state'));
  $('#server-limit-btn').onclick = setServerLimit;
  $('#prompt-cancel').onclick = () => $('#prompt').close();
  $('#qr-close').onclick = () => $('#qr').close();
  act(() => api('GET', '/api/state'));
}

document.addEventListener('DOMContentLoaded', init);
`;

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Outline access keys</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <h1>Outline access keys</h1>
  <span class="sub" id="host"></span>
  <span class="sub" id="summary"></span>
</header>

<main>
  <div class="err" id="error" hidden></div>

  <div class="bar">
    <button class="primary" id="add">Add key</button>
    <button id="refresh">Refresh</button>
    <span class="spacer"></span>
    <span class="sub" id="server-limit"></span>
    <button id="server-limit-btn">Set default cap</button>
  </div>

  <div class="panel scroll" id="table-wrap">
    <table>
      <thead>
        <tr>
          <th>ID</th><th>Name</th><th style="text-align:right">Used</th>
          <th style="text-align:right">Limit</th><th>Access URL</th><th></th>
        </tr>
      </thead>
      <tbody id="rows"><tr><td colspan="6" class="loading">Loading…</td></tr></tbody>
    </table>
  </div>

  <input id="copy-fallback" hidden readonly style="width:100%;margin-top:12px">
</main>

<dialog id="prompt">
  <form class="dlg" id="prompt-form">
    <h2 id="prompt-title"></h2>
    <label id="prompt-label"></label>
    <input id="prompt-input" autocomplete="off">
    <div class="hint" id="prompt-hint"></div>
    <div class="row">
      <button type="button" id="prompt-cancel">Cancel</button>
      <button type="submit" class="primary" id="prompt-ok">Save</button>
    </div>
  </form>
</dialog>

<dialog id="qr">
  <div class="dlg">
    <h2 id="qr-title"></h2>
    <pre class="qr" id="qr-code"></pre>
    <div class="qr-url" id="qr-url"></div>
    <div class="row"><button id="qr-close">Close</button></div>
  </div>
</dialog>

<script>${JS}</script>
</body>
</html>`;

function page() {
    return HTML;
}

module.exports = { page };
