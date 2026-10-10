// Continuous profiling (tier 1 of docs/jvm-profiler.md): the Record button, and the profile in a JVM's full view —
// a sub-second heatmap and per-thread lanes over time, brushed to pick a range, and a flame graph of that range.
// Uses the page's globals (S, $, esc, api, tip, hideTip, cores, mb, DEMO) and jvm.js's (boxId, threadGroup, renderJvmBox).

// ---------------------------------------------------------------- Record button (header)
const recState = () => S?.record || { on: false, scope: 'agents', jvms: {} };
const recLive = () => Object.values(recState().jvms).filter(r => r.live).length;
const clock = sec => { sec = Math.max(0, Math.floor(sec)); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0'); };

function renderRecord() {
  const el = $('#rec'); if (!el) return;
  if (DEMO || !S.record) { el.hidden = true; return; }
  const r = recState(), why = S.jvm_helper;
  patch(el, `<button class="recbtn ${r.on ? 'on' : ''}" ${why ? 'disabled' : ''} onclick="toggleRecord()" title="${esc(why || (r.on ? 'Stop recording' :
      'Record every JVM in scope with a low-overhead JFR recording (≲1%): thread lanes, heatmap and flame graphs in each JVM\'s full view'))}">
      <i></i><span id="rec-label">${r.on ? recLabel() : 'Record'}</span></button>
    <select class="recscope" title="which JVMs to record" onchange="setRecord(${r.on}, this.value)">
      <option value="agents" ${r.scope === 'agents' ? 'selected' : ''}>agent JVMs</option><option value="all" ${r.scope === 'all' ? 'selected' : ''}>all JVMs</option></select>`);
}
function recLabel() { const r = recState(); return `Recording ${clock(Date.now() / 1000 - (r.since || Date.now() / 1000))} · ${recLive()} JVM${recLive() === 1 ? '' : 's'}`; }
setInterval(() => { const l = document.getElementById('rec-label'); if (l && recState().on) l.textContent = recLabel(); }, 1000);
async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}
async function setRecord(on, scope) { S.record = await post('/api/record', { on, scope }); renderRecord(); refresh(); }
function toggleRecord() { setRecord(!recState().on, recState().scope); }
function depthSelect(key, options, title) {
  const v = S.record?.settings?.[key];
  if (DEMO || !v) return '';
  return `<select class="recscope" title="${esc(title)}" onchange="setSetting('${key}', +this.value)">${options.map(o => `<option value="${o}" ${o === v ? 'selected' : ''}>${o} frames</option>`).join('')}</select>`;
}
async function setSetting(key, value) { S.record.settings = await post('/api/settings', { [key]: value }); refresh(); }
async function setJvmRecord(id, on) { S.record = await post('/api/jvm/record', { id, on }); refresh(); }

// The dot on a JVM row
function recDot(j) {
  const r = recState().jvms[j.id];
  if (r?.live) return '<span class="recdot" title="recording"></span>';
  if (r?.error) return `<span class="sub" title="${esc(r.error)}">⚠ rec</span>`;
  return '';
}

// ---------------------------------------------------------------- profile in the full view
const PKINDS = [['cpu', 'CPU'], ['native', 'native'], ['alloc', 'allocation'], ['lock', 'locks'], ['park', 'parked']];
const KIND_LABEL = { cpu: 'CPU', native: 'native', alloc: 'allocation', lock: 'locks', park: 'parked', wall: 'wall clock', live: 'live objects', nativemem: 'native memory', nativelock: 'native locks' };
const prof = {};  // jvm id -> {summary, flame, sel, kind, window, thread, zoom, reverse, busy}
const LABEL_W = 210, ROW_H = 13, HEAT_H = 80, FLAME_ROW = 17;

