// async-profiler captures (tier 2 of docs/jvm-profiler.md), in a JVM's full view: one bounded window, on an explicit
// click. Flame graphs reuse profile.js's renderer (key 'cap<id>'), including differential ones against another capture.
// Uses the page's globals (S, $, esc, api, patch, mb, DEMO) and profile.js's (prof, drawFlame, post, clock).

const CAP_MODES = [['cpu', 'CPU + alloc + locks'], ['wall', 'Wall clock'], ['all', 'Everything']];
const capLists = {};  // jvm id -> {t, rows}
let capSeconds = null;  // read lazily: this script loads before the page's own, which defines localStore
const capSecs = () => capSeconds ??= +(localStore('capSeconds') || 30);
// Power-user options (the server's whitelist is S.capture_options), kept for every capture until reset: interval,
// allocation and lock thresholds, native stack walking, -F features. The ▾ beside a capture button opens them.
let capOptsV = null;
const capOpts = () => capOptsV ??= (() => { try { return JSON.parse(localStore('capOpts') || '{}'); } catch (e) { return {}; } })();
function setCapOpt(k, v) {
  const o = capOpts();
  if (v === '' || v == null || (Array.isArray(v) && !v.length)) delete o[k]; else o[k] = v;
  localStore('capOpts', JSON.stringify(o));
  renderCaptures(boxId);
}
function toggleCapFeature(f, on) { setCapOpt('features', [...(capOpts().features || []).filter(x => x !== f), ...(on ? [f] : [])]); }
const CAP_OPT_LABELS = { interval: ['sampling interval', '-i: how often CPU or wall-clock samples are taken (10ms by default)'],
  alloc: ['allocation sample every', '--alloc: bytes allocated between samples (0: every new TLAB)'], lock: ['locks held at least', '--lock: contended locks held at least this long'],
  cstack: ['native stacks', '--cstack: how native frames are walked (fp: frame pointers; dwarf: unwind tables, slower but complete; vm: HotSpot\'s own walker; no: none)'] };
const CAP_FEATURE_HELP = { vtable: 'the target class of megamorphic calls, as a frame above vtable / itable stubs', comptask: 'in a JIT compiler thread, the Java method being compiled',
  mixed: 'mixed-mode stack walking: Java and native frames interleaved', pcaddr: 'the PC address of native frames (for debugging)' };
const capOptsSummary = o => [o.interval && '-i ' + o.interval, o.alloc && '--alloc ' + o.alloc, o.lock && '--lock ' + o.lock, o.cstack && '--cstack ' + o.cstack,
  o.features?.length && '-F ' + o.features.join(',')].filter(Boolean).join(' ');
let capPanel = null;  // the mode whose settings are open, or null

async function loadCaptures(jvmId, force) {
  const c = capLists[jvmId];
  if (!force && c && Date.now() - c.t < (c.rows.some(r => r.status === 'running') ? 2000 : 15000)) return c.rows;
  const before = new Set((c?.rows || []).filter(r => r.status === 'running').map(r => r.id));
  try { capLists[jvmId] = { t: Date.now(), rows: await api(`/api/captures?jvm=${jvmId}`) }; } catch (e) { capLists[jvmId] = { t: Date.now(), rows: [] }; }
  // a capture that finishes while you're looking opens by itself; #cap=<id> opens one from a link
  const want = +hashState().cap || capLists[jvmId].rows.find(r => before.has(r.id) && r.status === 'done')?.id;
  const r = want && capLists[jvmId].rows.find(r => r.id === want && r.status === 'done');
  if (r && !prof['cap' + r.id]?.shown) showCapture(jvmId, r.id, Object.keys(r.kinds || {})[0] || 'cpu');
  if (boxId === jvmId) renderCaptures(jvmId);
  return capLists[jvmId].rows;
}

async function startCapture(jvmId, mode) {
  const label = CAP_MODES.find(m => m[0] === mode)[1], opts = capOpts(), sum = capOptsSummary(opts);
  if (!confirm(`Capture ${capSecs()} s of ${label} with async-profiler${sum ? ` (${sum})` : ''}?\n\nThis loads async-profiler's native agent into the JVM. Once loaded it stays (an agent can't be unloaded), idle between captures.`)) return;
  capPanel = null;
  try { await post('/api/jvm/capture', { id: jvmId, mode, seconds: capSecs(), opts }); }
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
  const sum = capOptsSummary(capOpts());
  patch(el, `<div class="profh"><b>Captures</b><span class="sub">async-profiler, one JVM, a bounded window</span>
      ${CAP_MODES.map(([m, l]) => `<span class="split ${capPanel === m ? 'open' : ''}"><button class="btn-link" ${running ? 'disabled' : ''} onclick="startCapture(${jvmId}, '${m}')" title="capture ${capSecs()} s${sum ? ' with ' + esc(sum) : ''}">● ${l}</button><button class="btn-link caret" ${running ? 'disabled' : ''} title="capture with settings…" onclick="capPanel=capPanel==='${m}'?null:'${m}';renderCaptures(${jvmId})">▾</button></span>`).join('')}
      <select class="recscope" onchange="capSeconds=+this.value;localStore('capSeconds', this.value);renderCaptures(${jvmId})">${[10, 30, 60, 120].map(s => `<option value="${s}" ${s === capSecs() ? 'selected' : ''}>${s} s</option>`).join('')}</select>
      ${sum ? `<a href="#" class="sub capsum" title="settings for every capture: click to change" onclick="capPanel=capPanel||'cpu';renderCaptures(${jvmId});return false">⚙ ${esc(sum)}</a>` : ''}
      ${running ? `<span class="sub">capturing… ${clock(Math.max(0, running.started + running.seconds - Date.now() / 1000))} left</span>` : ''}</div>
    ${capPanel && !running ? capSettings(jvmId, capPanel) : ''}
    ${rows.length ? `<table class="jt caps"><tr><th>when</th><th>what</th><th>status</th><th>show</th><th></th></tr>${rows.map(r => capRow(r, rows, p)).join('')}</table>` : ''}
    ${p ? `<div class="profc"><div class="fg" id="fg-${open}"></div></div>` : ''}`);
  if (p) drawFlame(open);
}

