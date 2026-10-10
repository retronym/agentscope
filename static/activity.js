// What every recorded JVM's threads are doing, machine-wide: Gradle-style worker lines for right now, and lanes over
// the last minutes coloured by activity. Uses the page's globals (S, $, esc, api, patch, tip, hideTip, openJvmBox, DEMO)
// and profile.js's (prof, recState, canvasFor, fit, shortName, css, setProf, clock).

const act = { window: 300, data: null, busy: false, fetched: 0 };
const ACT_ROW = 14, ACT_LABEL = 300;

// A stable colour per activity; the catch-alls stay grey.
function actColor(name) {
  if (!name || name === 'JDK' || name === 'native' || name === '?') return css('--axis');
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  const dark = matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light';
  return `hsl(${(Math.abs(h) * 137.508) % 360}, 62%, ${dark ? 58 : 52}%)`;
}

async function loadActivity(force) {
  if (act.busy || (!force && Date.now() - act.fetched < 4000)) return;
  act.busy = true;
  try { act.data = await api(`/api/activity?window=${act.window}`); act.error = null; } catch (e) { act.error = String(e.message || e); }
  act.busy = false; act.fetched = Date.now();
  renderActivity();
}

// The recorded JVMs in a stable order (by session, then JVM), each with its threads
function activityGroups() {
  const d = act.data; if (!d) return [];
  const out = [];
  for (const [id, r] of Object.entries(d.jvms)) {
    const j = (S.jvms || []).find(x => x.id === +id);
    if (!j || r.error) continue;
    const s = j.sid && S.sMap[j.sid];
    out.push({ j, s, r, key: (s ? s.title : '~') + ' ' + j.label + ' ' + j.pid });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

function renderActivity() {
  const el = $('#jvmactivity'); if (!el) return;
  const live = Object.values(recState().jvms || {}).some(r => r.live);
  if (DEMO || !live) { el.hidden = true; return; }
  el.hidden = false;
  if (!el.dataset.built) {  // the lanes canvas lives outside what gets patched, so it survives refreshes
    el.innerHTML = `<div class="profh"><b>Activity</b><span class="sub">what every recorded JVM's threads are doing</span><span id="actwin"></span><span class="sub" id="actstat"></span></div>
      <div class="panel actpanel"><div id="actlines"></div><div class="actlanes"><canvas id="lanes-act"></canvas></div><div id="actlegend" class="actlegend"></div></div>`;
    el.dataset.built = 1;
  }
  patch($('#actwin'), `<span class="seg">${[[300, '5 min'], [1800, '30 min']].map(([w, l]) => `<button class="${act.window === w ? 'on' : ''}" onclick="act.window=${w};loadActivity(true)">${l}</button>`).join('')}</span>`);
  const groups = activityGroups();
  // worker lines, grouped by session, then JVM
  let html = '', lastSession = null;
  for (const { j, s, r } of groups) {
    const sk = s ? s.sid : '';
    if (sk !== lastSession) {
      html += `<div class="actsess">${s ? `<a href="#" onclick="openDrawer('${s.sid}');return false"><span class="lane-chip">${esc(s.lane)}</span> ${esc(s.title)}</a>` : '<span class="dim">no session</span>'}</div>`;
      lastSession = sk;
    }
    const busy = r.threads.filter(t => t.now_samples > 0).sort((a, b) => b.now_samples - a.now_samples);
    const shown = busy.slice(0, 6);
    html += `<div class="actjvm"><a href="#" onclick="openJvmBox(${j.id});return false">☕ ${esc(j.label)} <span class="sub">${j.pid}</span></a>
        <span class="sub">${busy.length ? `${busy.length} busy thread${busy.length > 1 ? 's' : ''}` : 'idle'}${activityLine(j) ? ' · ' : ''}</span>${activityLine(j)}</div>` +
      shown.map(t => `<div class="actline" onclick="openThread(${j.id}, ${t.tid}, ${esc(JSON.stringify(t.name))})" title="${esc(t.frame || '')}">
        <i style="background:${actColor(t.now)}"></i><span class="actname">${esc(t.now || '?')}</span><span class="actthread">${esc(t.name)}</span>
        <span class="actframe">${esc(t.frame ? shortName(t.frame) : '')}${t.native ? ' <span class="sub">(native)</span>' : ''}</span></div>`).join('') +
      (busy.length > shown.length ? `<div class="actline sub" style="cursor:default">+${busy.length - shown.length} more busy</div>` : '');
  }
  patch($('#actlines'), html || '<div class="empty">no samples yet</div>');
  const stat = $('#actstat');
  if (stat) stat.textContent = act.error ? '⚠ ' + act.error : `${groups.length} JVM${groups.length === 1 ? '' : 's'} · lanes: one per busy thread, coloured by activity · drag to pick a range for Across JVMs`;
  drawActivityLanes(groups);
}

function openThread(jvmId, tid, name) {
  prof[jvmId] = Object.assign(prof[jvmId] || { kind: 'cpu', window: 300, zoom: [] }, { thread: { tid, name }, zoom: [] });
  openJvmBox(jvmId);
}

function drawActivityLanes(groups) {
  const d = act.data; if (!d) return;
  const rows = [];  // [group, thread] for threads with samples in the window, a few per JVM
  for (const g of groups) for (const t of g.r.threads.filter(t => t.samples > 0).slice(0, 8)) rows.push([g, t]);
  const r = canvasFor('act', 'lanes', Math.max(1, rows.length) * ACT_ROW + 18);
  if (!r) return;
  const [c, g, w] = r, x0 = ACT_LABEL, win = d.window * 1000, since = d.since * 1000, xOf = t => x0 + (t - since) / win * (w - x0);
  const ink = css('--ink'), muted = css('--muted'), grid = css('--grid');
  const seen = new Set();
  let prevJvm = null;
  rows.forEach(([grp, t], i) => {
    const y = 4 + i * ACT_ROW, td = grp.r;
    if (prevJvm !== grp.j.id) { if (i) { g.fillStyle = grid; g.fillRect(0, y - 1, w, 1); } prevJvm = grp.j.id; }
    g.fillStyle = muted;
    g.fillText(fit(g, `${grp.j.label} ${grp.j.pid}`, 120), 4, y + ACT_ROW / 2);
    g.fillStyle = ink;
    g.fillText(fit(g, t.name, x0 - 132), 128, y + ACT_ROW / 2);
    for (const [b, [ai, n]] of Object.entries(t.bins)) {
      const name = td.activities[ai];
      seen.add(name);
      const a = xOf(td.since + b * td.bin), z = xOf(td.since + (+b + 1) * td.bin);
      g.fillStyle = actColor(name);
      g.globalAlpha = Math.min(1, 0.35 + n / (td.bin / 20) * 0.65);  // fuller when the thread was on CPU more of the bin
      g.fillRect(a, y + 1, Math.max(1, z - a), ACT_ROW - 2);
      g.globalAlpha = 1;
    }
  });
  const yT = 6 + rows.length * ACT_ROW + 8;
  g.fillStyle = muted; g.fillText(`${clock(d.window)} ago`, x0, yT); g.textAlign = 'right'; g.fillText('now', w - 2, yT); g.textAlign = 'left';
  if (act.sel) { const a = xOf(act.sel[0] * 1000), z = xOf(act.sel[1] * 1000); g.fillStyle = css('--accent') + '2e'; g.fillRect(a, 0, Math.max(2, z - a), rows.length * ACT_ROW + 4); }
  patch($('#actlegend'), [...seen].sort().map(n => `<span><i style="background:${actColor(n)}"></i>${esc(n)}</span>`).join(''));
  // hover names the cell; click a lane to open that thread; drag to choose Across JVMs' range
  const at = e => { const b = c.getBoundingClientRect(); return [e.clientX - b.left, Math.floor((e.clientY - b.top - 4) / ACT_ROW)]; };
  const tOf = x => (since + (x - x0) / (w - x0) * win) / 1000;
  c.onmousemove = e => {
    const [x, i] = at(e), row = rows[i]; if (!row) return hideTip();
    const [grp, t] = row, td = grp.r, b = Math.floor((tOf(x) * 1000 - td.since) / td.bin), cell = t.bins[b];
    tip(e, `<div class="tt">${esc(t.name)}</div><div class="tm">${esc(grp.j.label)} ${grp.j.pid}${grp.s ? ' · ' + esc(grp.s.title) : ''}</div>` +
      (x > x0 ? `<div>${cell ? `<span style="color:${actColor(td.activities[cell[0]])}">■</span> ${esc(td.activities[cell[0]])}` : '<span class="tm">idle</span>'} <span class="tm">at ${new Date(tOf(x) * 1000).toLocaleTimeString()}</span></div>` : '<div class="tm">click to open this thread</div>'));
  };
  c.onmouseleave = hideTip;
  c.onmousedown = e => {
    const [xa, i] = at(e);
    if (xa < x0) { const row = rows[i]; if (row) openThread(row[0].j.id, row[1].tid, row[1].name); return; }
    let xb = xa;
    const move = ev => { xb = ev.clientX - c.getBoundingClientRect().left; act.sel = [tOf(Math.min(xa, xb)), tOf(Math.max(xa, xb))]; drawActivityLanes(groups); };
    const up = () => {
      removeEventListener('mousemove', move); removeEventListener('mouseup', up);
      if (Math.abs(xb - xa) < 3) { act.sel = null; setProf('all', { abs: null, zoom: [] }); }
      else { setProf('all', { abs: act.sel, zoom: [] }); document.getElementById('jvmflame')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      drawActivityLanes(groups);
    };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  };
}