function profileSection(j) {
  const r = recState().jvms[j.id], p = prof[j.id] ||= { kind: 'cpu', window: 300, zoom: [] };
  const recording = r?.live, has = r && (r.live || r.since);
  const toggle = DEMO ? '' : `<button class="btn-link" onclick="setJvmRecord(${j.id}, ${!recording})" ${S.jvm_helper ? 'disabled' : ''}>${recording ? '■ Stop recording this JVM' : '● Record this JVM'}</button>`;
  if (!has) return `<div class="profh"><b>Profile</b>${toggle}<span class="sub">${r?.error ? '⚠ ' + esc(r.error) : 'Not recorded. Press Record in the header, or record just this JVM.'}</span></div>`;
  return `<div class="profh"><b>Profile</b>${recording ? '<span class="recdot"></span>' : '<span class="sub">stopped</span>'}${toggle}
      <span class="seg">${PKINDS.map(([k, l]) => `<button class="${p.kind === k ? 'on' : ''}" onclick="setProf(${j.id}, {kind:'${k}', zoom: []})">${l}</button>`).join('')}</span>
      <span class="seg">${[[300, '5 min'], [1800, '30 min']].map(([w, l]) => `<button class="${p.window === w ? 'on' : ''}" onclick="setProf(${j.id}, {window:${w}, sel:null})">${l}</button>`).join('')}</span>
      ${depthSelect('record_depth', [64, 128, 256, 512, 1024, 2048], 'Stack depth for new recordings. JFR takes it only in a JVM where JFR hasn\'t started yet; deeper stacks cost a little more per sample.')}
      ${r.stack_depth ? `<span class="sub" title="the depth this recording actually has">depth ${r.stack_depth}${r.stack_depth < S.record.settings.record_depth ? ' (JFR was already running in this JVM)' : ''}</span>` : ''}
      <span class="sub" id="profstat-${j.id}"></span></div>
    <div class="profc"><canvas id="heat-${j.id}"></canvas><canvas id="lanes-${j.id}"></canvas>
      <div class="flameh" id="flameh-${j.id}"></div><div class="flamewrap"><canvas id="flame-${j.id}"></canvas></div></div>`;
}
const qid = id => typeof id === 'string' ? `'${id}'` : id;
function setProf(id, patch_) {
  Object.assign(prof[id], patch_);
  if (prof[id].load) prof[id].load();  // a capture's flame graph
  else if (id === 'all') { renderAllFlame(); loadAllFlame(true); } else { renderJvmBox(); loadProfile(id, true); }
}

// Called on every render of the full view: refetch at most every few seconds, flame when the question changed.
async function loadProfile(id, force) {
  const p = prof[id], r = recState().jvms[id];
  if (!p || !r || p.busy) { drawProfile(id); return; }
  if (!force && p.fetched && Date.now() - p.fetched < 4000) { drawProfile(id); return; }
  p.busy = true;
  try {
    const since = Date.now() / 1000 - p.window;
    p.summary = await api(`/api/jvm/summary?id=${id}&since=${since}&bins=${Math.min(300, p.window)}`);
    const [t0, t1] = p.sel || [since, Date.now() / 1000 + 5];
    p.flame = await api(`/api/jvm/flame?id=${id}&t0=${t0}&t1=${t1}&kind=${p.kind}&threads=${p.thread ? p.thread.tid : ''}&reverse=${p.reverse ? 1 : 0}`);
    p.error = null;
  } catch (e) { p.error = String(e.message || e); }
  p.busy = false; p.fetched = Date.now();
  drawProfile(id);
}

function canvasFor(id, prefix, h) {
  const c = document.getElementById(`${prefix}-${id}`); if (!c) return null;
  // CSS gives the canvas its width (100% of the content box, padding excluded); the backing store follows it
  c.style.height = h + 'px';
  const w = c.clientWidth, dpr = window.devicePixelRatio || 1;
  if (!w) return null;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  g.font = '11px ' + css('--font-ui'); g.textBaseline = 'middle';
  return [c, g, w];
}

