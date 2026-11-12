// Disk: free space in the machine strip, and what grew in Loose ends once it is low. From S.disk (disk.py), which is
// absent in the static demo and before the first sample: everything here then draws nothing.
const diskColor = d => d.free < d.critical ? 'var(--critical)' : d.free < d.low ? 'var(--warning)' : '';
const diskSpan = s => s >= 23.5 * 3600 ? '24 h' : s >= 5400 ? Math.round(s / 3600) + ' h' : Math.max(1, Math.round(s / 60)) + ' min';
const diskPath = p => p.replace(/^\/Users\/[^/]+\//, '~/');

// Two rows for the machine strip's legend: free space, then a week of it (from zero, so the height is how close to
// empty) with the change over the last day and, when it is falling, how long that rate leaves.
function diskLegend() {
  const d = S.disk;
  if (!d || d.free == null) return '';
  const c = diskColor(d), W = 96, H = 18, h = d.hist || [];
  let spark = '';
  if (h.length > 1) {
    const t0 = h[0][0], t1 = h[h.length - 1][0], mx = Math.max(...h.map(r => r[1]), d.low);
    const pts = h.map(r => `${((r[0] - t0) / Math.max(1, t1 - t0) * W).toFixed(1)},${(H - 1 - r[1] / mx * (H - 2)).toFixed(1)}`).join(' ');
    const lowY = (H - 1 - d.low / mx * (H - 2)).toFixed(1);
    spark = `<svg width="${W}" height="${H}"><line x1="0" x2="${W}" y1="${lowY}" y2="${lowY}" stroke="var(--axis)" stroke-dasharray="2 3"/><polyline points="${pts}" fill="none" stroke="${c || 'var(--ink-2)'}" stroke-width="1.5"/></svg>`;
  }
  let trend = 'collecting…';
  if (d.d24 != null) {
    trend = (d.d24 < 0 ? '−' : '+') + gb(Math.abs(d.d24)) + ' / ' + diskSpan(d.span);
    const days = d.d24 < 0 ? d.free / (-d.d24 / d.span * 86400) : Infinity;
    if (days < 30) trend += ` · full in ~${days < 2 ? Math.max(1, Math.round(days * 24)) + ' h' : Math.round(days) + ' d'}`;
  }
  const tip = `${gb(d.free)} free of ${gb(d.total)} on / · warns below ${gb(d.low)}, critical below ${gb(d.critical)} · the line is the last 7 days`;
  return `<div title="${esc(tip)}" style="margin-top:5px;padding-top:5px;border-top:1px solid var(--border);color:var(--ink);font-weight:600">Disk free<b style="${c ? `color:${c};font-weight:600` : ''}">${gb(d.free)}</b></div>` +
    `<div title="${esc(tip)}">${spark}<b>${trend}</b></div>`;
}

// The Loose ends group, only while free space is below the threshold: the measured directories that grew most over the
// last day, each with the session that last touched it. A row opens that session; without one it copies the path.
function diskEndsGroup() {
  const d = S.disk;
  if (!d || d.free == null || d.free >= d.low) return null;
  const KIND = { worktree: 'worktree', perflab: 'perflab', cache: 'cache', scratch: 'scratchpad', dir: 'dir' };
  const items = (d.growers || []).map(g => {
    const s = g.sid && S.sMap[g.sid];
    const since = g.since > d.du_t - d.window + 60 ? (g.new ? 'new ' : 'since ') + ago(g.since) : `in ${diskSpan(d.window)}`;
    const parts = (g.parts || []).map(p => `${esc(p.path)} +${gb(p.grew)}`).join(', ');
    const name = g.kind === 'scratch' ? (s ? s.title : diskPath(g.path)) : diskPath(g.path).replace(/^.*\/\.worktrees\//, '');
    return `<div class="item" title="${esc(g.path)}" onclick="${s ? `openDrawer('${s.sid}')` : 'navigator.clipboard.writeText(this.title)'}"><div class="a"><span class="lane-chip">${KIND[g.kind] || esc(g.kind)}</span><span class="x">${esc(name)}</span><span class="when" style="color:var(--ink)">+${gb(g.grew)}</span></div>` +
      `<div class="b">${since} · now ${gb(g.size)}${parts ? ` · of which ${parts}` : ''} · ${s ? `session${g.kind === 'scratch' ? '' : ': ' + esc(s.title)} <span class="when">active ${ago(s.last)}</span>` : 'no session known'}</div></div>`;
  });
  const when = d.du_t ? `measured ${ago(d.du_t)}${d.scanning ? ', measuring again…' : ''}` : 'measuring directories…';
  return [`<span style="color:${diskColor(d)}">▲</span> Disk low: ${gb(d.free)} free · what grew <span class="when">${when}</span>`, items];
}
