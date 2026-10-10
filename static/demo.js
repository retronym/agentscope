// The static demo's profiler. The live server asks the Java helper (a JVM's last 30 minutes) and profiles.py (stored
// minutes); the demo answers the same questions here, with the same shapes, from recordings of public workloads
// (STATIC_DATA.profiles.fixture, made by demo/record_fixture.py):
//   - each recorded demo JVM replays one workload, looped, so its lanes and heatmap move as the demo clock ticks;
//   - Across JVMs gives every JVM-like process in the snapshot's history the minutes of a workload like its own,
//     scaled by the CPU it really used that minute.
// Uses the page's globals (S, DEMO).

const DemoProf = (() => {
  const T0 = Date.now();
  const MIN_BUSY_CORES = 0.05, MIN_SHARE = 0.002;
  const CPU_SAMPLES_PER_CORE_MINUTE = 750;  // JFR's 20 ms sampler, of which macOS delivers about a quarter
  let P = null;  // STATIC_DATA.profiles, prepared on first use

  // The demo's clock: the snapshot's time, moving on as the page stays open
  const now = () => (S?.now ?? window.STATIC_DATA.state.now) + (Date.now() - T0) / 1000;

  function prep() {
    if (P) return P;
    P = window.STATIC_DATA.profiles;
    if (!P) return null;
    const fx = P.fixture;
    fx.kindIdx = Object.fromEntries(fx.kinds.map((k, i) => [k, i]));
    fx.pathCache = new Map();
    // a recorded JVM's loops line up with the snapshot's time, each JVM at its own point in the workload
    for (const r of Object.values(P.jvms)) r.base = window.STATIC_DATA.state.now * 1000 - r.phase;
    for (const j of fx.jvms) {
      j.tidIdx = new Map(j.threads.map(([tid], i) => [tid, i]));
      j.groups = j.threads.map(([, name]) => threadGroup(name));
    }
    return P;
  }
  const threadGroup = name => name == null ? '?' : name.replace(/(?<=[-#_ .])\d+|(?<=[a-zA-Z])\d+$/g, '*');

  // frame names of a stack (fixture node id), root first
  function framesOf(fx, leaf) {
    let f = fx.pathCache.get(leaf);
    if (!f) {
      f = [];
      for (let n = leaf; n > 0; n = fx.tree.parent[n - 1]) f.push(fx.frames[fx.tree.frame[n - 1]]);
      f.reverse();
      fx.pathCache.set(leaf, f);
    }
    return f;
  }

  // ---------------------------------------------------------------- replaying a workload on the demo clock
  // A recorded JVM shows its workload looped: fixture offset o happens at base + o + k·span, for every k.
  function rec(id) { const p = prep(); return p && p.jvms[id]; }
  function tiles(r, a, b) {  // [shift ms] of the loops overlapping [a, b) ms
    const fx = P.fixture, span = fx.span, base = r.base, out = [];
    for (let k = Math.floor((a - base) / span) - 1; base + k * span < b; k++) if (base + (k + 1) * span > a) out.push(base + k * span);
    return out;
  }
  const lowerBound = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; arr[m] < x ? lo = m + 1 : hi = m; } return lo; };
  // every row of a column set with time in [a, b) ms (demo time), as (t, i)
  function each(cols, r, a, b, f) {
    for (const s of tiles(r, a, b)) {
      const lo = lowerBound(cols.t, a - s), hi = lowerBound(cols.t, b - s);
      for (let i = lo; i < hi; i++) f(cols.t[i] + s, i);
    }
  }
  const nowMs = () => now() * 1000;

  // ---------------------------------------------------------------- /api/jvm/summary: lanes, heatmap, GC (Profile.summary)
  function summary(id, since, maxBins) {
    const r = rec(id); if (!r) return null;
    const j = P.fixture.jvms[r.fx], S_ = j.samples, K = P.fixture.kindIdx;
    const last = nowMs(), span = Math.max(1000, last - since), bin = Math.max(1000, Math.ceil(span / maxBins / 1000) * 1000), nb = Math.floor(span / bin) + 1;
    const lanes = new Map(), heat = Array.from({ length: nb }, () => new Array(20).fill(0));
    const cell = (th, b) => { let l = lanes.get(th); if (!l) lanes.set(th, l = new Map()); let c = l.get(b); if (!c) l.set(b, c = [0, 0, 0, 0, 0]); return c; };
    each(S_, r, since, last, (t, i) => {
      const b = Math.floor((t - since) / bin), k = S_.k[i], c = cell(S_.th[i], b);
      if (k === K.cpu) { c[1] += S_.w[i]; heat[b][Math.floor((t % 1000) / 50)] += S_.w[i]; }
      else if (k === K.native) c[2]++;
      else if (k === K.park) c[3] += S_.w[i];
      else if (k === K.lock) c[4] += S_.w[i];
    });
    each(j.cpu, r, since, last, (t, i) => { cell(j.cpu.th[i], Math.floor((t - since) / bin))[0] += j.cpu.load[i] / 10000 * 1000 / bin; });
    const threads = [];
    for (const [th, cells] of lanes) {
      let total = 0; const bins = {};
      for (const [b, c] of [...cells].sort((x, y) => x[0] - y[0])) {
        total += c[0] + c[1] * 0.02;
        if (c[0] > 0.005 || c[1] || c[2] || c[3] || c[4]) { c[0] = Math.round(c[0] * 1000) / 1000; bins[b] = c; }
      }
      if (Object.keys(bins).length) threads.push({ tid: j.threads[th][0], name: j.threads[th][1], busy: Math.round(total * 100) / 100, bins });
    }
    threads.sort((x, y) => y.busy - x.busy);
    const gc = [], gcn = [];
    for (const s of tiles(r, since, last)) for (const [t, us, n] of j.gc) if (t + s >= since && t + s < last) { gc.push([t + s, us]); gcn.push(n); }
    gc.sort((x, y) => x[0] - y[0]);
    return { since, bin, bins: nb, first: since, last, threads, heat, gc, gc_names: gcn };
  }

  // ---------------------------------------------------------------- flame graphs ([name, value, children]), pruned as the server does
  class Node { constructor() { this.v = 0; this.k = null; } child(name, meta) { this.k ||= new Map(); let c = this.k.get(name); if (!c) this.k.set(name, c = new Node()), c.meta = meta; return c; } }
  function add(root, names, w, metaN = 0) {
    root.v += w;
    let n = root;
    names.forEach((x, i) => { n = n.child(x, i < metaN); n.v += w; });
  }
  // Nodes under MIN_SHARE of the total are left out, except along and below the zoom path, where it's of the zoomed subtree
  function out(root, path) {
    let at = root.v, n = root;
    for (const p of path) { n = n.k?.get(p); if (!n) { at = root.v; break; } at = n.v; }
    const lo = Math.max(1, root.v * MIN_SHARE), loPath = Math.max(1, at * MIN_SHARE);
    const rec_ = (node, name, depth, inside) => {
      const kids = [];
      if (node.k) for (const [kn, k] of [...node.k].sort((a, b) => b[1].v - a[1].v)) {
        const on = !inside && depth < path.length && kn === path[depth];
        if (k.v >= (inside || on ? loPath : lo)) kids.push(rec_(k, kn, depth + 1, inside || (on && depth + 1 === path.length)));
      }
      const v = Math.round(node.v);
      return node.meta ? [name, v, kids, 1] : [name, v, kids];
    };
    return rec_(root, 'all', 0, !path.length);
  }

  // /api/jvm/flame (Profile.flame)
  function jvmFlame(id, t0, t1, kind, threads, reverse, path) {
    const r = rec(id); if (!r) return null;
    const fx = P.fixture, j = fx.jvms[r.fx], S_ = j.samples, k = fx.kindIdx[kind];
    if (k === undefined) throw new Error('kind: one of ' + fx.kinds.join(', '));
    const want = threads.length ? new Set(threads.map(t => j.tidIdx.get(t))) : null;
    const root = new Node();
    let n = 0;
    each(S_, r, t0, Math.min(t1, nowMs()), (t, i) => {
      if (S_.k[i] !== k || (want && !want.has(S_.th[i]))) return;
      n++;
      const st = S_.st[i];
      if (st < 0) { root.v += S_.w[i]; return; }
      const names = framesOf(fx, j.stacks.leaf[st]);
      add(root, reverse ? [...names].reverse() : names, S_.w[i]);
    });
    const res = { kind, reverse, total: Math.round(root.v), samples: n, root: out(root, path) };
    if (path.length) res.path = path;
    return res;
  }

  // ---------------------------------------------------------------- /api/activity (Profile.threadActivity, for every recorded JVM)
  function threadActivity(id, since, maxBins, nowWin = 5000, maxThreads = 40) {
    const r = rec(id), fx = P.fixture, j = fx.jvms[r.fx], S_ = j.samples, K = fx.kindIdx;
    const last = nowMs(), span = Math.max(1000, last - since), bin = Math.max(1000, Math.ceil(span / maxBins / 1000) * 1000), nb = Math.floor(span / bin) + 1;
    const cores = new Map(), coresNow = new Map();
    each(j.cpu, r, since, last, (t, i) => {
      const b = Math.floor((t - since) / bin), th = j.cpu.th[i], load = j.cpu.load[i] / 10000;
      let c = cores.get(th); if (!c) cores.set(th, c = new Float64Array(2 * nb));
      c[2 * b] += load; c[2 * b + 1]++;
      if (t >= last - nowWin) coresNow.set(th, Math.max(coresNow.get(th) || 0, load));
    });
    const actIndex = new Map(), cells = new Map(), totals = new Map(), latest = new Map();
    each(S_, r, since, last, (t, i) => {
      const kind = S_.k[i], th = S_.th[i];
      if (kind !== K.cpu && kind !== K.native) return;
      const b = Math.floor((t - since) / bin);
      if (kind === K.native) {  // only counts when the thread also used CPU then: otherwise it's waiting in native code
        const c = cores.get(th);
        if (!c || !c[2 * b + 1] || c[2 * b] / c[2 * b + 1] < MIN_BUSY_CORES) return;
        if (t >= last - nowWin && (coresNow.get(th) || 0) < MIN_BUSY_CORES) return;
      }
      const st = S_.st[i], act = st < 0 ? '?' : fx.activities[j.stacks.act[st]];
      if (!actIndex.has(act)) actIndex.set(act, actIndex.size);
      const ai = actIndex.get(act);
      let m = cells.get(th); if (!m) cells.set(th, m = new Map());
      const key = b * 65536 + ai; m.set(key, (m.get(key) || 0) + 1);
      const tot = totals.get(th) || totals.set(th, [0, 0]).get(th);
      tot[0]++;
      if (t >= last - nowWin) { tot[1]++; latest.set(th, i); }
    });
    const order = [...totals.keys()].sort((x, y) => (totals.get(y)[1] - totals.get(x)[1]) * 1e6 + totals.get(y)[0] - totals.get(x)[0]);
    const threads = order.slice(0, maxThreads).map(th => {
      const best = new Map();
      for (const [key, n] of cells.get(th)) { const b = Math.floor(key / 65536), a = key % 65536, cur = best.get(b); if (!cur || n > cur[1]) best.set(b, [a, n]); }
      const name = j.threads[th][1], t = { tid: j.threads[th][0], name, group: threadGroup(name), samples: totals.get(th)[0], now_samples: totals.get(th)[1] };
      const li = latest.get(th);
      if (li !== undefined) {
        const st = S_.st[li];
        t.now = st < 0 ? '?' : fx.activities[j.stacks.act[st]];
        t.frame = st < 0 ? null : framesOf(fx, j.stacks.leaf[st])[j.stacks.top[st]] ?? null;
        t.native = S_.k[li] === K.native;
      }
      t.bins = Object.fromEntries([...best].sort((x, y) => x[0] - y[0]).map(([b, v]) => [String(b), v]));
      return t;
    });
    return { since, bin, bins: nb, activities: [...actIndex.keys()], threads };
  }

  // What a recorded JVM did in the last 30 seconds (Recorder._activities): [[activity, %, threads]], busiest first
  function activities(id) {
    const r = rec(id), fx = P.fixture, j = fx.jvms[r.fx], S_ = j.samples, last = nowMs();
    const n = new Map(), threads = new Map();
    each(S_, r, last - 30000, last, (t, i) => {
      if (S_.k[i] !== fx.kindIdx.cpu) return;
      const a = S_.st[i] < 0 ? '?' : fx.activities[j.stacks.act[S_.st[i]]];
      n.set(a, (n.get(a) || 0) + 1);
      (threads.get(a) || threads.set(a, new Set()).get(a)).add(S_.th[i]);
    });
    const total = [...n.values()].reduce((a, b) => a + b, 0) || 1;
    return [...n].sort((x, y) => y[1] - x[1]).slice(0, 4).map(([a, c]) => [a, Math.round(c / total * 100), threads.get(a).size]);
  }

  // ---------------------------------------------------------------- /api/jvms/flame: Across JVMs (profiles.flame)
  // The fixture cut into whole minutes; per workload, minute and kind: stack -> weight, and its CPU samples
  function minutes(fxi) {
    const fx = P.fixture, j = fx.jvms[fxi];
    if (j.minutes) return j.minutes;
    const n = Math.max(1, Math.floor(fx.span / 60000)), S_ = j.samples;
    j.minutes = Array.from({ length: n }, () => ({ kinds: new Map(), cpu: 0 }));
    for (let i = 0; i < S_.t.length; i++) {
      const m = Math.floor(S_.t[i] / 60000); if (m >= n) continue;
      const kinds = j.minutes[m].kinds, byStack = kinds.get(S_.k[i]) || kinds.set(S_.k[i], new Map()).get(S_.k[i]);
      byStack.set(S_.st[i], (byStack.get(S_.st[i]) || 0) + S_.w[i]);
    }
    for (const m of j.minutes) { const c = m.kinds.get(P.fixture.kindIdx.cpu); m.cpu = c ? [...c.values()].reduce((a, b) => a + b, 0) : 0; }
    return j.minutes;
  }
  const hash = (...xs) => { let h = 7; for (const c of xs.join('|')) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };

  function acrossFlame(t0, t1, kind, reverse, path) {
    const p = prep(), fx = p.fixture, k = fx.kindIdx[kind];
    if (k === undefined) throw new Error('kind: one of ' + fx.kinds.join(', '));
    // per process: which workload minute each of its minutes replays, and how much of it
    const acc = new Map();  // `${proc}:${minute}` -> [proc, fixture minute, scale]
    let first = null, last = null, count = 0;
    for (const pr of p.across) {
      const mins = minutes(pr.fx);
      for (const [t, cpu] of pr.series) {
        if (t < t0 || t >= t1 || cpu < 5) continue;
        const m = hash(pr.id, t) % mins.length, fm = mins[m];
        if (!fm.cpu) continue;
        const key = pr.id + ':' + m, a = acc.get(key) || acc.set(key, [pr, m, 0]).get(key);
        a[2] += cpu / 100 * CPU_SAMPLES_PER_CORE_MINUTE / fm.cpu;  // as many CPU samples as that much CPU would have given
        first = first === null ? t : Math.min(first, t); last = Math.max(last ?? t, t); count++;
      }
    }
    const root = new Node(), j0 = fx.jvms;
    for (const [pr, m, scale] of acc.values()) {
      const byStack = minutes(pr.fx)[m].kinds.get(k); if (!byStack) continue;
      const j = j0[pr.fx], sess = S.sMap[pr.sid]?.title || 'no session';
      for (const [st, w] of byStack) {
        const act = st < 0 ? '?' : fx.activities[j.stacks.act[st]];
        const names = [sess, pr.label, act, ...(st < 0 ? [] : framesOf(fx, j.stacks.leaf[st]))];
        add(root, reverse ? names.reverse() : names, w * scale, reverse ? 0 : 3);
        if (reverse) markMeta(root, names);
      }
    }
    return { kind, reverse, total: Math.round(root.v), t0, t1, first, last, minutes: count, bytes: 0, root: out(root, path) };
  }
  // reversed, the three label levels are the deepest: mark them as labels too
  function markMeta(root, names) {
    let n = root;
    names.forEach((x, i) => { n = n.k.get(x); if (i >= names.length - 3) n.meta = true; });
  }

  // ---------------------------------------------------------------- the API and the recording state
  function api(path, q) {
    if (!prep()) return null;
    const path_ = q.path ? JSON.parse(q.path) : [];
    switch (path) {
      case '/api/jvm/summary': return summary(+q.id, +q.since * 1000, +q.bins || 300);
      case '/api/jvm/flame': {
        const r = rec(+q.id), j = r && P.fixture.jvms[r.fx];
        const tids = q.group && j ? j.threads.filter((_, i) => j.groups[i] === q.group).map(t => t[0]) : (q.threads || '').split(',').filter(Boolean).map(Number);
        return jvmFlame(+q.id, +q.t0 * 1000, +q.t1 * 1000, q.kind || 'cpu', q.group && !tids.length ? [NaN] : tids, q.reverse === '1', path_);
      }
      case '/api/activity': {
        const w = +q.window || 300, since = (now() - w) * 1000;
        return { now: now(), since: since / 1000, window: w, jvms: Object.fromEntries(Object.keys(P.jvms).map(id => [id, threadActivity(+id, since, w <= 600 ? 150 : 180)])) };
      }
      case '/api/jvms/flame': return acrossFlame(+q.t0, +q.t1, q.kind || 'cpu', q.reverse === '1', path_);
      case '/api/captures': return [];
    }
    return null;
  }
  // the state's recording section, with what each recorded JVM is doing now
  function record(r) {
    if (!r || !prep()) return r;
    for (const id of Object.keys(P.jvms)) if (r.jvms[id]) r.jvms[id].activities = activities(+id);
    return r;
  }
  return { api, record, now };
})();
