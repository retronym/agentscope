// A flame graph component: one per key (a JVM's profile, 'all', a capture), state kept across data refreshes.
// Data is the server's tree, [name, value, children, label?, before?]; everything else happens here, on a copy:
//   semantic zoom (click a frame; breadcrumb and ancestor bars to zoom out), visual zoom (Ctrl/⌘+scroll or pinch at the
//   cursor, +/−, Shift+drag a range, Shift+scroll to pan), search (regex/case, N/Shift+N), highlight chips, and a stack
//   of filters (keep, hide, hide one stack, merge a function away, focus on a function), each removable, all re-applied
//   to the original data. Right-click a frame for every action; ? for the keys.
// Uses the page's globals (esc, tip, hideTip, css) and profile.js's (frameColor, shortName).

const Flame = (() => {
  const ROW = 17, SEARCH_COLOR = '#ff6fae', HL_COLORS = ['#f2c94c', '#56ccf2', '#bb6bd9', '#6fcf97', '#f2994a', '#eb5757', '#2d9cdb', '#9b51e0'];
  const views = {};  // key -> view state

  // ---------------------------------------------------------------- trees: {n, v, b, k, m}: name, value, value before (diffs), kids, label level
  const fromArr = a => ({ n: a[0], v: a[1], k: (a[2] || []).map(fromArr), m: a.length > 3 && a[3] === 1, b: a.length > 4 ? a[4] : undefined });
  const sum = (ks, f) => ks.reduce((s, c) => s + (f(c) || 0), 0);
  const clone = n => ({ ...n, k: n.k.map(clone) });

  function mergeSiblings(list) {
    const by = new Map();
    for (const c of list) {
      const key = c.n + (c.m ? '\u0001' : '');
      const o = by.get(key);
      if (!o) by.set(key, { ...c, k: c.k.slice() });
      else { o.v += c.v; if (c.b !== undefined) o.b = (o.b || 0) + c.b; o.k = o.k.concat(c.k); }
    }
    const out = [...by.values()];
    for (const o of out) o.k = mergeSiblings(o.k);
    return out.sort((x, y) => y.v - x.v);
  }
  // keep only stacks with a frame matching t (the root is a label, never tested)
  function keep(n, t, inside, isRoot) {
    if (!isRoot && (inside || t(n))) return clone(n);
    const k = n.k.map(c => keep(c, t, false, false)).filter(Boolean);
    if (!k.length && !isRoot) return null;
    return { ...n, v: sum(k, c => c.v), b: n.b === undefined ? undefined : sum(k, c => c.b), k };
  }
  // drop stacks with a frame matching t
  function hide(n, t, isRoot) {
    if (!isRoot && t(n)) return null;
    const k = n.k.map(c => hide(c, t, false)).filter(Boolean);
    const self = n.v - sum(n.k, c => c.v), selfB = n.b === undefined ? undefined : n.b - sum(n.k, c => c.b);
    const v = self + sum(k, c => c.v);
    if (v <= 0 && !isRoot) return null;
    return { ...n, v, b: selfB === undefined ? undefined : selfB + sum(k, c => c.b), k };
  }
  // drop one exact stack (the subtree at a path of names below the root)
  function hidePath(n, path, i = 0) {
    if (i === path.length) return null;
    const k = n.k.map(c => c.n === path[i] ? hidePath(c, path, i + 1) : c).filter(Boolean);
    const gone = n.k.find(c => c.n === path[i]);
    const kept = k.find(c => c.n === path[i]);
    const dv = (gone ? gone.v : 0) - (kept ? kept.v : 0), db = (gone && gone.b !== undefined ? gone.b : 0) - (kept && kept.b !== undefined ? kept.b : 0);
    return { ...n, v: n.v - dv, b: n.b === undefined ? undefined : n.b - db, k };
  }
  // splice frames matching t out of every stack: their children move up to their parent
  function merge(n, t) {
    const k = [];
    for (const c of n.k) {
      if (!c.m && t(c)) { const mc = merge(c, t); k.push(...mc.k); }
      else k.push(merge(c, t));
    }
    return { ...n, k: mergeSiblings(k) };
  }
  // a new root over every outermost occurrence of frames matching t, merged
  function focus(root, t) {
    const hits = [];
    (function walk(n) { for (const c of n.k) { if (!c.m && t(c)) hits.push(clone(c)); else walk(c); } })(root);
    const k = mergeSiblings(hits);
    return { n: root.n, v: sum(k, c => c.v), b: root.b === undefined ? undefined : sum(k, c => c.b), k, m: false };
  }
  function matcher(src, regex, caseSensitive) {
    try { const re = new RegExp(regex ? src : src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? '' : 'i'); return n => !n.m && re.test(n.n); }
    catch (e) { return null; }
  }
  const exact = name => n => !n.m && n.n === name;

  // ---------------------------------------------------------------- view state
  function view(key) {
    return views[key] ||= { key, base: null, tree: null, data: null, ops: [], hl: [], search: '', regex: false, cs: false, path: [], zf: 1, pan: 0,
      icicle: true, longNames: false, nav: [], navIdx: -1, help: false, menu: null };
  }
  function apply(v) {
    let t = v.base;
    for (const op of v.ops) {
      const m = op.test;
      t = op.op === 'keep' ? keep(t, m, false, true) : op.op === 'hide' ? hide(t, m, true) : op.op === 'hidepath' ? hidePath(t, op.path)
        : op.op === 'merge' ? merge(t, m) : op.op === 'focus' ? focus(t, m) : t;
      t ||= { n: v.base.n, v: 0, k: [] };
    }
    v.tree = t;
    v.root = zoomRoot(v);
  }
  // Zooming: set the path, reveal the new root, and ask the host for detail below it (the server prunes small nodes
  // relative to the whole graph, except along and below the zoom path).
  function zoomTo(v, path) {
    v.path = path; v.zf = 1; v.pan = 0; v.root = zoomRoot(v);
    v.reveal = true;
    clearTimeout(v.zoomT);
    v.zoomT = setTimeout(() => v.opts?.onZoom?.(v.path.slice()), 150);
  }
  // the zoom root: the deepest node along the zoom path that still exists after filtering
  function zoomRoot(v) {
    let n = v.tree, anc = [];
    for (let i = 0; i < v.path.length; i++) {
      const c = n.k.find(c => c.n === v.path[i]);
      if (!c) { v.path = v.path.slice(0, i); break; }
      anc.push(n); n = c;
    }
    v.anc = anc;
    return n;
  }

  // ---------------------------------------------------------------- public: (re)mount and draw
  function show(key, el, data, opts) {
    const v = view(key);
    v.opts = opts;
    if (v.data !== data) { v.data = data; v.base = fromArr(data.root); v.diff = !!data.diff; v.total = data.total; v.beforeTotal = data.before_total; apply(v); }
    if (el.dataset.fg !== key || !el.querySelector('canvas')) mount(v, el);
    v.el = el;
    toolbar(v);
    draw(v);
  }

  function mount(v, el) {
    el.dataset.fg = v.key;
    el.tabIndex = 0;
    el.innerHTML = `<div class="fg-bar"></div><div class="fg-chips"></div><div class="fg-crumbs"></div><div class="flamewrap"><canvas></canvas><div class="fg-sel"></div></div><div class="fg-pop" hidden></div>`;
    const c = el.querySelector('canvas');
    el.onkeydown = e => keys(v, e);
    c.onmousemove = e => hover(v, e);
    c.onmouseleave = () => { hideTip(); v.hover = null; };
    c.onmousedown = e => down(v, e);
    c.onclick = e => click(v, e);
    c.oncontextmenu = e => { e.preventDefault(); menu(v, e); };
    c.onwheel = e => wheel(v, e);
    el.addEventListener('mouseenter', () => { v.inside = true; });
    el.addEventListener('mouseleave', () => { v.inside = false; });
  }

  // ---------------------------------------------------------------- toolbar, chips, breadcrumb
  function toolbar(v) {
    const el = v.el, o = v.opts;
    const matched = v.search ? searchStats(v) : null;
    const bar = `<span class="fg-title">${o.titleHtml || ''}</span>
      ${o.onReverse ? `<span class="seg" title="Callers first (top-down), or where the time is spent first (reversed, bottom-up)">${[[false, '↓ top-down'], [true, '↑ reversed']].map(([r, l]) => `<button class="${!!o.reverse === r ? 'on' : ''}" data-act="reverse" data-arg="${r}">${l}</button>`).join('')}</span>` : ''}
      <span class="fg-search"><input type="search" placeholder="search frames…  (⌘F)" value="${esc(v.search)}" spellcheck="false">
        <button class="fg-t ${v.regex ? 'on' : ''}" data-act="regex" title="regular expression">.*</button><button class="fg-t ${v.cs ? 'on' : ''}" data-act="case" title="case sensitive">Aa</button>
        ${matched ? `<span class="fg-match">${matched}</span><button data-act="prev" title="previous match (Shift+N)">‹</button><button data-act="next" title="next match (N)">›</button>
          <button data-act="hl" title="keep highlighting this (Enter)">Highlight</button><button data-act="keep" title="keep only stacks through matches">Keep</button><button data-act="hide" title="hide stacks through matches">Hide</button>` : ''}</span>
      <span class="fg-zoom"><button data-act="zout" title="zoom out (−)">−</button><span class="fg-zf" title="horizontal zoom">${Math.round(v.zf * 100)}%</span><button data-act="zin" title="zoom in (=)">+</button>
        <button data-act="z1" ${v.zf === 1 && !v.path.length ? 'disabled' : ''} title="reset zoom (0)">1:1</button></span>
      <button class="fg-t" data-act="flip" title="flip: icicle (root on top) or flame (root at the bottom) (I)">${v.icicle ? '⬇' : '⬆'}</button>
      <button class="fg-t ${v.longNames ? 'on' : ''}" data-act="names" title="full class names">pkg</button>
      <button class="fg-t" data-act="help" title="keys and gestures (?)">?</button>`;
    const barEl = el.querySelector('.fg-bar');
    const active = document.activeElement, typing = active && barEl.contains(active) && active.tagName === 'INPUT';
    if (!typing || barEl.dataset.html === undefined) { if (barEl.dataset.html !== bar) { barEl.innerHTML = bar; barEl.dataset.html = bar; } }
    else {  // don't rebuild the input under the user's fingers: just refresh what's beside it
      const m = barEl.querySelector('.fg-match'); if (m && matched) m.textContent = matched.replace(/<[^>]+>/g, '');
    }
    wireBar(v, barEl);
    const chips = [...v.ops.map((op, i) => `<span class="fg-chip fg-op"><b>${op.op === 'hidepath' ? 'hide stack' : op.op}</b> ${esc(op.label)}<a data-act="unop" data-arg="${i}" title="remove this filter">×</a></span>`),
      ...v.hl.map((h, i) => `<span class="fg-chip" style="--c:${h.color}"><i></i>${esc(h.label)}<a data-act="unhl" data-arg="${i}" title="remove highlight">×</a></span>`)];
    const chipHtml = chips.length ? chips.join('') + (v.ops.length ? `<button class="btn-link" data-act="restore" title="remove every filter">Restore all</button>` : '') : '';
    const ch = el.querySelector('.fg-chips');
    if (ch.dataset.html !== chipHtml) { ch.innerHTML = chipHtml; ch.dataset.html = chipHtml; }
    ch.hidden = !chipHtml;
    const crumbs = v.path.length ? `<a data-act="zpath" data-arg="0">all</a>` + v.path.map((p, i) => ` › <a data-act="zpath" data-arg="${i + 1}" title="${esc(p)}">${esc(label(v, p))}</a>`).join('') : '';
    const cr = el.querySelector('.fg-crumbs');
    if (cr.dataset.html !== crumbs) { cr.innerHTML = crumbs; cr.dataset.html = crumbs; }
    cr.hidden = !crumbs;
    for (const box of [ch, cr]) box.onclick = e => { const a = e.target.closest('[data-act]'); if (a) act(v, a.dataset.act, a.dataset.arg); };
    const pop = el.querySelector('.fg-pop');
    pop.hidden = !v.help;
    if (v.help && !pop.dataset.html) { pop.innerHTML = HELP; pop.dataset.html = 1; }
  }
  function wireBar(v, barEl) {
    barEl.onclick = e => { const a = e.target.closest('[data-act]'); if (a) { e.preventDefault(); act(v, a.dataset.act, a.dataset.arg); } };
    const inp = barEl.querySelector('input');
    inp.oninput = () => { v.search = inp.value; v.navIdx = -1; draw(v); toolbar(v); };
    inp.onkeydown = e => {
      if (e.key === 'Enter') { e.preventDefault(); act(v, e.shiftKey ? 'keep' : 'hl'); }
      else if (e.key === 'Escape') { e.stopPropagation(); inp.value = v.search = ''; draw(v); toolbar(v); v.el.focus(); }
      e.stopPropagation();
    };
  }
  const HELP = `<dl>
    <dt>Click</dt><dd>zoom into a frame</dd><dt>Right-click</dt><dd>every action on a frame: focus, merge, keep, hide, highlight, copy</dd>
    <dt>Ctrl/Alt+click</dt><dd>hide that stack</dd><dt>Shift+drag</dt><dd>zoom to a range</dd>
    <dt>Ctrl/⌘+scroll, pinch</dt><dd>zoom at the cursor</dd><dt>Shift+scroll</dt><dd>pan when zoomed</dd>
    <dt>= / −</dt><dd>zoom in / out</dd><dt>0</dt><dd>reset zoom</dd><dt>Backspace</dt><dd>up one level</dd>
    <dt>⌘F or /</dt><dd>search (regex with .*)</dd><dt>Enter</dt><dd>keep the search as a highlight; Shift+Enter: keep only matches</dd>
    <dt>N / Shift+N</dt><dd>next / previous match</dd><dt>I</dt><dd>flip icicle / flame</dd><dt>Esc</dt><dd>close search or this help</dd></dl>`;

  function act(v, a, arg) {
    const term = v.search;
    switch (a) {
      case 'reverse': v.opts.onReverse?.(arg === 'true'); v.path = []; v.zf = 1; v.pan = 0; return;
      case 'regex': v.regex = !v.regex; break;
      case 'case': v.cs = !v.cs; break;
      case 'next': case 'prev': return step(v, a === 'next' ? 1 : -1);
      case 'hl': { const t = matcher(term, v.regex, v.cs); if (t && term) { v.hl.push({ label: term, test: t, color: HL_COLORS[v.hl.length % HL_COLORS.length] }); v.search = ''; } break; }
      case 'keep': case 'hide': { const t = matcher(term, v.regex, v.cs); if (t && term) { v.ops.push({ op: a, label: term, test: t }); v.search = ''; apply(v); } break; }
      case 'unop': v.ops.splice(+arg, 1); apply(v); break;
      case 'unhl': v.hl.splice(+arg, 1); break;
      case 'restore': v.ops = []; apply(v); break;
      case 'zin': return zoomBy(v, 1.5, 0.5);
      case 'zout': return zoomBy(v, 1 / 1.5, 0.5);
      case 'z1': zoomTo(v, []); break;
      case 'zpath': zoomTo(v, v.path.slice(0, +arg)); break;
      case 'flip': v.icicle = !v.icicle; break;
      case 'names': v.longNames = !v.longNames; break;
      case 'help': v.help = !v.help; break;
    }
    toolbar(v); draw(v);
  }

  // ---------------------------------------------------------------- search
  function searchTest(v) { return v.search ? matcher(v.search, v.regex, v.cs) : null; }
  function searchStats(v) {
    const t = searchTest(v); if (!t) return '<span class="err">bad pattern</span>';
    let hit = 0;
    (function walk(n) { for (const c of n.k) { if (t(c)) hit += c.v; else walk(c); } })(v.root);
    const of = x => v.root.v ? (x / v.root.v * 100).toFixed(1) + '%' : '–';
    const all = v.ops.length && v.base.v ? ` (${(hit / v.base.v * 100).toFixed(1)}% of all)` : '';
    return `${of(hit)} matched${all}`;
  }
  // N / Shift+N: zoom to the next outermost match, in left-to-right order
  function step(v, d) {
    const t = searchTest(v); if (!t) return;
    const hits = [];
    (function walk(n, path) { for (const c of n.k) { const p = path.concat(c.n); if (t(c)) hits.push(p); else walk(c, p); } })(v.tree, []);
    if (!hits.length) return;
    v.navIdx = (v.navIdx + d + hits.length) % hits.length;
    zoomTo(v, hits[v.navIdx]);
    toolbar(v); draw(v);
  }

  // ---------------------------------------------------------------- zoom
  function zoomBy(v, factor, at) {  // at: 0..1 across the canvas
    const before = v.pan + at / v.zf;
    v.zf = Math.min(1e4, Math.max(1, v.zf * factor));
    v.pan = v.zf === 1 ? 0 : Math.max(0, Math.min(1 - 1 / v.zf, before - at / v.zf));
    toolbar(v); draw(v);
  }
  function wheel(v, e) {
    const c = e.currentTarget, at = (e.clientX - c.getBoundingClientRect().left) / c.clientWidth;
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomBy(v, Math.exp(-e.deltaY * 0.01), at); }
    else if (v.zf > 1 && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))) {
      e.preventDefault();
      v.pan = Math.max(0, Math.min(1 - 1 / v.zf, v.pan + (e.deltaX || e.deltaY) / c.clientWidth / v.zf));
      draw(v);
    }
  }

  // ---------------------------------------------------------------- drawing
  function label(v, name) { return v.longNames ? name : shortName(name); }
  function nodeColor(v, n, dark) {
    if (n.m) return dark ? '#8a877e' : '#d9d6cb';
    if (v.diff) {
      const a = n.v / Math.max(1, v.total), b = (n.b || 0) / Math.max(1, v.beforeTotal), r = (a - b) / Math.max(a, b, 1e-9);
      const l = (dark ? 62 : 82) - 28 * Math.min(1, Math.abs(r));
      return Math.abs(r) < 0.05 ? (dark ? '#77756f' : '#d9d6cb') : r > 0 ? `hsl(4, 75%, ${l}%)` : `hsl(215, 70%, ${l}%)`;
    }
    return frameColor(n.n, dark);
  }
  function draw(v) {
    const el = v.el; if (!el) return;
    const c = el.querySelector('canvas'), W = c.clientWidth || c.parentElement.clientWidth;
    if (!W) return;
    const R = v.root, A = v.anc.length;
    let depth = 0;
    (function d(n, k) { if (k > depth) depth = k; for (const c of n.k) d(c, k + 1); })(R, 1);
    const rows = A + depth, H = Math.max(ROW * 2, rows * ROW + 2), dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    c.style.height = H + 'px';
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    g.font = '11px ' + css('--font-ui'); g.textBaseline = 'middle';
    const dark = matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light';
    const yOf = row => v.icicle ? row * ROW : H - (row + 1) * ROW;
    const st = searchTest(v), hls = v.hl, dimming = !!(st || hls.length);
    v.rects = [];
    // A match takes its highlight's colour; frames beneath a match keep their own colour but aren't dimmed (they're
    // part of the matched stacks); everything else dims while a search or highlight is active.
    const paint = (n, row, x, w, underMatch) => {
      const y = yOf(row);
      let own = null;
      if (!n.m) {
        const h = hls.find(h => h.test(n)); if (h) own = h.color;
        if (st && st(n)) own = SEARCH_COLOR;  // the live search, apart from every highlight chip's colour
      }
      g.globalAlpha = dimming && !own && !underMatch && !n.m ? 0.28 : 1;
      g.fillStyle = own || nodeColor(v, n, dark);
      g.fillRect(x, y, Math.max(0.5, w - 0.5), ROW - 1);
      g.globalAlpha = 1;
      if (w > 28) { g.fillStyle = '#1b1b1a'; g.fillText(fit(g, n === v.tree ? 'all' : n.m ? n.n : label(v, n.n), w - 6), x + 3, y + ROW / 2); }
      v.rects.push([x, y, w, n, row]);
      return !!own || underMatch;
    };
    // the zoom root's ancestors, full width: context, and a click away from zooming out
    v.anc.forEach((n, i) => { paint(n, i, 0, W, true); v.rects[v.rects.length - 1].push('anc', i); });
    const scale = W * v.zf / Math.max(1, R.v), off = v.pan * W * v.zf;
    const walk = (n, row, x0, underMatch) => {
      const x = x0 * scale - off, w = n.v * scale;
      if (x > W || x + w < 0 || w < 0.4) return;
      const m = paint(n, row, x, w, underMatch);
      let cx = x0;
      for (const c of n.k) { walk(c, row + 1, cx, m); cx += c.v; }
    };
    walk(R, A, 0, false);
    if (v.reveal) {  // after a zoom: the root (with a row of context above it) in view, in the graph's box and the page
      v.reveal = false;
      const wrap = c.parentElement, y = yOf(A);
      wrap.scrollTop = v.icicle ? Math.max(0, y - ROW * 2) : Math.max(0, y - wrap.clientHeight + ROW * 3);
      const b = v.el.getBoundingClientRect();
      if (b.top < 0 || b.top > innerHeight - 120) v.el.scrollIntoView({ block: 'nearest' });
    }
    if (!R.v) { g.fillStyle = css('--muted'); g.fillText('nothing left after the filters', 4, yOf(A) + ROW / 2); }
  }

  // ---------------------------------------------------------------- pointer
  function at(v, e) {
    const b = e.currentTarget.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
    for (let i = v.rects.length - 1; i >= 0; i--) { const r = v.rects[i]; if (x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + ROW) return r; }
    return null;
  }
  function pathTo(v, r) {  // names from the root down to a drawn node
    if (r[5] === 'anc') return v.path.slice(0, r[6]);
    const target = r[3], out = v.path.slice();
    (function find(n, p) { if (n === target) { out.push(...p); return true; } for (const c of n.k) if (find(c, p.concat(c.n))) return true; return false; })(v.root, []);
    return out;
  }
  function hover(v, e) {
    const c = e.currentTarget;
    if (v.drag) return;
    const r = at(v, e);
    c.style.cursor = e.shiftKey ? 'crosshair' : r && (e.ctrlKey || e.altKey) && r[3] !== v.tree ? 'no-drop' : r ? 'pointer' : 'default';
    if (!r) { hideTip(); return; }
    const n = r[3], u = v.opts.unit || (x => x), parent = findParent(v, n);
    const pc = (x, of) => of ? (x / of * 100).toFixed(1) + '%' : '–';
    const self = n.v - sum(n.k, k => k.v);
    tip(e, `<div class="tt" style="word-break:break-all">${esc(n.n)}</div>
      <div class="tm">${esc(u(n.v))} · ${pc(n.v, v.base.v)} of all${v.root !== v.tree ? ` · ${pc(n.v, v.root.v)} of view` : ''}${parent ? ` · ${pc(n.v, parent.v)} of parent` : ''}</div>
      ${self > 0 && n.k.length ? `<div class="tm">self ${esc(u(self))}</div>` : ''}
      ${v.diff ? `<div class="tm">before: ${esc(u(n.b || 0))} · ${pc(n.b || 0, v.beforeTotal)} of all</div>` : ''}
      <div class="tm" style="margin-top:3px">click: zoom · right-click: more</div>`);
  }
  function findParent(v, target) {
    let found = null;
    (function f(n) { for (const c of n.k) { if (c === target) { found = n; return true; } if (f(c)) return true; } return false; })(v.tree);
    return found;
  }
  function click(v, e) {
    if (v.dragged) { v.dragged = false; return; }
    const r = at(v, e); if (!r) return;
    v.menu = null; closeMenu();
    if ((e.ctrlKey || e.altKey) && r[3] !== v.tree && !r[3].m) {
      const p = pathTo(v, r);
      v.ops.push({ op: 'hidepath', label: p.map(x => label(v, x)).slice(-2).join(' › '), path: p });
      apply(v);
    } else {
      zoomTo(v, pathTo(v, r));
    }
    toolbar(v); draw(v);
  }
  // Shift+drag: a box to zoom the horizontal range
  function down(v, e) {
    if (!e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    const c = e.currentTarget, b = c.getBoundingClientRect(), sel = v.el.querySelector('.fg-sel'), x0 = e.clientX - b.left;
    v.drag = true;
    const move = ev => { const x1 = ev.clientX - b.left; sel.style.cssText = `display:block;left:${Math.min(x0, x1)}px;width:${Math.abs(x1 - x0)}px;top:0;height:${c.clientHeight}px`; };
    const up = ev => {
      removeEventListener('mousemove', move); removeEventListener('mouseup', up);
      sel.style.display = 'none'; v.drag = false;
      const x1 = ev.clientX - b.left, a = Math.min(x0, x1) / c.clientWidth, z = Math.max(x0, x1) / c.clientWidth;
      if (z - a > 0.005) {
        const from = v.pan + a / v.zf, to = v.pan + z / v.zf;
        v.zf = Math.min(1e4, 1 / (to - from)); v.pan = Math.max(0, Math.min(1 - 1 / v.zf, from));
        v.dragged = true; toolbar(v); draw(v);
      }
    };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  }

  // ---------------------------------------------------------------- context menu
  let menuEl = null;
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
  addEventListener('mousedown', e => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }, true);
  function menu(v, e) {
    const r = at(v, e); closeMenu(); if (!r) return;
    const n = r[3], isFrame = n !== v.tree && !n.m, name = n.n, short = label(v, name);
    const items = [
      ['zoom', 'Zoom to this frame', true],
      ['focus', `Focus on ${short}: every call, merged`, isFrame],
      ['merge', `Merge ${short} away (its callees move up)`, isFrame],
      ['keepfn', `Keep only stacks through ${short}`, isFrame],
      ['hidefn', `Hide stacks through ${short}`, isFrame],
      ['hidestack', 'Hide this stack', isFrame],
      ['hlfn', `Highlight ${short}`, isFrame],
      ['copy', 'Copy frame name', true],
    ].filter(x => x[2]);
    menuEl = document.createElement('div');
    menuEl.className = 'fg-menu';
    menuEl.innerHTML = items.map(([k, l]) => `<div data-k="${k}">${esc(l)}</div>`).join('');
    menuEl.style.left = Math.min(e.clientX, innerWidth - 320) + 'px'; menuEl.style.top = Math.min(e.clientY, innerHeight - 30 * items.length - 10) + 'px';
    document.body.appendChild(menuEl);
    menuEl.onclick = ev => {
      const k = ev.target.dataset.k; if (!k) return;
      closeMenu(); hideTip();
      const t = exact(name);
      if (k === 'zoom') zoomTo(v, pathTo(v, r));
      else if (k === 'focus') { v.ops.push({ op: 'focus', label: short, test: t }); v.path = []; apply(v); }
      else if (k === 'merge') { v.ops.push({ op: 'merge', label: short, test: t }); apply(v); }
      else if (k === 'keepfn') { v.ops.push({ op: 'keep', label: short, test: t }); apply(v); }
      else if (k === 'hidefn') { v.ops.push({ op: 'hide', label: short, test: t }); apply(v); }
      else if (k === 'hidestack') { const p = pathTo(v, r); v.ops.push({ op: 'hidepath', label: p.map(x => label(v, x)).slice(-2).join(' › '), path: p }); apply(v); }
      else if (k === 'hlfn') v.hl.push({ label: short, test: t, color: HL_COLORS[v.hl.length % HL_COLORS.length] });
      else if (k === 'copy') navigator.clipboard?.writeText(name);
      toolbar(v); draw(v);
    };
  }

  // ---------------------------------------------------------------- keys (when the flame graph has focus or the pointer)
  function keys(v, e) {
    if (e.target.tagName === 'INPUT') return;
    const inp = v.el.querySelector('.fg-bar input');
    if ((e.key === 'f' && (e.metaKey || e.ctrlKey)) || e.key === '/') { e.preventDefault(); e.stopPropagation(); inp.focus(); inp.select(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (k === '=' || k === '+') zoomBy(v, 1.5, 0.5);
    else if (k === '-' || k === '_') zoomBy(v, 1 / 1.5, 0.5);
    else if (k === '0') act(v, 'z1');
    else if (k === 'Backspace') { if (v.path.length) act(v, 'zpath', v.path.length - 1); }
    else if (k === 'n') step(v, 1);
    else if (k === 'N') step(v, -1);
    else if (k === 'i' || k === 'I') act(v, 'flip');
    else if (k === '?') act(v, 'help');
    else if (k === 'Escape' && (v.help || menuEl)) { v.help = false; closeMenu(); toolbar(v); }
    else return;
    e.preventDefault(); e.stopPropagation();
  }
  // ⌘F with the pointer over a flame graph searches it rather than the page
  addEventListener('keydown', e => {
    if (!(e.key === 'f' && (e.metaKey || e.ctrlKey))) return;
    const v = Object.values(views).find(v => v.inside && v.el && document.contains(v.el));
    if (!v) return;
    e.preventDefault();
    const inp = v.el.querySelector('.fg-bar input'); inp.focus(); inp.select();
  });

  return { show, views, act: (key, a, arg) => act(views[key], a, arg), redraw: key => { const v = views[key]; if (v?.el && document.contains(v.el)) draw(v); } };
})();
