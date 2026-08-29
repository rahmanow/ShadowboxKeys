'use strict';

/**
 * The whole dashboard as one self-contained document — no build step, no
 * bundler, no CDN. The server sends a Content-Security-Policy that forbids
 * loading anything external, so everything the page needs lives here.
 *
 * It is split into sections rather than one long page because the panel now
 * manages servers as well as keys, and those are different jobs: you open
 * Servers when something is being set up or has gone wrong, and Keys the rest
 * of the time. Sections live in the URL hash so a reload lands where you were.
 */

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #f4f5f7;
  --panel: #ffffff;
  --raised: #fafbfc;
  --line: #e3e6ea;
  --ink: #14171a;
  --muted: #687180;
  --accent: #2563eb;
  --accent-soft: #eef3ff;
  --danger: #dc2626;
  --ok: #059669;
  --warn: #d97706;
  --radius: 10px;
  --sidebar: 208px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #101216; --panel: #191c21; --raised: #1f2329; --line: #2a2f37; --ink: #e9ebee;
    --muted: #98a1ad; --accent: #6ea8fe; --accent-soft: #1c2536; --danger: #f87171;
    --ok: #34d399; --warn: #fbbf24;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.app { display: grid; grid-template-columns: var(--sidebar) 1fr; min-height: 100vh; }

/* Sidebar */
aside {
  background: var(--panel); border-right: 1px solid var(--line);
  display: flex; flex-direction: column; gap: 4px; padding: 18px 12px;
}
.brand { padding: 0 10px 14px; }
.brand b { display: block; font-size: 15px; letter-spacing: -0.01em; }
.brand span { font-size: 12px; color: var(--muted); }
nav { display: flex; flex-direction: column; gap: 2px; }
nav a {
  display: flex; align-items: center; gap: 9px; padding: 7px 10px; border-radius: 7px;
  color: var(--ink); text-decoration: none; font-size: 14px;
}
nav a:hover { background: var(--raised); }
nav a[aria-current="page"] { background: var(--accent-soft); color: var(--accent); font-weight: 560; }
nav a .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); opacity: 0.5; flex: none; }
nav a[aria-current="page"] .dot { background: var(--accent); opacity: 1; }
nav a .count { margin-left: auto; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
aside .foot { margin-top: auto; padding: 12px 10px 0; font-size: 11px; color: var(--muted); line-height: 1.45; }

/* Top bar */
main { min-width: 0; display: flex; flex-direction: column; }
.top {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 14px 24px; border-bottom: 1px solid var(--line); background: var(--panel);
}
.top h1 { font-size: 16px; margin: 0; font-weight: 600; letter-spacing: -0.01em; }
.top .spacer { flex: 1; }
.crumb { font-size: 13px; color: var(--muted); }
.content { padding: 22px 24px 48px; max-width: 1080px; width: 100%; }

/* Controls */
button, input, select, textarea {
  font: inherit; color: inherit;
  border: 1px solid var(--line); background: var(--panel);
  border-radius: 8px; padding: 7px 11px;
}
textarea { resize: vertical; min-height: 74px; width: 100%; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
button { cursor: pointer; }
button:hover:not(:disabled) { border-color: var(--accent); }
button:disabled { opacity: 0.5; cursor: default; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 550; }
button.primary:hover:not(:disabled) { filter: brightness(1.06); }
button.danger { color: var(--danger); }
button.link {
  border: none; background: none; padding: 2px 5px; color: var(--accent);
  text-decoration: underline; text-underline-offset: 2px; font-size: 13px;
}
button.link.danger { color: var(--danger); }
button.small { padding: 4px 9px; font-size: 13px; }
input { min-width: 0; }
input:focus-visible, button:focus-visible, textarea:focus-visible, select:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 1px;
}
.bar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 16px; }
.bar .spacer { flex: 1; }
.search { width: 200px; }

/* Server switcher */
.switcher { display: flex; align-items: center; gap: 8px; }
.switcher select { max-width: 260px; padding: 6px 10px; }
.switcher .state { font-size: 12px; display: inline-flex; align-items: center; gap: 5px; color: var(--muted); }
.led { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); flex: none; }
.led.up { background: var(--ok); }
.led.down { background: var(--danger); }

/* Panels and tables */
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
.panel + .panel { margin-top: 18px; }
.panel > h2 {
  margin: 0; padding: 13px 16px; font-size: 13px; font-weight: 600; letter-spacing: 0.01em;
  border-bottom: 1px solid var(--line); background: var(--raised);
}
.panel > h2 .sub { font-weight: 400; color: var(--muted); margin-left: 8px; font-size: 12px; }
.panel .body { padding: 16px; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--line); vertical-align: middle; }
th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); font-weight: 600; }
tbody tr:last-child td { border-bottom: none; }
tbody tr:hover { background: var(--raised); }
td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.actions { text-align: right; white-space: nowrap; }
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--muted);
}
.url { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; vertical-align: bottom; }
.name { font-weight: 550; }
.name.unnamed { color: var(--muted); font-weight: 400; font-style: italic; }
.meter { width: 104px; height: 5px; background: var(--line); border-radius: 3px; overflow: hidden; margin: 5px 0 0 auto; }
.meter i { display: block; height: 100%; background: var(--ok); }
.meter i.warn { background: var(--warn); }
.meter i.over { background: var(--danger); }
.pill {
  display: inline-block; padding: 1px 8px; border-radius: 999px;
  border: 1px solid var(--line); font-size: 12px; color: var(--muted);
}
.pill.on { border-color: var(--ok); color: var(--ok); }
.pill.soft { background: var(--accent-soft); border-color: transparent; color: var(--accent); }
.empty { padding: 34px 20px; text-align: center; color: var(--muted); }
.empty p { margin: 0 0 14px; }

