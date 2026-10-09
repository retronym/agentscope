// async-profiler captures (tier 2 of docs/jvm-profiler.md), in a JVM's full view: one bounded window, on an explicit
// click. Flame graphs reuse profile.js's renderer (key 'cap<id>'), including differential ones against another capture.
// Uses the page's globals (S, $, esc, api, patch, mb, DEMO) and profile.js's (prof, drawFlame, post, clock).

const CAP_MODES = [['cpu', 'CPU + alloc + locks'], ['wall', 'Wall clock'], ['all', 'Everything']];
const capLists = {};  // jvm id -> {t, rows}
let capSeconds = null;  // read lazily: this script loads before the page's own, which defines localStore
const capSecs = () => capSeconds ??= +(localStore('capSeconds') || 30);

async function loadCaptures(jvmId, force) {
  const c = capLists[jvmId];
  if (!force && c && Date.now() - c.t < (c.rows.some(r => r.status === 'running') ? 2000 : 15000)) return c.rows;
  try { capLists[jvmId] = { t: Date.now(), rows: await api(`/api/captures?jvm=${jvmId}`) }; } catch (e) { capLists[jvmId] = { t: Date.now(), rows: [] }; }
  if (boxId === jvmId) renderCaptures(jvmId);
  return capLists[jvmId].rows;
}

async function startCapture(jvmId, mode) {
  const label = CAP_MODES.find(m => m[0] === mode)[1];
  if (!confirm(`Capture ${capSecs()} s of ${label} with async-profiler?\n\nThis loads async-profiler's native agent into the JVM. Once loaded it stays (an agent can't be unloaded), idle between captures.`)) return;
  try { await post('/api/jvm/capture', { id: jvmId, mode, seconds: capSecs() }); }
  catch (e) { alert('Capture failed to start: ' + (e.message || e)); }
  loadCaptures(jvmId, true);
}

function renderCaptures(jvmId) {
  const el = document.querySelector('#jvmbox .jbox-cap'); if (!el) return;
  if (DEMO) { patch(el, ''); return; }
  if (!S.asprof) { patch(el, `<div class="profh"><b>Captures</b><span class="sub">Install async-profiler (<code>brew install async-profiler</code>) for wall-clock, native-memory and allocation captures.</span></div>`); return; }
  const rows = capLists[jvmId]?.rows || [], running = rows.find(r => r.status === 'running');
  const open = Object.keys(prof).find(k => k.startsWith('cap') && prof[k].jvm === jvmId && prof[k].shown);
  const p = open && prof[open];
  patch(el, `<div class="profh"><b>Captures</b><span class="sub">async-profiler, one JVM, a bounded window</span>
      ${CAP_MODES.map(([m, l]) => `<button class="btn-link" ${running ? 'disabled' : ''} onclick="startCapture(${jvmId}, '${m}')">● ${l}</button>`).join('')}
      <select class="recscope" onchange="capSeconds=+this.value;localStore('capSeconds', this.value)">${[10, 30, 60, 120].map(s => `<option value="${s}" ${s === capSecs() ? 'selected' : ''}>${s} s</option>`).join('')}</select>
      ${running ? `<span class="sub">capturing… ${clock(Math.max(0, running.started + running.seconds - Date.now() / 1000))} left</span>` : ''}</div>
    ${rows.length ? `<table class="jt caps"><tr><th>when</th><th>what</th><th>status</th><th>show</th><th></th></tr>${rows.map(r => capRow(r, rows, p)).join('')}</table>` : ''}
    ${p ? `<div class="profc"><div class="flameh" id="flameh-${open}"></div><canvas id="flame-${open}"></canvas></div>` : ''}`);
  if (p) drawFlame(open);
}

function capRow(r, rows, p) {
  const key = 'cap' + r.id, shown = p && p.cap === r.id;
  const kinds = Object.keys(r.kinds || {});
  const others = rows.filter(o => o.id !== r.id && o.status === 'done');
  const st = r.status === 'running' ? '<span class="sub">running…</span>' : r.status === 'failed' ? `<span class="err" title="${esc(r.error || '')}">failed: ${esc((r.error || '').slice(0, 80))}</span>` : `<span class="sub">${mb(r.bytes || 0)}</span>`;
  return `<tr class="${shown ? 'open' : ''}"><td class="sub">${new Date(r.started * 1000).toLocaleTimeString()}</td><td>${esc(r.mode_label)} <span class="sub">${r.seconds} s</span></td><td>${st}</td>
    <td>${kinds.map(k => `<button class="btn-link ${shown && p.kind === k ? 'on' : ''}" onclick="showCapture(${r.jvm_id}, ${r.id}, '${k}')">${esc(KIND_LABEL[k] || k)}</button>`).join(' ')}
      ${shown && others.length ? `<select class="recscope" title="compare with an earlier or later capture" onchange="setCapBase(${r.id}, this.value)"><option value="">diff against…</option>${others.map(o => `<option value="${o.id}" ${p.base === o.id ? 'selected' : ''}>${new Date(o.started * 1000).toLocaleTimeString()} ${esc(o.mode)}</option>`).join('')}</select>` : ''}</td>
    <td style="white-space:nowrap">${r.status === 'done' ? `<a class="sub" href="/api/capture/html?id=${r.id}&kind=${kinds[0] || 'cpu'}" target="_blank" title="async-profiler's own flame graph (jfrconv)">↗ async-profiler</a> · <a class="sub" href="/api/capture/file?id=${r.id}" title="the .jfr, for JMC or jfrconv">⤓ .jfr</a>` : ''}</td></tr>`;
}

function showCapture(jvmId, cid, kind) {
  for (const k of Object.keys(prof)) if (k.startsWith('cap')) prof[k].shown = false;
  const key = 'cap' + cid;
  prof[key] = Object.assign(prof[key] || { zoom: [] }, { jvm: jvmId, cap: cid, kind, shown: true, zoom: [], load: () => loadCapFlame(key) });
  renderCaptures(jvmId);
  loadCapFlame(key);
}
function setCapBase(cid, base) { const p = prof['cap' + cid]; p.base = base ? +base : null; p.zoom = []; loadCapFlame('cap' + cid); }
async function loadCapFlame(key) {
  const p = prof[key];
  try { p.flame = await api(`/api/capture/flame?id=${p.cap}&kind=${p.kind}&reverse=${p.reverse ? 1 : 0}${p.base ? '&base=' + p.base : ''}`); p.error = null; }
  catch (e) { p.error = String(e.message || e); p.flame = null; }
  renderCaptures(p.jvm);
}