function drawProfile(id) {
  const p = prof[id], s = p?.summary, stat = document.getElementById(`profstat-${id}`);
  if (!s) { if (stat) stat.textContent = p?.error || 'loading…'; return; }
  const gcMs = s.gc.reduce((a, x) => a + x[1], 0) / 1000;  // pauses come in µs
  if (stat) stat.textContent = p.error ? '⚠ ' + p.error : `${s.threads.length} active threads · ${s.gc.length} GCs, ${gcMs >= 1000 ? (gcMs / 1000).toFixed(1) + ' s' : gcMs.toFixed(gcMs < 10 ? 1 : 0) + ' ms'} paused${p.sel ? ' · selection ' + clock(p.sel[1] - p.sel[0]) : ' · drag across the heatmap or lanes to pick a range'}`;
  const ink = css('--ink'), muted = css('--muted'), grid = css('--grid'), accent = css('--accent');
  const nb = s.bins, x0 = LABEL_W, xOf = (w, t) => x0 + (t - s.since) / (nb * s.bin) * (w - x0);
  const selRect = (g, w, h) => {
    if (!p.sel) return;
    const a = xOf(w, p.sel[0] * 1000), b = xOf(w, p.sel[1] * 1000);
    g.fillStyle = accent + '2e'; g.fillRect(a, 0, Math.max(2, b - a), h);
    g.strokeStyle = accent; g.strokeRect(a + .5, .5, Math.max(2, b - a) - 1, h - 1);
  };
  // heatmap: bins across, 20 sub-second slots down (0 ms at the top), GC pauses as red ticks above
  let r = canvasFor(id, 'heat', HEAT_H + 14);
  if (r) {
    const [c, g, w] = r, cw = (w - x0) / nb, ch = HEAT_H / 20, mx = Math.max(1, ...s.heat.flat());
    g.fillStyle = muted; g.fillText('CPU samples, by ms within', 4, 20); g.fillText('each second (heatmap)', 4, 34);
    g.fillText(`${clock(nb * s.bin / 1000)} ago`, 4, HEAT_H + 6);
    for (let b = 0; b < nb; b++) for (let k = 0; k < 20; k++) {
      const v = s.heat[b][k]; if (!v) continue;
      g.fillStyle = heatColor(v / mx); g.fillRect(x0 + b * cw, 10 + k * ch, Math.ceil(cw), Math.ceil(ch));
    }
    // GC above the heatmap: per bin, shaded by the share of the bin spent in pauses (10% or more is solid)
    const gcBins = new Float64Array(nb);
    for (const [t, us] of s.gc) { const b = Math.floor((t - s.since) / s.bin); if (b >= 0 && b < nb) gcBins[b] += us / 1000; }
    g.fillStyle = css('--critical');
    for (let b = 0; b < nb; b++) if (gcBins[b] > 0) { g.globalAlpha = Math.min(1, 0.2 + gcBins[b] / s.bin * 8); g.fillRect(x0 + b * cw, 0, Math.ceil(cw), 7); }
    g.globalAlpha = 1;
    g.strokeStyle = grid; g.strokeRect(x0 + .5, 10.5, w - x0 - 1, HEAT_H - 1);
    selRect(g, w, HEAT_H + 14);
    brush(c, id, w, s);
  }
  // thread lanes: one row per thread, busiest first
  const threads = s.threads.slice(0, 40);
  r = canvasFor(id, 'lanes', Math.max(1, threads.length) * ROW_H + 4);
  if (r) {
    const [c, g, w] = r, cw = (w - x0) / nb;
    const cpuC = css('--s3'), natC = css('--s1'), parkC = css('--axis'), lockC = css('--critical');
    threads.forEach((t, i) => {
      const y = 2 + i * ROW_H;
      if (p.thread?.tid === t.tid) { g.fillStyle = accent + '33'; g.fillRect(0, y, w, ROW_H); }
      g.fillStyle = p.thread && p.thread.tid !== t.tid ? muted : ink;
      g.fillText(fit(g, t.name, x0 - 8), 4, y + ROW_H / 2);
      for (const [b, v] of Object.entries(t.bins)) {
        const [cpu, ns, nat, park, lock] = v, x = x0 + b * cw, binS = s.bin / 1000;
        const busy = Math.min(1, cpu || ns * 0.02 / binS);
        if (lock > 0) { g.fillStyle = lockC; g.globalAlpha = Math.min(1, .35 + lock / (s.bin) ); g.fillRect(x, y + 2, Math.ceil(cw), ROW_H - 4); }
        else if (busy > 0.01) { g.fillStyle = cpuC; g.globalAlpha = .25 + .75 * busy; g.fillRect(x, y + 2, Math.ceil(cw), ROW_H - 4); }
        else if (nat > 0 && cpu >= 0.05) { g.fillStyle = natC; g.globalAlpha = .6; g.fillRect(x, y + 2, Math.ceil(cw), ROW_H - 4); }
        // in native code but not using CPU: waiting (a file watcher, accept()), drawn like parked
        else if (park > 0 || nat > 0) { g.fillStyle = parkC; g.globalAlpha = .5; g.fillRect(x, y + ROW_H / 2 - 1, Math.ceil(cw), 2); }
        g.globalAlpha = 1;
      }
    });
    selRect(g, w, threads.length * ROW_H + 4);
    brush(c, id, w, s, i => threads[i]);
  }
  drawFlame(id);
}
const heatColor = f => `hsl(${Math.round(48 - 40 * f)}, 90%, ${Math.round(72 - 30 * f)}%)`;
function fit(g, text, w) { if (g.measureText(text).width <= w) return text; while (text.length > 3 && g.measureText(text + '…').width > w) text = text.slice(0, -1); return text + '…'; }