/* Stats */
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(168px, 1fr)); gap: 12px; margin-bottom: 18px; }
.stat { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px; }
.stat .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); font-weight: 600; }
.stat .value { font-size: 22px; font-weight: 600; letter-spacing: -0.02em; margin-top: 5px; font-variant-numeric: tabular-nums; }
.stat .note { font-size: 12px; color: var(--muted); margin-top: 3px; }

/* Notices */
.notice {
  margin-bottom: 16px; padding: 11px 14px; border-radius: 9px;
  border: 1px solid var(--line); background: var(--panel); font-size: 14px;
  display: flex; gap: 12px; align-items: flex-start; white-space: pre-wrap;
}
/* An explicit display beats the user agent's [hidden] rule, so restore it. */
.notice[hidden] { display: none; }
.notice .grow { flex: 1; min-width: 0; }
.notice.err { border-color: var(--danger); color: var(--danger); }
.notice.warn { border-color: var(--warn); color: var(--warn); }
.notice strong { display: block; margin-bottom: 2px; }

/* Server cards */
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
.card { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 15px 16px; }
.card.active { border-color: var(--accent); }
.card h3 { margin: 0 0 3px; font-size: 14px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.card dl { margin: 10px 0 0; display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 12.5px; }
.card > dl:first-child { margin-top: 0; }
.card dt { color: var(--muted); }
.card dd { margin: 0; overflow-wrap: anywhere; }
.card .row { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 13px; padding-top: 11px; border-top: 1px solid var(--line); }
.test-result { margin-top: 8px; font-size: 12.5px; color: var(--muted); overflow-wrap: anywhere; }
.test-result.ok { color: var(--ok); }
.test-result.bad { color: var(--danger); }
.card.future { border-style: dashed; color: var(--muted); }
.card.future h3 { color: var(--ink); }
.card.future p, .card .cardnote { margin: 8px 0 0; font-size: 13px; line-height: 1.5; color: var(--muted); }
.crumb.bad { color: var(--danger); }
.crumb.warnline { color: var(--warn); }
pre.joblog {
  margin: 12px 0 0; padding: 11px 13px; max-height: 320px; overflow: auto;
  background: var(--raised); border: 1px solid var(--line); border-radius: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px;
  line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere;
}
.fingerprint {
  margin: 14px 0 4px; padding: 12px 14px; border-radius: 8px;
  background: var(--raised); border: 1px solid var(--line);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;
  text-align: center; overflow-wrap: anywhere; user-select: all;
}

/* Dialogs */
dialog {
  border: 1px solid var(--line); border-radius: var(--radius); padding: 0;
  background: var(--panel); color: var(--ink); max-width: 94vw; width: 420px;
}
dialog.wide { width: 470px; }
dialog::backdrop { background: rgba(0,0,0,0.5); }
.dlg { padding: 20px; }
.dlg h2 { margin: 0 0 4px; font-size: 15px; }
.dlg .lede { margin: 0 0 14px; font-size: 13px; color: var(--muted); }
.dlg label { display: block; font-size: 13px; color: var(--muted); margin: 12px 0 4px; }
.dlg input { width: 100%; }
.dlg .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 20px; }
.dlg .row .spacer { flex: 1; }
.hint { font-size: 12px; color: var(--muted); margin-top: 6px; }
.dlg .err { color: var(--danger); font-size: 13px; margin-top: 12px; white-space: pre-wrap; }

/* QR */
.qr-wrap { display: flex; flex-direction: column; align-items: center; gap: 14px; }
.qr-svg { width: 232px; height: 232px; background: #fff; border-radius: 8px; padding: 6px; }
pre.qr {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  line-height: 1; font-size: 9px; margin: 0; text-align: center;
  background: #fff; color: #000; padding: 12px; border-radius: 8px; overflow: auto;
}
.qr-url {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
  word-break: break-all; color: var(--muted); width: 100%;
}

@media (max-width: 720px) {
  .app { grid-template-columns: 1fr; }
  aside { flex-direction: row; align-items: center; gap: 10px; padding: 10px 14px; overflow-x: auto; border-right: none; border-bottom: 1px solid var(--line); }
  .brand { padding: 0 8px 0 0; }
  .brand span, aside .foot { display: none; }
  nav { flex-direction: row; }
  nav a .count { display: none; }
  .content, .top { padding-left: 14px; padding-right: 14px; }
}
`;

const JS = `
'use strict';

const token = new URLSearchParams(location.search).get('t') || '';
const SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'keys', label: 'Access keys' },
  { id: 'servers', label: 'Servers' },
  { id: 'settings', label: 'Settings' },
];

let state = {
  servers: [], keys: [], host: '', serverName: null, serverLimitBytes: null,
  activeServerId: null, configPath: null, reachable: false, unreachableReason: null,
};
let section = 'overview';
let filter = '';

const $ = sel => document.querySelector(sel);
const el = (tag, props, ...kids) => {
  const node = Object.assign(document.createElement(tag), props || {});
  for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid);
  return node;
};

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  if (i === 0) return n + ' B';
  return (v >= 10 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[i];
}

/** A size string the limit dialogs can round-trip, e.g. 10.5 GB -> "10.5GB". */
function sizeInput(bytes) {
  return bytes ? formatBytes(bytes).replace(' ', '') : '';
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
  box.hidden = !message;
  if (message) box.replaceChildren(el('div', { className: 'grow', textContent: message }));
  else box.replaceChildren();
}

