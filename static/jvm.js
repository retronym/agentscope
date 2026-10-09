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
    <div id="jh-${j.id}">${h ? jvmChart(h.rows) : '<div class="empty">loading history…</div>'}</div></div>`;
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
