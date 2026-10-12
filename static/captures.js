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
  const r = want && capLists[jvmId].rows.find(r => r.id === want && r.status !== 'failed');
  if (r && !prof['cap' + r.id]?.shown) showCapture(jvmId, r.id, Object.keys(r.kinds || {})[0] || (r.mode === 'cpu' ? 'cpu' : 'wall'));
  // the one shown: again every few seconds while it runs, and once more when it ends
  for (const row of capLists[jvmId].rows) {
    const p = prof['cap' + row.id];
    if (p?.shown && (row.status === 'running' ? Date.now() - (p.fetched || 0) > 5000 : before.has(row.id))) p.load(true);
  }
  if (boxId === jvmId) renderCaptures(jvmId);
  return capLists[jvmId].rows;
}

// Without DebugNonSafepoints, code JIT-compiled before async-profiler attaches only maps back to source at safepoints,
// so its samples land on the nearest safepoint's method and line: inlined callees and hot loops come out skewed.
const NONSAFEPOINT_WARN = 'This JVM wasn\'t started with -XX:+UnlockDiagnosticVMOptions -XX:+DebugNonSafepoints. Code compiled before async-profiler attaches has debug info only at safepoints, so its samples are attributed to the nearest one: time can land on the wrong method (inlined callees fold into callers) or line.';
const nonsafepointWarned = jvmId => (S.jvms || []).find(j => j.id === jvmId)?.debug_nonsafepoints === false;

async function startCapture(jvmId, mode) {
  let started;
  const label = CAP_MODES.find(m => m[0] === mode)[1], opts = capOpts(), sum = capOptsSummary(opts);
  if (!confirm(`Capture ${capSecs()} s of ${label} with async-profiler${sum ? ` (${sum})` : ''}?\n\nThis loads async-profiler's native agent into the JVM. Once loaded it stays (an agent can't be unloaded), idle between captures.` +
    (nonsafepointWarned(jvmId) ? `\n\n⚠ ${NONSAFEPOINT_WARN}` : ''))) return;
  capPanel = null;
  try { started = await post('/api/jvm/capture', { id: jvmId, mode, seconds: capSecs(), opts }); }
  catch (e) { alert('Capture failed to start: ' + (e.message || e)); }
  await loadCaptures(jvmId, true);
  if (started?.id) showCapture(jvmId, started.id, mode === 'cpu' ? 'cpu' : 'wall');  // shown from the start: it fills in as it runs
}

async function stopCapture(jvmId, cid, btn) {
  if (btn) { btn.disabled = true; btn.lastChild.textContent = 'Stopping…'; }
  try { await post('/api/capture/stop', { id: cid }); } catch (e) { alert('Stop failed: ' + (e.message || e)); }
  loadCaptures(jvmId, true);
}