/**
 * Runs an action and re-renders from whatever state it returns.
 *
 * Failures propagate, so a caller that has somewhere better to put the message
 * — an open dialog — can. Most callers want act() instead.
 */
async function run(fn) {
  document.body.style.cursor = 'progress';
  try {
    const next = await fn();
    if (next && Array.isArray(next.servers)) { state = next; render(); }
    return next;
  } finally {
    document.body.style.cursor = '';
  }
}

/** run(), with any failure reported in the banner above the current section. */
async function act(fn) {
  showError('');
  try {
    return await run(fn);
  } catch (err) {
    showError(err.message);
    // Re-render so the shell still matches the state we did manage to load.
    render();
  }
}

/* ---------- generic dialog ---------- */

/**
 * Opens a form dialog and resolves with the field values, or null if cancelled.
 *
 * When a submit handler is given it runs while the dialog is still open, and a
 * failure is shown inside it. That matters most for the access-code form: the
 * server rejects a bad paste, and closing the dialog first would throw away
 * everything else the user had typed alongside it.
 */
function openForm({ title, lede, fields, okText = 'Save', danger = false, wide = false, dismissOnly = false, submit: onSubmit }) {
  return new Promise(resolve => {
    const dlg = el('dialog', { className: wide ? 'wide' : '' });
    const errBox = el('div', { className: 'err', hidden: true });
    const inputs = new Map();

    const body = el('div', { className: 'dlg' },
      el('h2', { textContent: title }),
      lede ? el('p', { className: 'lede', textContent: lede }) : null,
      fields.map(field => {
        const control = field.multiline
          ? el('textarea', { value: field.value || '', placeholder: field.placeholder || '', spellcheck: false })
          : el('input', {
              value: field.value || '', placeholder: field.placeholder || '',
              autocomplete: 'off', spellcheck: false, type: field.type || 'text',
            });
        inputs.set(field.name, control);
        return el('div', {},
          el('label', { textContent: field.label }),
          control,
          field.hint ? el('div', { className: 'hint', textContent: field.hint }) : null);
      }),
      errBox);

    // A dialog that only shows something has nothing to cancel out of.
    const cancel = el('button', { type: 'button', textContent: 'Cancel', hidden: dismissOnly });
    const submit = el('button', {
      type: 'submit', className: danger ? 'danger' : 'primary', textContent: okText,
    });
    body.append(el('div', { className: 'row' }, cancel, submit));

    const form = el('form', {}, body);
    dlg.append(form);
    document.body.append(dlg);

    const close = result => { dlg.close(); dlg.remove(); resolve(result); };
    cancel.onclick = () => close(null);
    dlg.addEventListener('cancel', ev => { ev.preventDefault(); close(null); });

    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const values = {};
      for (const [name, control] of inputs) values[name] = control.value.trim();

      if (!onSubmit) return close(values);

      errBox.hidden = true;
      submit.disabled = true;
      const busy = submit.textContent;
      submit.textContent = 'Working…';
      try {
        await onSubmit(values);
        close(values);
      } catch (err) {
        errBox.textContent = err.message;
        errBox.hidden = false;
        submit.disabled = false;
        submit.textContent = busy;
      }
    });

    dlg.showModal();
    const first = inputs.values().next().value;
    if (first) { first.focus(); first.select && first.select(); }
  });
}

/* ---------- shared bits ---------- */

function meter(used, limit) {
  if (!limit) return null;
  const pct = Math.min(100, (used / limit) * 100);
  const bar = el('i', { className: pct >= 100 ? 'over' : pct >= 80 ? 'warn' : '' });
  bar.style.width = pct + '%';
  return el('div', { className: 'meter' }, bar);
}

function activeServer() {
  return state.servers.find(server => server.id === state.activeServerId) || null;
}

async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    if (button) {
      const original = button.textContent;
      button.textContent = 'copied';
      setTimeout(() => { button.textContent = original; }, 1200);
    }
  } catch (err) {
    // Clipboard access can be refused; fall back to a selection to copy by hand.
    await openForm({
      title: 'Copy this', lede: 'Your browser refused clipboard access.',
      fields: [{ name: 'value', label: 'Value', value: text, multiline: true }],
      okText: 'Done', dismissOnly: true,
    });
  }
}

/* ---------- access keys ---------- */

function addKey() {
  return openForm({
    title: 'New access key',
    lede: 'Creates a key on ' + (activeServer() ? activeServer().name || activeServer().host : 'this server') + '.',
    fields: [
      { name: 'name', label: 'Name', placeholder: 'e.g. Alice' },
      { name: 'limit', label: 'Data limit', placeholder: 'no limit', hint: 'e.g. 50GB. Leave empty for no limit.' },
    ],
    okText: 'Create',
  }).then(values => {
    if (!values) return;
    return act(() => api('POST', '/api/keys', { name: values.name, limitBytes: values.limit || null }));
  });
}

function renameKey(key) {
  return openForm({
    title: 'Rename key',
    fields: [{ name: 'name', label: 'Name', value: key.name }],
  }).then(values => {
    if (!values || values.name === key.name) return;
    return act(() => api('PUT', '/api/keys/' + encodeURIComponent(key.id) + '/name', { name: values.name }));
  });
}

function limitKey(key) {
  return openForm({
    title: 'Data limit for ' + (key.name || 'key ' + key.id),
    fields: [{
      name: 'limit', label: 'Limit', value: sizeInput(key.dataLimitBytes),
      placeholder: 'no limit', hint: 'e.g. 50GB, 500MB. Leave empty to remove the limit.',
    }],
  }).then(values => {
    if (!values) return;
    return act(() => api('PUT', '/api/keys/' + encodeURIComponent(key.id) + '/limit', { bytes: values.limit || null }));
  });
}

