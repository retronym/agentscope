// JVMs (tier 0 of docs/jvm-profiler.md): every JVM of yours, read from hsperfdata by the server. No attach.
// Uses the page's globals: S, $, esc, patch, api, gb, cores, ago, matches, chips, query, openDrawer, tip, hideTip.

const JVM_FLAGS = {
  gc: ['GC', 'bad', 'over a fifth of wall time in GC pauses for the last minute'],
  heap: ['heap', 'bad', 'heap stays at 85%+ of its max even right after collections'],
  full: ['full GC', 'warn', 'a full (stop-the-world, whole-heap) collection in the last 5 minutes'],
};
const openJvms = new Set();
const jvmHistCache = {};  // id -> {key, rows}

const mb = b => b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.round(b / 1e6) + ' MB';
const pct = v => v == null ? '–' : v < 1 && v > 0 ? '<1%' : Math.round(v) + '%';
const rate = b => b == null ? '–' : b < 1e6 ? '<1 MB/s' : b < 1e9 ? Math.round(b / 1e6) + ' MB/s' : (b / 1e9).toFixed(1) + ' GB/s';
const uptime = t => { const d = S.now - t; return d < 3600 ? Math.round(d / 60) + 'm' : d < 86400 ? (d / 3600).toFixed(d < 36000 ? 1 : 0) + 'h' : (d / 86400).toFixed(1) + 'd'; };

function jvmVisible(j) {
  const s = j.sid && S.sMap[j.sid];
  if (s) return matches(s) || (s.archived && !query && !chips.size);
  return !query && !chips.size;  // JVMs no session owns only show unfiltered
}
function jvmTier(j) { return j.cpu >= 200 ? 3 : j.cpu >= 50 ? 2 : j.cpu >= 5 ? 1 : 0; }
function jvmSorted(list) {
  return [...list].sort((a, b) => (b.flags.length > 0) - (a.flags.length > 0) || jvmTier(b) - jvmTier(a) || (!!b.sid - !!a.sid) || a.label.localeCompare(b.label) || a.pid - b.pid);
}