function renderCaptures(jvmId) {
  const el = document.querySelector('#jvmbox .jbox-cap'); if (!el) return;
  if (DEMO) { patch(el, ''); return; }
  if (!S.asprof) { patch(el, `<div class="profh"><b>Captures</b><span class="sub">Install async-profiler (<code>brew install async-profiler</code>) for wall-clock, native-memory and allocation captures.</span></div>`); return; }
  const rows = capLists[jvmId]?.rows || [], running = rows.find(r => r.status === 'running');
  if (!(S.jvms || []).some(j => j.id === jvmId)) {  // exited: its captures, nothing new
    const open = Object.keys(prof).find(k => k.startsWith('cap') && prof[k].jvm === jvmId && prof[k].shown), p = open && prof[open];
    patch(el, `<div class="profh"><b>Captures</b><span class="sub">${rows.length ? 'taken while this JVM ran' : 'none taken while this JVM ran'}</span></div>
      ${rows.length ? `<table class="jt caps"><tr><th>when</th><th>what</th><th>status</th><th>show</th><th></th></tr>${rows.map(r => capRow(r, rows, p)).join('')}</table>` : ''}
      ${p ? capView(open, p, rows.find(r => r.id === p.cap)) : ''}`);
    if (p) drawProfile(open);
    return;
  }
  const open = Object.keys(prof).find(k => k.startsWith('cap') && prof[k].jvm === jvmId && prof[k].shown);
  const p = open && prof[open];
  const sum = capOptsSummary(capOpts());
  patch(el, `<div class="profh"><b>Captures</b><span class="sub">async-profiler, one JVM, a bounded window</span>
      ${CAP_MODES.map(([m, l]) => `<span class="split ${capPanel === m ? 'open' : ''}"><button class="btn-link" ${running ? 'disabled' : ''} onclick="startCapture(${jvmId}, '${m}')" title="capture ${capSecs()} s${sum ? ' with ' + esc(sum) : ''}">● ${l}</button><button class="btn-link caret" ${running ? 'disabled' : ''} title="capture with settings…" onclick="capPanel=capPanel==='${m}'?null:'${m}';renderCaptures(${jvmId})">▾</button></span>`).join('')}
      <select class="recscope" onchange="capSeconds=+this.value;localStore('capSeconds', this.value);renderCaptures(${jvmId})">${[10, 30, 60, 120].map(s => `<option value="${s}" ${s === capSecs() ? 'selected' : ''}>${s} s</option>`).join('')}</select>
      ${sum ? `<a href="#" class="sub capsum" title="settings for every capture: click to change" onclick="capPanel=capPanel||'cpu';renderCaptures(${jvmId});return false">⚙ ${esc(sum)}</a>` : ''}
      ${running ? `<span class="sub">capturing… ${clock(Math.max(0, running.started + running.seconds - Date.now() / 1000))} left</span>
        <button class="recbtn sm on" title="stop now and keep what's been captured" onclick="stopCapture(${jvmId}, ${running.id}, this)"><i></i>Stop</button>` : ''}</div>
    ${nonsafepointWarned(jvmId) ? `<div class="capwarn sub" title="${esc(NONSAFEPOINT_WARN)}">⚠ started without <code>-XX:+UnlockDiagnosticVMOptions -XX:+DebugNonSafepoints</code>: samples in code compiled before the capture attaches can land on the wrong method or line</div>` : ''}
    ${capPanel && !running ? capSettings(jvmId, capPanel) : ''}
    ${rows.length ? `<table class="jt caps"><tr><th>when</th><th>what</th><th>status</th><th>show</th><th></th></tr>${rows.map(r => capRow(r, rows, p)).join('')}</table>` : ''}
    ${p ? capView(open, p, rows.find(r => r.id === p.cap)) : ''}`);
  if (p) drawProfile(open);
}