// Drag to select a time range; a click without a drag clears it (or, on a lane's label, filters to that thread).
function brush(c, id, w, s, laneAt) {
  const p = prof[id], tOf = x => (s.since + (x - LABEL_W) / (w - LABEL_W) * s.bins * s.bin) / 1000;
  c.onmousedown = e => {
    const r0 = c.getBoundingClientRect(), xa = e.clientX - r0.left;
    if (xa < LABEL_W) {
      if (laneAt) { const t = laneAt(Math.floor((e.clientY - r0.top - 2) / ROW_H)); if (t) setProf(id, { thread: p.thread?.tid === t.tid ? null : { tid: t.tid, name: t.name }, zoom: [] }); }
      return;
    }
    let xb = xa;
    const move = ev => { xb = ev.clientX - r0.left; p.sel = [tOf(Math.min(xa, xb)), tOf(Math.max(xa, xb))]; drawProfile(id); };
    const up = () => {
      removeEventListener('mousemove', move); removeEventListener('mouseup', up);
      if (Math.abs(xb - xa) < 3) p.sel = null;
      p.zoom = []; loadProfile(id, true);
    };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  };
  c.onmousemove = e => {
    const r0 = c.getBoundingClientRect(), x = e.clientX - r0.left;
    if (x < LABEL_W) { const t = laneAt?.(Math.floor((e.clientY - r0.top - 2) / ROW_H)); t ? tip(e, `<div class="tt">${esc(t.name)}</div><div class="tm">click to show only this thread in the flame graph</div>`) : hideTip(); return; }
    const t = tOf(x);
    tip(e, `<div class="tm">${new Date(t * 1000).toLocaleTimeString()}</div>`);
  };
  c.onmouseleave = hideTip;
}

// ---------------------------------------------------------------- flame graph (icicle: root on top), click to zoom
const unit = (kind, v) => kind === 'cpu' || kind === 'native' || kind === 'wall' ? `${v} samples` : kind === 'alloc' ? mb(v) + ' allocated (sampled)' :
  kind === 'live' ? mb(v) + ' live' : kind === 'nativemem' ? mb(v) + ' malloc\'d' : `${(v / 1000).toFixed(1)} s waited`;