function removeKey(key) {
  const label = key.name || 'key ' + key.id;
  if (!confirm('Delete ' + label + '? Anyone using this key loses access immediately.')) return;
  return act(() => api('DELETE', '/api/keys/' + encodeURIComponent(key.id)));
}

async function showQr(key) {
  let data;
  try {
    data = await api('GET', '/api/keys/' + encodeURIComponent(key.id) + '/qr');
  } catch (err) {
    return showError(err.message);
  }

  const dlg = el('dialog', { className: 'wide' });
  let code;
  if (data.svgPath) {
    // Built node by node rather than as markup: nothing derived from the access
    // URL ends up in an attribute this way.
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + data.svgSize + ' ' + data.svgSize);
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('class', 'qr-svg');
    const bg = document.createElementNS(ns, 'rect');
    bg.setAttribute('width', String(data.svgSize));
    bg.setAttribute('height', String(data.svgSize));
    bg.setAttribute('fill', '#fff');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', data.svgPath);
    path.setAttribute('fill', '#000');
    svg.append(bg, path);
    code = svg;
  } else {
    code = el('pre', { className: 'qr', textContent: data.qr });
  }

  const close = el('button', { textContent: 'Close' });
  const copyBtn = el('button', { textContent: 'Copy URL' });
  dlg.append(el('div', { className: 'dlg' },
    el('h2', { textContent: data.name || 'Access key' }),
    el('p', { className: 'lede', textContent: 'Scan this in the Outline app to connect.' }),
    el('div', { className: 'qr-wrap' }, code, el('div', { className: 'qr-url', textContent: data.accessUrl })),
    el('div', { className: 'row' }, copyBtn, close)));

  copyBtn.onclick = () => copy(data.accessUrl, copyBtn);
  const dismiss = () => { dlg.close(); dlg.remove(); };
  close.onclick = dismiss;
  dlg.addEventListener('cancel', dismiss);
  document.body.append(dlg);
  dlg.showModal();
}

function keysTable() {
  const needle = filter.trim().toLowerCase();
  const keys = needle
    ? state.keys.filter(key => (key.name || '').toLowerCase().includes(needle) || String(key.id) === needle)
    : state.keys;

  if (!state.keys.length) {
    const add = el('button', { className: 'primary', textContent: 'Add the first key', onclick: addKey });
    return el('div', { className: 'panel' },
      el('div', { className: 'empty' }, el('p', { textContent: 'This server has no access keys yet.' }), add));
  }
  if (!keys.length) {
    return el('div', { className: 'panel' },
      el('div', { className: 'empty' }, el('p', { textContent: 'No key matches "' + filter + '".' })));
  }

  const rows = keys.map(key => {
    const copyBtn = el('button', { className: 'link', textContent: 'copy' });
    copyBtn.onclick = () => copy(key.accessUrl, copyBtn);

    return el('tr', {},
      el('td', { className: 'num mono', textContent: key.id }),
      el('td', {}, el('div', {
        className: 'name' + (key.name ? '' : ' unnamed'),
        textContent: key.name || 'Unnamed',
      })),
      el('td', { className: 'num' },
        el('div', { textContent: formatBytes(key.bytes) }),
        meter(key.bytes, key.dataLimitBytes)),
      el('td', { className: 'num' },
        el('span', { className: 'pill', textContent: key.dataLimitBytes ? formatBytes(key.dataLimitBytes) : '—' })),
      el('td', {},
        el('span', { className: 'mono url', textContent: key.accessUrl, title: key.accessUrl }), ' ', copyBtn),
      el('td', { className: 'actions' },
        el('button', { className: 'link', textContent: 'QR', onclick: () => showQr(key) }),
        el('button', { className: 'link', textContent: 'rename', onclick: () => renameKey(key) }),
        el('button', { className: 'link', textContent: 'limit', onclick: () => limitKey(key) }),
        el('button', { className: 'link danger', textContent: 'delete', onclick: () => removeKey(key) })));
  });

  return el('div', { className: 'panel scroll' },
    el('table', {},
      el('thead', {}, el('tr', {},
        el('th', { textContent: 'ID' }),
        el('th', { textContent: 'Name' }),
        el('th', { textContent: 'Used', style: 'text-align:right' }),
        el('th', { textContent: 'Limit', style: 'text-align:right' }),
        el('th', { textContent: 'Access URL' }),
        el('th', {}))),
      el('tbody', {}, rows)));
}

function renderKeys() {
  const search = el('input', {
    className: 'search', type: 'search', placeholder: 'Filter by name or id', value: filter,
  });
  search.oninput = () => {
    filter = search.value;
    const wrap = $('#keys-table');
    if (wrap) wrap.replaceWith(Object.assign(keysTable(), { id: 'keys-table' }));
  };

  const table = keysTable();
  table.id = 'keys-table';

  return [
    el('div', { className: 'bar' },
      el('button', { className: 'primary', textContent: 'Add key', onclick: addKey }),
      search,
      el('span', { className: 'spacer' }),
      el('span', { className: 'crumb', textContent: state.keys.length + (state.keys.length === 1 ? ' key' : ' keys') })),
    table,
  ];
}

/* ---------- overview ---------- */

function stat(label, value, note) {
  return el('div', { className: 'stat' },
    el('div', { className: 'label', textContent: label }),
    el('div', { className: 'value', textContent: value }),
    note ? el('div', { className: 'note', textContent: note }) : null);
}