function capSettings(jvmId, mode) {
  const co = S.capture_options || { options: {}, features: [] }, o = capOpts(), label = CAP_MODES.find(m => m[0] === mode)[1];
  const sel = k => `<label title="${esc(CAP_OPT_LABELS[k][1])}"><span>${CAP_OPT_LABELS[k][0]}</span><select class="recscope" onchange="setCapOpt('${k}', this.value)">
      <option value="">default</option>${(co.options[k] || []).map(v => `<option ${o[k] === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>`;
  return `<div class="capset"><div class="capgrid">${Object.keys(CAP_OPT_LABELS).filter(k => co.options[k]).map(sel).join('')}
      <label title="-j: the deepest Java stack recorded"><span>stack depth</span>${depthSelect('capture_depth', [256, 1024, 2048, 4096, 8192, 16384], 'Maximum Java stack depth async-profiler records (-j)')}</label></div>
    <div class="capfeat"><span>features (-F)</span>${co.features.map(f => `<label class="chk" title="${esc(CAP_FEATURE_HELP[f] || '')}"><input type="checkbox" ${o.features?.includes(f) ? 'checked' : ''} onchange="toggleCapFeature('${f}', this.checked)"> ${f}</label>`).join('')}</div>
    <div class="capgo"><button class="recbtn" onclick="startCapture(${jvmId}, '${mode}')"><i></i>Capture ${capSecs()} s of ${esc(label)}</button>
      <span class="sub">${esc(capOptsSummary(o) || 'async-profiler\'s defaults')} · kept for later captures</span>
      ${Object.keys(o).length ? `<button class="btn-link" onclick="capOptsV={};localStore('capOpts','{}');renderCaptures(${jvmId})">reset</button>` : ''}
      <button class="btn-link" onclick="capPanel=null;renderCaptures(${jvmId})">close</button></div></div>`;
}

function capRow(r, rows, p) {
  const key = 'cap' + r.id, shown = p && p.cap === r.id;
  const kinds = Object.keys(r.kinds || {});
  const others = rows.filter(o => o.id !== r.id && o.status === 'done');
  const st = r.status === 'running' ? '<span class="sub">running…</span>' : r.status === 'failed' ? `<span class="err" title="${esc(r.error || '')}">failed: ${esc((r.error || '').slice(0, 80))}</span>` : `<span class="sub">${mb(r.bytes || 0)}</span>`;
  return `<tr class="${shown ? 'open' : ''}"><td class="sub">${new Date(r.started * 1000).toLocaleTimeString()}</td><td>${esc(r.mode_label)} <span class="sub">${r.seconds} s${capOptsSummary(r.opts || {}) ? ' · ' + esc(capOptsSummary(r.opts)) : ''}</span></td><td>${st}</td>
    <td>${kinds.map(k => `<button class="btn-link ${shown && p.kind === k ? 'on' : ''}" onclick="showCapture(${r.jvm_id}, ${r.id}, '${k}')">${esc(KIND_LABEL[k] || k)}</button>`).join(' ')}
      ${shown && others.length ? `<select class="recscope" title="compare with an earlier or later capture" onchange="setCapBase(${r.id}, this.value)"><option value="">diff against…</option>${others.map(o => `<option value="${o.id}" ${p.base === o.id ? 'selected' : ''}>${new Date(o.started * 1000).toLocaleTimeString()} ${esc(o.mode)}</option>`).join('')}</select>` : ''}</td>
    <td style="white-space:nowrap">${r.status === 'done' ? `<a class="sub" href="/api/capture/html?id=${r.id}&kind=${shown ? p.kind : kinds[0] || 'cpu'}${shown && p.frames ? '&frames=' + p.frames : ''}" target="_blank" title="async-profiler's own flame graph (jfrconv)">↗ async-profiler</a> · <a class="sub" href="/api/capture/file?id=${r.id}" title="the .jfr, for JMC or jfrconv">⤓ .jfr</a>` : ''}</td></tr>`;
}

function showCapture(jvmId, cid, kind) {
  for (const k of Object.keys(prof)) if (k.startsWith('cap')) prof[k].shown = false;
  setHash({ cap: cid });
  const key = 'cap' + cid;
  prof[key] = Object.assign(prof[key] || { zoom: [] }, { jvm: jvmId, cap: cid, kind, shown: true, zoom: [], load: quiet => loadCapFlame(key, quiet) });
  renderCaptures(jvmId);
  loadCapFlame(key);
}
function setCapBase(cid, base) { const p = prof['cap' + cid]; p.base = base ? +base : null; p.zoom = []; loadCapFlame('cap' + cid); }
async function loadCapFlame(key, quiet) {
  const p = prof[key];
  if (!quiet) Flame.busy(key, true);
  try { p.flame = await api(`/api/capture/flame?id=${p.cap}&kind=${p.kind}&reverse=${p.reverse ? 1 : 0}${p.base ? '&base=' + p.base : ''}&frames=${p.frames || ''}&classes=${p.classes ? 1 : 0}${zq(p)}`); p.error = null; }
  catch (e) { p.error = String(e.message || e); p.flame = null; Flame.busy(key, false); }
  renderCaptures(p.jvm);
}