function drawFlame(id) {
  const p = prof[id], f = p.flame, head = document.getElementById(`flameh-${id}`);
  if (!f || !head) return;
  let root = f.root;
  const path = [root[0]];
  for (const name of p.zoom) { const k = root[2].find(c => c[0] === name); if (!k) { p.zoom = []; root = f.root; break; } root = k; path.push(name); }
  patch(head, `<b>Flame graph</b>
    <span class="seg" title="Callers first (top-down), or where the time is spent first and then who called it (reversed, bottom-up)">${[[false, '↓ top-down'], [true, '↑ reversed']].map(([r, l]) => `<button class="${!!p.reverse === r ? 'on' : ''}" onclick="setProf(${qid(id)}, {reverse: ${r}, zoom: []})">${l}</button>`).join('')}</span>
    <span class="sub">${esc(KIND_LABEL[p.kind] || p.kind)} · ${String(id).startsWith('cap') ? (f.diff ? 'difference: red grew, blue shrank, against the chosen capture' : 'capture') : id === 'all' ? (p.abs ? 'selected range' : esc(ALL_RANGES.find(r => r[0] === p.range)[1])) + ', per minute, every recorded JVM' : p.sel ? 'selected range' : 'whole window'}${p.thread ? ' · thread ' + esc(p.thread.name) + ` <a href="#" onclick="setProf(${qid(id)},{thread:null,zoom:[]});return false">✕</a>` : ''} · ${f.total ? esc(unit(p.kind, f.total)) : 'no samples'}</span>
    ${p.zoom.length ? `<a href="#" class="sub" onclick="setProf(${qid(id)},{zoom:[]});return false">↺ reset zoom</a> <span class="sub">${p.zoom.map(z => esc(shortName(z))).join(' › ')}</span>` : ''}`);
  const rows = [];  // [depth, x, w, node]
  const lay = (n, d, x, w) => { rows.push([d, x, w, n]); let cx = x; for (const k of n[2]) { const kw = w * k[1] / n[1]; if (kw >= 0.0008) lay(k, d + 1, cx, kw); cx += kw; } };
  if (root[1]) lay(root, 0, 0, 1);
  const depth = rows.reduce((a, r) => Math.max(a, r[0]), 0) + 1;
  const r = canvasFor(id, 'flame', Math.max(40, depth * FLAME_ROW + 2)); if (!r) return;
  const [c, g, w] = r, dark = matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light';
  if (!root[1]) { g.fillStyle = css('--muted'); g.fillText('no samples in this range', 4, 14); return; }
  for (const [d, x, fw, n] of rows) {
    const px = x * w, pw = fw * w, y = d * FLAME_ROW;
    if (pw < 0.5) continue;
    g.fillStyle = f.diff ? diffColor(n, f, dark) : n[3] || d === 0 ? (dark ? '#8a877e' : '#d9d6cb') : frameColor(n[0], dark);  // n[3]: a label level (session, JVM, activity)
    g.fillRect(px, y, Math.max(0.5, pw - 0.5), FLAME_ROW - 1);
    if (pw > 30) { g.fillStyle = '#1b1b1a'; g.fillText(fit(g, d === 0 ? (p.zoom.length ? shortName(n[0]) : 'all') : n[3] ? n[0] : shortName(n[0]), pw - 6), px + 3, y + FLAME_ROW / 2); }
  }
  const hit = e => { const b = c.getBoundingClientRect(), x = (e.clientX - b.left) / w, d = Math.floor((e.clientY - b.top) / FLAME_ROW); return rows.find(r => r[0] === d && x >= r[1] && x < r[1] + r[2]); };
  c.onmousemove = e => {
    const h = hit(e); if (!h) return hideTip();
    const n = h[3], share = v => (v / Math.max(1, f.total) * 100).toFixed(1) + '%';
    tip(e, `<div class="tt" style="word-break:break-all">${esc(n[0])}</div><div class="tm">${esc(unit(p.kind, n[1]))} · ${share(n[1])} of all</div>` +
      (f.diff ? `<div class="tm">before: ${esc(unit(p.kind, n[4] || 0))} · ${((n[4] || 0) / Math.max(1, f.before_total) * 100).toFixed(1)}% of all</div>` : ''));
  };
  c.onmouseleave = hideTip;
  c.onclick = e => {
    const h = hit(e); if (!h || h[0] === 0) return;
    // the zoom path is the chain of names from the current root down to the clicked frame; parents precede children in rows
    const names = [], chain = [h]; let d = h[0];
    for (let k = rows.indexOf(h) - 1; k >= 0 && d > 1; k--) if (rows[k][0] === d - 1 && rows[k][1] <= h[1] + 1e-9 && rows[k][1] + rows[k][2] >= h[1] + h[2] - 1e-9) { chain.unshift(rows[k]); d--; }
    for (const x of chain) names.push(x[3][0]);
    p.zoom = p.zoom.concat(names); drawFlame(id);
  };
}
// Differential: the share of all samples a frame had after, against before. Red grew, blue shrank, grey about the same.
function diffColor(n, f, dark) {
  const a = n[1] / Math.max(1, f.total), b = (n[4] || 0) / Math.max(1, f.before_total), r = (a - b) / Math.max(a, b, 1e-9);
  const l = (dark ? 62 : 82) - 28 * Math.min(1, Math.abs(r));
  return Math.abs(r) < 0.05 ? (dark ? '#77756f' : '#d9d6cb') : r > 0 ? `hsl(4, 75%, ${l}%)` : `hsl(215, 70%, ${l}%)`;
}
const shortName = n => n.replace(/^([a-z_$][\w$]*\.)+(?=[A-Z_$][\w$]*[.$])/, m => m.split('.').filter(Boolean).map(x => x[0]).join('.') + '.');
function frameColor(name, dark) {
  let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  const v = Math.abs(h) % 20;
  // non-Java frames (JFR's [Native]; async-profiler's C++, kernel, stubs) are whatever doesn't look like package.Class.method
  if (/ \[[^\]]+\]$/.test(name) || !/^[\w$]+(\.[\w$<>]+)+$/.test(name)) return `hsl(${150 + v}, 45%, ${dark ? 62 : 70}%)`;
  if (/^(java|javax|jdk|sun|com\.sun)\./.test(name)) return `hsl(${200 + v}, 35%, ${dark ? 66 : 76}%)`;
  return `hsl(${18 + v * 1.6}, 80%, ${dark ? 62 : 66}%)`;
}