function renderOverview() {
  const total = state.keys.reduce((sum, key) => sum + (key.bytes || 0), 0);
  const capped = state.keys.filter(key => key.dataLimitBytes).length;
  const overLimit = state.keys.filter(key => key.dataLimitBytes && key.bytes >= key.dataLimitBytes);
  const server = activeServer();

  const busiest = state.keys.slice().sort((a, b) => b.bytes - a.bytes).slice(0, 5);

  const nodes = [
    el('div', { className: 'stats' },
      stat('Access keys', String(state.keys.length), capped ? capped + ' with a limit' : 'none limited'),
      stat('Transferred', formatBytes(total), 'across all keys'),
      stat('Default cap', state.serverLimitBytes ? formatBytes(state.serverLimitBytes) : 'None',
        'applies to keys without their own'),
      stat('Servers', String(state.servers.length), server ? 'active: ' + (server.name || server.host) : 'none configured')),
  ];

  if (overLimit.length) {
    nodes.push(el('div', { className: 'notice warn' }, el('div', { className: 'grow' },
      el('strong', { textContent: overLimit.length + (overLimit.length === 1 ? ' key has' : ' keys have') + ' reached its data limit' }),
      overLimit.map(key => key.name || 'key ' + key.id).join(', '))));
  }

  nodes.push(el('div', { className: 'panel' },
    el('h2', {}, 'Busiest keys', el('span', { className: 'sub', textContent: 'by data transferred' })),
    busiest.length
      ? el('div', { className: 'scroll' }, el('table', {},
          el('thead', {}, el('tr', {},
            el('th', { textContent: 'Name' }),
            el('th', { textContent: 'Used', style: 'text-align:right' }),
            el('th', { textContent: 'Of limit', style: 'text-align:right' }))),
          el('tbody', {}, busiest.map(key => el('tr', {},
            el('td', {}, el('span', {
              className: 'name' + (key.name ? '' : ' unnamed'),
              textContent: key.name || 'Unnamed',
            })),
            el('td', { className: 'num' }, el('div', { textContent: formatBytes(key.bytes) }),
              meter(key.bytes, key.dataLimitBytes)),
            el('td', {
              className: 'num',
              textContent: key.dataLimitBytes ? Math.round((key.bytes / key.dataLimitBytes) * 100) + '%' : '—',
            }))))))
      : el('div', { className: 'empty', textContent: 'No keys on this server yet.' })));

  return nodes;
}

/* ---------- servers ---------- */

function addServer() {
  return openForm({
    title: 'Add an Outline server',
    lede: 'Open Outline Manager, choose your server, and copy the line under Settings > Management API URL.',
    wide: true,
    fields: [
      { name: 'name', label: 'Name', placeholder: 'e.g. Frankfurt' },
      {
        name: 'accessCode', label: 'Access code', multiline: true,
        placeholder: '{"apiUrl":"https://1.2.3.4:16942/AbCdEf123","certSha256":"E38…"}',
        hint: 'The whole JSON line, or just the Management API URL.',
      },
      { name: 'domain', label: 'Custom domain (optional)', placeholder: 'vpn.example.com',
        hint: 'Used in access URLs in place of the server IP.' },
    ],
    okText: 'Add server',
    submit: values => run(() => api('POST', '/api/servers', values)),
  });
}

function editServer(server) {
  return openForm({
    title: 'Edit ' + (server.name || server.host),
    wide: true,
    fields: [
      { name: 'name', label: 'Name', value: server.name },
      { name: 'domain', label: 'Custom domain', value: server.domain, placeholder: 'vpn.example.com',
        hint: 'Leave empty to use the server IP in access URLs.' },
      {
        name: 'accessCode', label: 'Replace access code (optional)', multiline: true,
        placeholder: server.apiUrlPreview,
        hint: 'Leave empty to keep the current one. Paste a new code if the server moved or was rebuilt.',
      },
    ],
    submit: values => run(() => api('PUT', '/api/servers/' + encodeURIComponent(server.id), values)),
  });
}

async function revealAccessCode(server) {
  let data;
  try {
    data = await api('GET', '/api/servers/' + encodeURIComponent(server.id) + '/access-code');
  } catch (err) {
    return showError(err.message);
  }
  await openForm({
    title: 'Access code for ' + (server.name || server.host),
    lede: 'This grants full administrative control of the server. Treat it like a password.',
    wide: true,
    fields: [{ name: 'code', label: 'Paste into Outline Manager or another machine', value: data.json, multiline: true }],
    okText: 'Done', dismissOnly: true,
  });
}

/**
 * Checks one server and reports the outcome under its buttons.
 *
 * The result deliberately does not go in the button's own label: it is longer
 * than "test", and growing a button reflows the row while the pointer is still
 * over it, which is how you end up clicking "remove" by accident.
 */