// A capture shown like a JVM's profile: heatmap, thread lanes and GC pauses over its window (JFR filling in what
// async-profiler doesn't have: thread CPU load, GC, and any kind the capture lacks), a switch over every kind either
// has, brushing and thread filters, and the flame graph. It grows every few seconds while the capture runs.
function capView(key, p, row) {
  const kinds = Object.keys(row?.kinds || {});
  if (!kinds.includes(p.kind)) kinds.unshift(p.kind);
  const fold = (id, title, sub, canvas) => `<div class="${foldClass(id)}" id="${id}"><div class="profh sm"><b>${title}</b>${sub ? `<span class="sub">${sub}</span>` : ''}</div><canvas id="${canvas}"></canvas></div>`;
  return `<div class="profh capview"><b>${esc(row?.mode_label || 'Capture')}</b>
      <span class="sub">${row ? new Date(row.started * 1000).toLocaleTimeString() : ''}${row?.status === 'running' ? ' · running: grows every 5 s' : ''}</span>
      <span class="seg" title="a kind async-profiler captured comes from the capture; any other from JFR's recording of the same window">${kinds.map(k => `<button class="${p.kind === k ? 'on' : ''}" onclick="setProf('${key}', {kind:'${k}', zpath: []})">${esc(KIND_LABEL[k] || k)}</button>`).join('')}</span>
      <span class="sub" id="profstat-${key}"></span></div>
    <div class="profc">${fold('cheat', 'Heatmap', '', `heat-${key}`)}${fold('clanes', 'Thread lanes', 'CPU load from JFR · click a name to show only that thread or group below', `lanes-${key}`)}
      <div class="fg" id="fg-${key}"></div></div>`;
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
    <td style="white-space:nowrap">${r.status === 'done' ? `<span class="sub">↗ async-profiler:</span> ${[[0, 'top-down'], [1, 'reversed']].map(([rv, l]) => `<a class="sub" href="/api/capture/html?id=${r.id}&kind=${shown ? p.kind : kinds[0] || 'cpu'}${shown && p.frames ? '&frames=' + p.frames : ''}${rv ? '&reverse=1' : ''}" target="_blank" title="async-profiler's own flame graph (jfrconv${rv ? ' --reverse' : ''})">${l}</a>`).join(' ')} · <a class="sub" href="/api/capture/file?id=${r.id}" title="the .jfr, for JMC or jfrconv">⤓ .jfr</a>` : ''}</td></tr>`;
}

function showCapture(jvmId, cid, kind) {
  for (const k of Object.keys(prof)) if (k.startsWith('cap')) prof[k].shown = false;
  setHash({ cap: cid });
  const key = 'cap' + cid;
  prof[key] = Object.assign(prof[key] || { zoom: [] }, { jvm: jvmId, cap: cid, kind, shown: true, zoom: [], load: quiet => loadCapFlame(key, quiet) });
  renderCaptures(jvmId);
  loadCapFlame(key);
}
// CPU and wall clock: what kind of work each sample is (GC, JIT, VM, class loading, interpreted or compiled Java), as
// async-profiler's jfrconv --classify puts it, as the first level either way up. On unless turned off; not in a diff.
const capCategories = p => (p.kind === 'cpu' || p.kind === 'wall') && p.categories !== false && !p.base;
function setCapBase(cid, base) { const p = prof['cap' + cid]; p.base = base ? +base : null; p.zoom = []; loadCapFlame('cap' + cid); }
async function loadCapFlame(key, quiet) {
  const p = prof[key];
  if (p.busy) { p.again = true; return; }
  p.busy = true;
  if (!quiet) Flame.busy(key, true);
  const range = p.sel ? `&t0=${p.sel[0]}&t1=${p.sel[1]}` : '', thread = `&threads=${p.thread?.tid ?? ''}&group=${encodeURIComponent(p.thread?.group ?? '')}`;
  try {
    [p.summary, p.flame] = await Promise.all([api(`/api/capture/summary?id=${p.cap}&bins=150`),
      api(`/api/capture/flame?id=${p.cap}&kind=${p.kind}&reverse=${p.reverse ? 1 : 0}${p.base ? '&base=' + p.base : ''}&frames=${p.frames || ''}&classes=${showClasses(p) ? 1 : 0}&categories=${capCategories(p) ? 1 : 0}${range}${thread}${zq(p)}`)]);
    p.error = null;
  } catch (e) {
    const running = capLists[p.jvm]?.rows.find(r => r.id === p.cap)?.status === 'running';
    p.error = running ? 'starting: the first chunk lands within a few seconds' : String(e.message || e);
    Flame.busy(key, false);
  }
  p.busy = false; p.fetched = Date.now();
  renderCaptures(p.jvm);
  if (p.again) { p.again = false; loadCapFlame(key, true); }
}

// ---------------------------------------------------------------- every JVM's captures, on the main page
// Captures outlive their JVM (30 days, like the jvm table): this is how to find one whose JVM has exited.
let allCaps = { t: 0, rows: [] };
async function loadAllCaps() {
  if (Date.now() - allCaps.t < 15000 || allCaps.busy || folded('jvmcaps')) return;
  allCaps.busy = true;
  try { allCaps = { t: Date.now(), rows: await api('/api/captures') }; } catch (e) { allCaps = { t: Date.now(), rows: allCaps.rows }; }
  renderCapsPanel();
}
function openCapture(jvmId, cid) { setHash({ cap: cid }); openJvmBox(jvmId); }
function renderCapsPanel() {
  const el = $('#jvmcaps'); if (!el) return;
  if (DEMO || !S.asprof) { el.hidden = true; return; }
  loadAllCaps();
  const rows = allCaps.rows.filter(r => r.status !== 'failed');
  el.hidden = !rows.length;
  if (!rows.length) return;
  const alive = new Set((S.jvms || []).map(j => j.id));
  patch(el, `<div class="profh"><b>Captures</b><span class="sub">async-profiler captures of every JVM, the last 30 days · click one to open it</span></div>
    <div class="panel"><table class="jt caps">${rows.map(r => {
      const s = r.sid && S.sMap[r.sid], when = new Date(r.started * 1000);
      return `<tr class="jr" onclick="openCapture(${r.jvm_id}, ${r.id})"><td class="sub">${when.toLocaleDateString([], { weekday: 'short' })} ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
        <td><b>${esc(r.jvm_label || 'JVM')}</b> <span class="sub">${r.pid}</span> ${alive.has(r.jvm_id) ? '' : '<span class="jflag gone">exited</span>'}</td>
        <td class="who">${s ? `<span class="lane-chip">${esc(s.lane)}</span> ${esc(s.title)}` : '<span class="dim">no session</span>'}</td>
        <td>${esc(r.mode_label)} <span class="sub">${r.seconds} s${capOptsSummary(r.opts || {}) ? ' · ' + esc(capOptsSummary(r.opts)) : ''}</span></td>
        <td class="sub">${r.status === 'running' ? 'running…' : Object.keys(r.kinds || {}).map(k => esc(KIND_LABEL[k] || k)).join(', ')}</td>
        <td class="num sub">${r.bytes ? mb(r.bytes) : ''}</td></tr>`;
    }).join('')}</table></div>`);
}