function heapBar(j, w = 90) {
  const max = j.heap_max || j.heap_committed || 1, r = j.heap_used / max;
  return `<span class="hb ${r >= .9 ? 'bad' : r >= .75 ? 'warn' : ''}" style="width:${w}px" title="used ${mb(j.heap_used)} · committed ${mb(j.heap_committed)} · max ${mb(j.heap_max)}">` +
    `<i class="c" style="width:${Math.min(100, j.heap_committed / max * 100).toFixed(1)}%"></i><i class="u" style="width:${Math.min(100, r * 100).toFixed(1)}%"></i></span>`;
}
function jvmFlags(j) {
  return j.flags.map(f => `<span class="jflag ${JVM_FLAGS[f][1]}" title="${esc(JVM_FLAGS[f][2])}">⚠ ${JVM_FLAGS[f][0]}</span>`).join('');
}
function jvmSpark(j, i, color, W = 64, H = 16, floor = 0) {
  const pts = j.spark; if (!pts || pts.length < 2) return '';
  const mx = Math.max(floor, ...pts.map(p => p[i])) || 1;
  return `<svg width="${W}" height="${H}" style="vertical-align:middle"><polyline points="${pts.map((p, k) => `${(k / (pts.length - 1) * W).toFixed(1)},${(H - 1 - p[i] / mx * (H - 2)).toFixed(1)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="1.3"/></svg>`;
}

function jvmRows(list, withSession) {
  return list.map(j => {
    const s = j.sid && S.sMap[j.sid], open = openJvms.has(j.id);
    const who = withSession ? `<td class="who">${s ? `<a href="#" onclick="event.stopPropagation();openDrawer('${s.sid}');return false" style="text-decoration:none"><span class="lane-chip">${esc(s.lane)}</span> ${esc(s.title)}</a>${j.how && j.how !== 'tree' ? ` <span class="sub" title="attributed by ${esc(j.how)}">⌁</span>` : ''}` : '<span class="dim">no session</span>'}</td>` : '';
    return `<tr class="jr ${open ? 'open' : ''}" onclick="toggleJvm(${j.id})" title="${esc(j.main || '')}">
      <td><b>${esc(j.label)}</b> <span class="sub">${j.pid}</span><div class="sub">${esc(j.version.split('+')[0])} · ${esc(j.gc || '?')}</div></td>${who}
      <td class="num">${uptime(j.start)}</td>
      <td class="num">${cores(j.cpu)} ${jvmSpark(j, 1, 'var(--s1)', 56, 16, 100)}</td>
      <td>${heapBar(j)} <span class="sub">${mb(j.heap_used)} / ${mb(j.heap_max)}</span></td>
      <td class="num">${pct(j.gc_pct)}</td>
      <td class="num">${rate(j.alloc)}</td>
      <td class="num">${j.threads}</td>
      <td class="num">${(j.classes / 1000).toFixed(0)}k</td>
      <td>${jvmFlags(j)}</td></tr>` + (open ? `<tr class="jd"><td colspan="${withSession ? 10 : 9}">${jvmDetail(j)}</td></tr>` : '');
  }).join('');
}
function jvmTable(list, withSession) {
  return `<table class="jt"><tr><th>JVM</th>${withSession ? '<th>session</th>' : ''}<th class="num">up</th><th class="num">CPU (cores)</th><th>heap used / max</th><th class="num" title="share of wall time in GC pauses">GC</th><th class="num" title="estimated from eden turnover">alloc ≈</th><th class="num">threads</th><th class="num">classes</th><th></th></tr>${jvmRows(list, withSession)}</table>`;
}

function jvmDetail(j) {
  const gens = j.gens.map(g => `<span>${esc(g.name)}</span><span>${mb(g.used)} <span class="dim">of ${mb(g.cap)}</span></span>`).join('');
  const h = jvmHistCache[j.id];
  return `<div class="jdet"><div><div class="kv">
      <span>pid</span><span>${j.pid} · up since ${new Date(j.start * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span>
      <span>JVM</span><span>${esc(j.version)} ${esc(j.vendor || '')}</span>
      <span>collector</span><span>${esc(j.gc || '?')} · ${j.young_gcs} young, ${j.full_gcs} full</span>
      ${gens}<span>metaspace</span><span>${mb(j.meta_used)}</span>
      <span>safepoints</span><span>${pct(j.sp_pct)} of wall</span>
      <span>JIT</span><span>${pct(j.jit_pct)} of a core</span>
      <span>threads</span><span>${j.threads} (${j.daemon} daemon)</span>
      </div>${j.flags.length ? `<div style="margin-top:6px">${j.flags.map(f => `<div class="sub">⚠ ${esc(JVM_FLAGS[f][2])}</div>`).join('')}</div>` : ''}
      <pre title="main class and JVM options">${esc(j.main)}\n${esc(j.args)}</pre></div>
    <div id="jh-${j.id}">${h ? jvmChart(h.rows) : '<div class="empty">loading history…</div>'}</div></div>
    ${snapBar(j)}${snapView(j)}`;
}

async function toggleJvm(id) {
  openJvms.has(id) ? openJvms.delete(id) : openJvms.add(id);
  renderJvms();
  if (openDrawerJvms()) openDrawer(openSid, true);
  if (openJvms.has(id)) loadJvmHist(id);
}
function openDrawerJvms() { return openSid && S.jvms.some(j => j.sid === openSid); }
async function loadJvmHist(id) {
  const key = Math.floor(Date.now() / 60000);
  if (jvmHistCache[id]?.key !== key) {
    let rows = [];
    try { rows = await api(`/api/jvm?id=${id}&since=${Math.floor(S.now - 3 * 3600)}`); } catch (e) { }
    jvmHistCache[id] = { key, rows };
  }
  for (const el of document.querySelectorAll(`#jh-${id}`)) el.innerHTML = jvmChart(jvmHistCache[id].rows);
}

// Last 3h per minute: CPU, heap (used over committed, max dashed), GC % of wall.
function jvmChart(rows) {
  if (rows.length < 2) return '<div class="empty">per-minute history appears after a couple of minutes</div>';
  const W = 520, H = 44, gap = 16, t0 = rows[0][0], t1 = rows[rows.length - 1][0] + 60;
  const x = t => ((t - t0) / (t1 - t0) * W).toFixed(1), bw = Math.max(1, W / ((t1 - t0) / 60) - .5).toFixed(1);
  const panel = (y0, label, body) => `<g transform="translate(0,${y0})"><text x="0" y="-3">${label}</text><line x1="0" x2="${W}" y1="${H}" y2="${H}" stroke="var(--grid)"/>${body}</g>`;
  const cpuMax = Math.max(100, ...rows.map(r => r[1]));
  const cpu = rows.map(r => `<rect x="${x(r[0])}" y="${(H - r[1] / cpuMax * H).toFixed(1)}" width="${bw}" height="${(r[1] / cpuMax * H).toFixed(1)}" fill="var(--s1)"/>`).join('');
  const hMax = Math.max(...rows.map(r => r[5] || r[4]));
  const hy = v => (H - v / hMax * H).toFixed(1);
  const committed = `<polygon points="${rows.map(r => `${x(r[0])},${hy(r[4])}`).join(' ')} ${x(rows[rows.length - 1][0])},${H} ${x(t0)},${H}" fill="color-mix(in srgb, var(--s3) 25%, transparent)"/>`;
  const heap = committed + `<polyline points="${rows.map(r => `${x(r[0])},${hy(r[3])}`).join(' ')}" fill="none" stroke="var(--s3)" stroke-width="1.5"/>` +
    `<line x1="0" x2="${W}" y1="${hy(hMax)}" y2="${hy(hMax)}" stroke="var(--axis)" stroke-dasharray="3 3"/>`;
  const gcMax = Math.max(10, ...rows.map(r => r[6]));
  const gc = rows.map(r => r[6] > 0 ? `<rect x="${x(r[0])}" y="${(H - r[6] / gcMax * H).toFixed(1)}" width="${bw}" height="${(r[6] / gcMax * H).toFixed(1)}" fill="${r[12] ? 'var(--critical)' : 'var(--s2)'}"/>` : '').join('');
  const last = rows[rows.length - 1];
  return `<svg width="100%" viewBox="0 -12 ${W} ${3 * (H + gap) + 4}" preserveAspectRatio="none" style="max-width:${W}px;overflow:visible">
    ${panel(0, `CPU · peak ${cores(Math.max(...rows.map(r => r[1])))} cores`, cpu)}
    ${panel(H + gap, `heap · ${mb(last[3])} used, ${mb(last[4])} committed, max ${mb(last[5])}`, heap)}
    ${panel(2 * (H + gap), `GC pauses · peak ${pct(Math.max(...rows.map(r => r[6])))} of wall${rows.some(r => r[12]) ? ' · red: full GC' : ''}`, gc)}
    <text x="0" y="${3 * (H + gap) - 2}">${ago(t0)}</text><text x="${W}" y="${3 * (H + gap) - 2}" text-anchor="end">now</text></svg>`;
}

// ---------------------------------------------------------------- the section, cards, drawer, loose ends
function renderJvms() {
  const all = S.jvms || [], list = jvmSorted(all.filter(jvmVisible));
  const sub = $('#jvm-sub');
  if (sub) sub.textContent = `${all.length} JVMs · ${cores(all.reduce((a, j) => a + j.cpu, 0))} cores · ${mb(all.reduce((a, j) => a + j.heap_used, 0))} heap in use · read from hsperfdata, nothing attached`;
  patch($('#jvms'), list.length ? jvmTable(list, true) : `<div class="empty" style="padding:10px 12px">${all.length ? 'no JVMs match the filter' : 'no JVMs running (or none publishing perf data)'}</div>`);
  for (const id of openJvms) if (!jvmHistCache[id]) loadJvmHist(id);
}
// One line per JVM on a session card; only JVMs worth mentioning.
function jvmLine(s) {
  const js = jvmSorted((S.jvms || []).filter(j => j.sid === s.sid)).filter(j => j.flags.length || j.cpu >= 5 || j.heap_used >= 200e6).slice(0, 2);
  return js.map(j => `<div class="jline"><span>☕ ${esc(j.label)}</span>${heapBar(j, 60)}<span>${mb(j.heap_used)} / ${mb(j.heap_max)}</span>${j.gc_pct ? `<span>GC ${pct(j.gc_pct)}</span>` : ''}${jvmFlags(j)}</div>`).join('');
}
function jvmDrawer(s) {
  const js = jvmSorted((S.jvms || []).filter(j => j.sid === s.sid));
  return js.length ? `<div class="k">JVMs</div><div class="jvms">${jvmTable(js, false)}</div>` : '';
}
function jvmEndsGroup() {
  const items = jvmSorted((S.jvms || []).filter(j => j.flags.length && jvmVisible(j))).map(j => {
    const s = j.sid && S.sMap[j.sid];
    return `<div class="item" onclick="${s ? `openDrawer('${s.sid}')` : `document.getElementById('sec-jvms').scrollIntoView()`}"><div class="a"><span>☕</span>${s ? `<span class="lane-chip">${esc(s.lane)}</span>` : ''}<span class="x">${esc(j.label)} <span class="when">${j.pid}</span></span>${jvmFlags(j)}</div>` +
      `<div class="b">${j.flags.map(f => esc(JVM_FLAGS[f][2])).join(' · ')}${s ? ' · session: ' + esc(s.title) : ' · no session'}</div></div>`;
  });
  return ['☕ JVMs in trouble', items];
}

// ---------------------------------------------------------------- snapshots (through the Java helper, on demand)
const SNAPS = [  // kind, button, what it costs the JVM
  ['threads', 'Threads', 'two thread dumps a second apart (two brief safepoints): what every thread is doing, and its CPU over that second'],
  ['heap', 'Heap', 'GC.heap_info: regions and spaces of the heap (cheap)'],
  ['histogram', 'Class histogram', 'GC.class_histogram -all: objects per class. Walks the whole heap at a safepoint: a pause about as long as a full GC'],
  ['native', 'Native memory', 'VM.native_memory summary: only works when the JVM was started with -XX:NativeMemoryTracking=summary'],
];
const jvmSnaps = {};  // jvm id -> {kind, loading, error, data, showIdle, open: Set}

async function takeSnapshot(id, kind) {
  if (kind === 'histogram' && !confirm('A class histogram pauses this JVM while it walks the whole heap, about as long as a full GC. Take it?')) return;
  const prev = jvmSnaps[id];
  jvmSnaps[id] = { kind, loading: true, showIdle: prev?.showIdle, open: prev?.kind === kind ? prev.open : null };
  rerenderJvms();
  try {
    const r = await fetch('/api/jvm/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, kind }) });
    const body = await r.json().catch(() => ({ error: 'HTTP ' + r.status }));
    if (!r.ok) throw new Error(body.error || 'HTTP ' + r.status);
    Object.assign(jvmSnaps[id], { loading: false, data: body });
  } catch (e) {
    Object.assign(jvmSnaps[id], { loading: false, error: String(e.message || e) });
  }
  rerenderJvms();
}
function rerenderJvms() { renderJvms(); if (openDrawerJvms()) openDrawer(openSid, true); }

function snapBar(j) {
  if (DEMO) return '<div class="snapbar sub">Thread dumps and other snapshots attach to the JVM, so they need the live server.</div>';
  const why = S.jvm_helper, cur = jvmSnaps[j.id];
  return `<div class="snapbar">${SNAPS.map(([k, label, cost]) => `<button class="btn-link ${cur?.kind === k ? 'on' : ''}" ${why || cur?.loading ? 'disabled' : ''} title="${esc(cost)}" onclick="event.stopPropagation();takeSnapshot(${j.id},'${k}')">${label}${k === 'histogram' ? ' ⚠' : ''}</button>`).join('')}
    ${why ? `<span class="sub">${esc(why)}</span>` : cur?.loading ? '<span class="sub">attaching…</span>' : ''}</div>`;
}
function snapView(j) {
  const s = jvmSnaps[j.id];
  if (!s || s.loading) return '';
  if (s.error) return `<div class="snap err">${esc(s.error)}</div>`;
  const d = s.data, when = `<span class="sub">taken ${new Date(d.t * 1000).toLocaleTimeString()} in ${d.took}s</span>`;
  if (d.kind === 'threads') return `<div class="snap">${threadsView(j.id, d.dump, when)}</div>`;
  if (d.kind === 'histogram') return `<div class="snap"><div class="snaph">Class histogram · top ${d.rows.length} by size ${when}</div><table class="jt hist"><tr><th class="num">size</th><th class="num">instances</th><th>class</th></tr>${d.rows.map(([n, b, c]) => `<tr><td class="num">${mb(b)}</td><td class="num">${n.toLocaleString()}</td><td>${esc(prettyClass(c))}</td></tr>`).join('')}</table></div>`;
  return `<div class="snap"><div class="snaph">${esc(SNAPS.find(x => x[0] === d.kind)[1])} ${when}</div><pre>${esc(d.text)}</pre></div>`;
}
const PRIM = { B: 'byte', C: 'char', D: 'double', F: 'float', I: 'int', J: 'long', S: 'short', Z: 'boolean' };
function prettyClass(c) {  // [B -> byte[], [Ljava.lang.String; -> java.lang.String[]
  const m = /^(\[+)(?:([BCDFIJSZ])|L(.+);)( .*)?$/.exec(c);
  return m ? (m[2] ? PRIM[m[2]] : m[3]) + '[]'.repeat(m[1].length) + (m[4] || '') : c;
}

// A thread dump, grouped by thread name with numbering wildcarded, busiest first:
// pool-3-thread-12 -> pool-*-thread-*, GC Thread#7 -> GC Thread#*, but G1 and C2 keep their digits.
const threadGroup = name => name.replace(/(?<=[-#_ .])\d+|(?<=[a-z])\d+$/gi, '*');
const STATE_COLOR = { RUNNABLE: 'var(--s3)', BLOCKED: 'var(--critical)', WAITING: 'var(--axis)', TIMED_WAITING: 'var(--axis)', NEW: 'var(--muted)', TERMINATED: 'var(--muted)' };
const stateOf = t => t.vm ? 'VM' : (t.state || '').split(' ')[0] || '?';
const isIdle = t => !t.deadlocked && stateOf(t) !== 'BLOCKED' && !(t.cpuDelta >= 1);
function threadsView(id, d, when) {
  const s = jvmSnaps[id], ts = d.threads;
  const byState = {};
  for (const t of ts) byState[stateOf(t)] = (byState[stateOf(t)] || 0) + 1;
  const busy = ts.reduce((a, t) => a + (t.cpuDelta || 0), 0);
  const shown = s.showIdle ? ts : ts.filter(t => !isIdle(t));
  const groups = {};
  for (const t of shown) (groups[threadGroup(t.name)] ||= []).push(t);
  const cpuOf = g => g.reduce((a, t) => a + (t.cpuDelta || 0), 0);
  const list = Object.entries(groups).map(([k, g]) => [k, g.sort((a, b) => (b.cpuDelta || 0) - (a.cpuDelta || 0))])
    .sort((a, b) => b[1].some(t => t.deadlocked) - a[1].some(t => t.deadlocked) || cpuOf(b[1]) - cpuOf(a[1]) || b[1].length - a[1].length);
  if (!s.open) s.open = new Set(list.filter(([, g]) => g.some(t => t.deadlocked || stateOf(t) === 'BLOCKED') || cpuOf(g) >= 10).slice(0, 4).map(([k]) => k));
  const head = `<div class="snaph">${ts.length} threads · ${Object.entries(byState).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<span class="tstate"><i style="background:${STATE_COLOR[k] || 'var(--s7)'}"></i>${n} ${k === 'VM' ? 'VM-internal' : k}</span>`).join(' ')}
    · ${cores(busy / 10)} cores busy over the sampled second ${when}
    <label class="chk" onclick="event.stopPropagation()"><input type="checkbox" ${s.showIdle ? 'checked' : ''} onchange="jvmSnaps[${id}].showIdle=this.checked;rerenderJvms()"> idle threads (${ts.filter(isIdle).length})</label></div>`;
  const dl = d.deadlocks.length ? `<div class="deadlock"><b>⚠ ${d.deadlocks.length === 1 ? 'Deadlock' : d.deadlocks.length + ' deadlocks'}</b><pre>${esc(d.deadlocks.join('\n\n'))}</pre></div>` : '';
  const body = list.map(([k, g]) => {
    const top = g[0], cpu = cpuOf(g), frame = top.frames[0]?.text || top.status || '';
    return `<details class="tg" ${s.open.has(k) ? 'open' : ''} ontoggle="event.stopPropagation();const o=jvmSnaps[${id}].open;this.open?o.add(${esc(JSON.stringify(k))}):o.delete(${esc(JSON.stringify(k))})" onclick="event.stopPropagation()">
      <summary><span class="tgn">${esc(k)}</span>${g.length > 1 ? ` <span class="sub">×${g.length}</span>` : ''} ${g.map(t => `<i class="dot" style="background:${STATE_COLOR[stateOf(t)] || 'var(--s7)'}" title="${esc(t.name)}: ${esc(t.state || t.status)}"></i>`).join('')}
        ${g.some(t => t.deadlocked) ? '<span class="jflag">⚠ deadlocked</span>' : ''}<span class="tcpu">${cpu >= 1 ? Math.round(cpu) + ' ms CPU' : ''}</span><span class="tframe">${esc(shortFrame(frame))}</span></summary>
      ${g.map(t => threadView(t)).join('')}</details>`;
  }).join('') || '<div class="empty">no busy or blocked threads in this dump; tick “idle threads” to see the rest</div>';
  return head + dl + body;
}
const shortFrame = f => f.replace(/\((?:[\w.]+@[\w.+-]+\/)?([^)]*)\)$/, '($1)');
function threadView(t) {
  const frames = t.frames.map(f => `<div class="fr">${esc(shortFrame(f.text))}</div>${f.locks.map(l => `<div class="lk ${/^waiting to lock|^blocked/.test(l) ? 'bad' : ''}">- ${esc(l)}</div>`).join('')}`);
  const st = stateOf(t);
  return `<div class="th"><div class="thh"><b>${esc(t.name)}</b> <span class="tstate"><i style="background:${STATE_COLOR[st] || 'var(--s7)'}"></i>${esc(t.state || t.status || st)}</span>
    ${t.deadlocked ? '<span class="jflag">⚠ deadlocked</span>' : ''}<span class="sub">${t.cpuDelta != null ? `${t.cpuDelta} ms in the last second · ` : ''}${t.cpuMs != null ? `${(t.cpuMs / 1000).toFixed(1)} s CPU total` : ''}${t.daemon ? ' · daemon' : ''}</span></div>
    ${frames.length ? `<div class="stack">${frames.slice(0, 10).join('')}${frames.length > 10 ? `<details onclick="event.stopPropagation()"><summary class="sub">${frames.length - 10} more frames</summary>${frames.slice(10).join('')}</details>` : ''}</div>` : ''}
    ${t.synchronizers.length ? `<div class="lk">owns: ${t.synchronizers.map(esc).join(', ')}</div>` : ''}</div>`;
}