async function testServer(server, button, result) {
  button.disabled = true;
  result.className = 'test-result';
  result.textContent = 'Testing…';
  showError('');

  try {
    const info = await api('POST', '/api/servers/' + encodeURIComponent(server.id) + '/test');
    result.className = 'test-result ok';
    result.textContent = info.name ? 'Reached "' + info.name + '"' : 'Reachable';
  } catch (err) {
    result.className = 'test-result bad';
    result.textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

function removeServer(server) {
  const label = server.name || server.host;
  if (!confirm(
    'Remove ' + label + ' from this dashboard?\\n\\n' +
    'The server itself and its keys are untouched — only the saved access code goes away.'
  )) return;
  return act(() => api('DELETE', '/api/servers/' + encodeURIComponent(server.id)));
}

function serverCard(server) {
  const card = el('div', { className: 'card' + (server.active ? ' active' : '') });

  card.append(el('h3', {},
    server.name || server.host || 'Unnamed server',
    server.active ? el('span', { className: 'pill on', textContent: 'active' }) : null,
    server.source === 'env' ? el('span', { className: 'pill', textContent: 'environment' }) : null));

  const dl = el('dl', {},
    el('dt', { textContent: 'Host' }), el('dd', { className: 'mono', textContent: server.host || '—' }),
    el('dt', { textContent: 'Domain' }), el('dd', { textContent: server.domain || 'none' }),
    el('dt', { textContent: 'API' }), el('dd', { className: 'mono', textContent: server.apiUrlPreview || '—' }),
    el('dt', { textContent: 'Cert' }),
    el('dd', { textContent: server.certPinned ? 'pinned' : 'not pinned' }));
  card.append(dl);

  const testResult = el('div', { className: 'test-result', hidden: true });
  const testBtn = el('button', { className: 'link', textContent: 'test' });
  testBtn.onclick = () => { testResult.hidden = false; testServer(server, testBtn, testResult); };

  const row = el('div', { className: 'row' },
    server.active
      ? null
      : el('button', {
          className: 'link', textContent: 'make active',
          onclick: () => act(() => api('POST', '/api/servers/' + encodeURIComponent(server.id) + '/activate')),
        }),
    testBtn,
    el('button', { className: 'link', textContent: 'access code', onclick: () => revealAccessCode(server) }),
    server.editable ? el('button', { className: 'link', textContent: 'edit', onclick: () => editServer(server) }) : null,
    server.editable
      ? el('button', { className: 'link danger', textContent: 'remove', onclick: () => removeServer(server) })
      : null);
  card.append(row, testResult);
  return card;
}

/* ---------- provisioning ---------- */

/**
 * Asks for SSH credentials and installs Outline on a new server.
 *
 * The form closes as soon as the run starts, because the run outlives it: a
 * fresh server takes minutes, and holding a modal open over that is the wrong
 * shape. What follows is a progress panel that can be left and returned to.
 */
function provisionForm() {
  return openForm({
    title: 'Install Outline on a new server',
    lede: 'Connects over SSH, installs Outline, and adds the server here. ' +
          'Credentials are used for this connection only and never stored.',
    wide: true,
    fields: [
      { name: 'host', label: 'Server address', placeholder: '203.0.113.9 or vps.example.com' },
      { name: 'username', label: 'SSH username', placeholder: 'root', hint: 'Needs root, or sudo without a password.' },
      { name: 'password', label: 'SSH password', type: 'password',
        hint: 'Leave empty to use a private key instead.' },
      { name: 'privateKey', label: 'Private key', multiline: true,
        placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----',
        hint: 'Optional. Paste the key itself if you are not using a password.' },
      { name: 'passphrase', label: 'Key passphrase', type: 'password', hint: 'Only if the key has one.' },
      { name: 'sshPort', label: 'SSH port', placeholder: '22' },
      { name: 'name', label: 'Name for this server', placeholder: 'defaults to the address' },
      { name: 'domain', label: 'Custom domain (optional)', placeholder: 'vpn.example.com',
        hint: 'Used in access URLs in place of the server IP.' },
      { name: 'keys', label: 'Access keys to create', placeholder: '1' },
    ],
    okText: 'Install',
    submit: async values => {
      if (!values.host) throw new Error('A server address is required.');
      if (!values.password && !values.privateKey) {
        throw new Error('Give either a password or a private key.');
      }
      const { jobId } = await api('POST', '/api/provision', values);
      // Nothing here is kept: the values object goes out of scope with the
      // dialog, and the server does not put the credential on the job.
      watchProvision(jobId);
    },
  });
}

/** Renders the live state of a provisioning run, polling until it settles. */
function watchProvision(jobId) {
  const log = el('pre', { className: 'joblog', textContent: '' });
  const statusLine = el('div', { className: 'crumb' });
  const actions = el('div', { className: 'row' });

  const dlg = el('dialog', { className: 'wide' });
  dlg.append(el('div', { className: 'dlg' },
    el('h2', { textContent: 'Installing Outline' }),
    el('p', { className: 'lede', textContent:
      'This takes a few minutes on a fresh server. You can close this — it keeps going.' }),
    statusLine, log, actions));
  document.body.append(dlg);
  dlg.showModal();

  const close = () => { dlg.close(); dlg.remove(); };
  const closeBtn = el('button', { textContent: 'Close' , onclick: close });
  actions.append(closeBtn);
  dlg.addEventListener('cancel', close);

  let stopped = false;
  let askedFor = null;

  async function tick() {
    if (stopped) return;
    let job;
    try {
      job = await api('GET', '/api/provision/' + encodeURIComponent(jobId));
    } catch (err) {
      statusLine.textContent = err.message;
      return;
    }

    log.textContent = job.output || '';
    log.scrollTop = log.scrollHeight;

    // The SSH handshake is parked until this is answered, so it is the only
    // thing on screen that matters while it is up.
    if (job.status === 'awaiting-host-key' && job.hostKey && askedFor !== job.hostKey.fingerprint) {
      askedFor = job.hostKey.fingerprint;
      statusLine.textContent = '';
      const accepted = await confirmHostKey(job.hostKey);
      await api('POST', '/api/provision/' + encodeURIComponent(jobId) + '/host-key', { accept: accepted });
    }

    if (job.status === 'done') {
      stopped = true;
      statusLine.textContent = job.warning || 'Done. The server has been added.';
      statusLine.className = job.warning ? 'crumb warnline' : 'crumb';
      if (job.keys && job.keys.length) {
        log.textContent += '\\n' + job.keys.map(k => k.accessUrl).join('\\n') + '\\n';
      }
      actions.replaceChildren(
        el('button', { className: 'primary', textContent: 'Show the new server', onclick: () => {
          close();
          location.hash = '#servers';
          act(() => api('GET', '/api/state'));
        } }),
        closeBtn);
      return act(() => api('GET', '/api/state'));
    }

    if (job.status === 'failed') {
      stopped = true;
      statusLine.textContent = job.error || 'The run failed.';
      statusLine.className = 'crumb bad';
      return;
    }

    statusLine.textContent = job.status === 'awaiting-host-key'
      ? 'Waiting for you to confirm the host key…'
      : 'Working…';
    setTimeout(tick, 1200);
  }

  tick();
}

/**
 * Puts the host key in front of somebody before anything is sent to the server.
 *
 * Deliberately not a plain confirm(): the fingerprint has to be readable and
 * comparable against a provider's console, and accepting has to be a decision
 * rather than a reflex.
 */
function confirmHostKey({ hostPort, fingerprint }) {
  return new Promise(resolve => {
    const dlg = el('dialog', { className: 'wide' });
    const accept = el('button', { className: 'primary', textContent: 'Accept and continue' });
    const reject = el('button', { textContent: 'Cancel' });

    dlg.append(el('div', { className: 'dlg' },
      el('h2', { textContent: 'Is this the right server?' }),
      el('p', { className: 'lede', textContent:
        hostPort + ' has not been seen before. Compare this fingerprint with the one your ' +
        'provider shows in its console. If they differ, something is intercepting the connection.' }),
      el('div', { className: 'fingerprint', textContent: fingerprint }),
      el('div', { className: 'hint', textContent:
        'Nothing has been sent to the server yet — your credentials are not transmitted until ' +
        'this key is accepted.' }),
      el('div', { className: 'row' }, reject, accept)));

    document.body.append(dlg);
    dlg.showModal();

    const done = value => { dlg.close(); dlg.remove(); resolve(value); };
    accept.onclick = () => done(true);
    reject.onclick = () => done(false);
    dlg.addEventListener('cancel', () => done(false));
  });
}

/** The card that starts a provisioning run. */
function provisionCard() {
  return el('div', { className: 'card' },
    el('h3', {}, 'Install Outline on a new server'),
    el('p', { className: 'cardnote', textContent:
      'Connects to a host over SSH, installs Outline, adds it here and creates access keys. ' +
      'Works with any provider. Credentials are never stored.' }),
    el('div', { className: 'row' },
      el('button', { className: 'primary small', textContent: 'Install on a server', onclick: provisionForm })));
}

function renderServers() {
  const nodes = [
    el('div', { className: 'bar' },
      el('button', { className: 'primary', textContent: 'Add server', onclick: addServer }),
      el('span', { className: 'spacer' }),
      el('span', {
        className: 'crumb',
        textContent: state.servers.length + (state.servers.length === 1 ? ' server' : ' servers'),
      })),
  ];

  if (!state.servers.length) {
    nodes.push(el('div', { className: 'panel' }, el('div', { className: 'empty' },
      el('p', { textContent: 'No Outline servers yet. Add one with its access code from Outline Manager.' }),
      el('button', { className: 'primary', textContent: 'Add your first server', onclick: addServer }))));
  } else {
    nodes.push(el('div', { className: 'cards' }, state.servers.map(serverCard)));
  }

  nodes.push(el('div', { className: 'panel' },
    el('h2', {}, 'Provisioning'),
    el('div', { className: 'body' }, el('div', { className: 'cards' }, provisionCard()))));

  return nodes;
}

/* ---------- settings ---------- */

function setServerLimit() {
  return openForm({
    title: 'Server-wide default limit',
    lede: 'Applies to every key that has no limit of its own.',
    fields: [{
      name: 'limit', label: 'Limit', value: sizeInput(state.serverLimitBytes),
      placeholder: 'no limit', hint: 'e.g. 100GB. Leave empty to remove the default cap.',
    }],
  }).then(values => {
    if (!values) return;
    return act(() => api('PUT', '/api/server/limit', { bytes: values.limit || null }));
  });
}

function renderSettings() {
  const server = activeServer();
  const nodes = [];

  nodes.push(el('div', { className: 'panel' },
    el('h2', {}, 'Active server',
      el('span', { className: 'sub', textContent: server ? (server.name || server.host) : 'none' })),
    el('div', { className: 'body' },
      server
        ? el('div', {},
            state.serverName
              ? el('div', { className: 'bar' },
                  el('span', { className: 'crumb', textContent: 'Reports its name as "' + state.serverName + '"' }))
              : null,
            el('div', { className: 'bar' },
              el('span', { className: 'crumb', textContent: 'Access URLs use ' + (state.host || '—') }),
              el('span', { className: 'spacer' }),
              server.editable
                ? el('button', { className: 'small', textContent: 'Change domain', onclick: () => editServer(server) })
                : el('span', { className: 'crumb', textContent: 'Set OUTLINE_DOMAIN to change this' })),
            el('div', { className: 'bar' },
              el('span', {
                className: 'crumb',
                textContent: state.reachable
                  ? 'Default data cap: ' +
                    (state.serverLimitBytes ? formatBytes(state.serverLimitBytes) : 'none')
                  : 'Default data cap: unknown while the server is unreachable',
              }),
              el('span', { className: 'spacer' }),
              el('button', {
                className: 'small', textContent: 'Set default cap',
                disabled: !state.reachable, onclick: setServerLimit,
              })))
        : el('div', { className: 'crumb', textContent: 'Add a server to configure it.' }))));

  nodes.push(el('div', { className: 'panel' },
    el('h2', {}, 'Where things are stored'),
    el('div', { className: 'body' },
      el('div', { className: 'card' },
        el('dl', {},
          el('dt', { textContent: 'Saved servers' }),
          el('dd', { className: 'mono', textContent: state.configPath || 'not saved to disk this session' }),
          el('dt', { textContent: 'Interface' }),
          el('dd', { textContent: 'localhost only, authorised by the token in this URL' }))),
      el('p', { className: 'hint', textContent:
        'The config file holds Management API URLs, which grant full administrative control of ' +
        'your servers. It is written readable only by you. Anyone who can read it can administer ' +
        'every server listed above.' }))));

  return nodes;
}

/* ---------- shell ---------- */

function renderNav() {
  const nav = $('#nav');
  nav.replaceChildren();
  for (const item of SECTIONS) {
    const link = el('a', { href: '#' + item.id, textContent: '' },
      el('span', { className: 'dot' }),
      el('span', { textContent: item.label }));
    if (item.id === section) link.setAttribute('aria-current', 'page');
    if (item.id === 'keys' && state.keys.length) {
      link.append(el('span', { className: 'count', textContent: String(state.keys.length) }));
    }
    if (item.id === 'servers' && state.servers.length) {
      link.append(el('span', { className: 'count', textContent: String(state.servers.length) }));
    }
    nav.append(link);
  }
}

function renderSwitcher() {
  const wrap = $('#switcher');
  wrap.replaceChildren();
  if (!state.servers.length) return;

  const select = el('select', { title: 'Active server' });
  for (const server of state.servers) {
    const option = el('option', { value: server.id, textContent: server.name || server.host });
    if (server.id === state.activeServerId) option.selected = true;
    select.append(option);
  }
  select.onchange = () =>
    act(() => api('POST', '/api/servers/' + encodeURIComponent(select.value) + '/activate'));

  const led = el('span', { className: 'led ' + (state.reachable ? 'up' : 'down') });
  wrap.append(select, el('span', { className: 'state' }, led,
    el('span', { textContent: state.reachable ? 'reachable' : 'unreachable' })));
}

/** The banner shown when the active server exists but cannot be talked to. */
function unreachableNotice() {
  const goToServers = el('button', { className: 'small', textContent: 'Open Servers' });
  goToServers.onclick = () => { location.hash = '#servers'; };

  return el('div', { className: 'notice err' },
    el('div', { className: 'grow' },
      el('strong', { textContent: 'Cannot reach this server' }),
      state.unreachableReason || 'The Management API did not respond.'),
    goToServers);
}

/** Shown before any server exists, in place of every section but Servers. */
function noServerNotice() {
  return el('div', { className: 'panel' }, el('div', { className: 'empty' },
    el('p', { textContent: 'No Outline server is configured yet.' }),
    el('button', { className: 'primary', textContent: 'Add a server', onclick: addServer })));
}

function render() {
  renderNav();
  renderSwitcher();

  const server = activeServer();
  $('#title').textContent = SECTIONS.find(item => item.id === section).label;
  $('#crumb').textContent = server ? (state.host || server.host) : '';

  const view = $('#view');
  view.replaceChildren();

  // Overview and Access keys are made entirely of server data, so an
  // unreachable server leaves them nothing to show. Servers and Settings are
  // mostly local, and are exactly where you go to fix the problem, so they
  // render under the banner rather than behind it.
  const needsServer = section === 'overview' || section === 'keys';
  const down = Boolean(state.activeServerId) && !state.reachable;

  if (down) view.append(unreachableNotice());

  if (!state.servers.length && section !== 'servers') {
    view.append(noServerNotice());
    return;
  }
  if (down && needsServer) return;

  const sections = {
    overview: renderOverview,
    keys: renderKeys,
    servers: renderServers,
    settings: renderSettings,
  };
  for (const node of [sections[section]()].flat()) if (node) view.append(node);
}

function onHashChange() {
  const wanted = (location.hash || '').replace('#', '');
  section = SECTIONS.some(item => item.id === wanted) ? wanted : 'overview';
  render();
}

function init() {
  if (!token) {
    showError('No access token in the URL. Open the link printed in your terminal.');
  }
  $('#refresh').onclick = () => act(() => api('GET', '/api/state'));
  window.addEventListener('hashchange', onHashChange);

  const wanted = (location.hash || '').replace('#', '');
  section = SECTIONS.some(item => item.id === wanted) ? wanted : 'overview';

  act(() => api('GET', '/api/state'));
}

document.addEventListener('DOMContentLoaded', init);
`;

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>shadowtools</title>
<style>${CSS}</style>
</head>
<body>
<div class="app">
  <aside>
    <div class="brand"><b>shadowtools</b><span>Outline admin</span></div>
    <nav id="nav"></nav>
    <div class="foot">Runs on localhost.<br>Credentials never reach the browser.</div>
  </aside>

  <main>
    <div class="top">
      <h1 id="title">Overview</h1>
      <span class="crumb" id="crumb"></span>
      <span class="spacer"></span>
      <span class="switcher" id="switcher"></span>
      <button id="refresh">Refresh</button>
    </div>

    <div class="content">
      <div class="notice err" id="error" hidden></div>
      <div id="view"></div>
    </div>
  </main>
</div>

<script>${JS}</script>
</body>
</html>`;

function page() {
    return HTML;
}

module.exports = { page };