// ---------------------------------------------------------------- across JVMs: stored minutes, session → JVM → activity → frames
const ALL_RANGES = [[900, 'last 15 min'], [3600, 'last hour'], [6 * 3600, 'last 6 h'], [86400, 'last 24 h'], [7 * 86400, 'last 7 days']];
prof.all = { kind: 'cpu', range: 3600, zoom: [] };
function renderAllFlame() {
  const el = $('#jvmflame'); if (!el) return;
  const stored = S.record?.stored_since;
  if (DEMO || !stored) { patch(el, DEMO ? '' : '<div class="sub" style="padding:8px 2px">Press <b>Record</b> to see, minute by minute, where all your JVMs spend their time.</div>'); return; }
  const p = prof.all;
  patch(el, `<div class="profh"><b>Across JVMs</b><span class="sub">session → JVM → activity → frames</span>
      <span class="seg">${PKINDS.map(([k, l]) => `<button class="${p.kind === k ? 'on' : ''}" onclick="setProf('all', {kind:'${k}', zoom: []})">${l}</button>`).join('')}</span>
      <span class="seg">${ALL_RANGES.map(([r, l]) => `<button class="${!p.abs && p.range === r ? 'on' : ''}" onclick="act.sel=null;setProf('all', {range:${r}, abs:null, zoom: []})">${l.replace('last ', '')}</button>`).join('')}</span>
      ${p.abs ? `<span class="sub">selected ${new Date(p.abs[0] * 1000).toLocaleTimeString()}–${new Date(p.abs[1] * 1000).toLocaleTimeString()} <a href="#" onclick="act.sel=null;setProf('all',{abs:null,zoom:[]});return false">✕</a></span>` : ''}</div>
    <div class="profc"><div class="flameh" id="flameh-all"></div><div class="flamewrap"><canvas id="flame-all"></canvas></div></div>`);
  loadAllFlame();
}
async function loadAllFlame(force) {
  const p = prof.all;
  if (p.busy || (!force && p.fetched && Date.now() - p.fetched < 30000)) { drawFlame('all'); return; }
  p.busy = true;
  // a range brushed on the Activity lanes, or the last N; stored per minute, so widen to whole minutes
  const [t0, t1] = p.abs ? [Math.floor(p.abs[0] / 60) * 60, Math.ceil(p.abs[1] / 60) * 60] : [Date.now() / 1000 - p.range, Date.now() / 1000 + 60];
  try { p.flame = await api(`/api/jvms/flame?t0=${t0}&t1=${t1}&kind=${p.kind}&reverse=${p.reverse ? 1 : 0}`); p.error = null; }
  catch (e) { p.error = String(e.message || e); }
  p.busy = false; p.fetched = Date.now();
  drawFlame('all');
}
// What a recorded JVM is doing, from the last 30 seconds of samples
function activityLine(j, n = 3) {
  const a = recState().jvms[j.id]?.activities;
  if (!a?.length) return '';
  return a.slice(0, n).map(([name, pct, threads]) => `${esc(name)} <b>${pct}%</b>${threads > 1 ? `<span class="sub"> ×${threads}</span>` : ''}`).join(' · ');
}

// Canvases are drawn at their current width: redraw when it changes
let _resizeT;
addEventListener('resize', () => { clearTimeout(_resizeT); _resizeT = setTimeout(() => { for (const id of Object.keys(prof)) (id === 'all' || id.startsWith('cap') ? drawFlame(id) : drawProfile(+id)); renderActivity(); }, 100); });
