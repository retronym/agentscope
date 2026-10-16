// Keyboard shortcuts, after GitHub's: ? lists them, / searches, g-chords jump to a section, j / k walk the lists
// and o / Enter opens what's selected; ⌘K jumps to anything by name. Keys typed into a field, with ⌘/Ctrl/Alt held, or already handled (a focused
// flame graph has its own) are left alone.
const Keys = (() => {
  const SECTIONS = { n: 'sec-now', j: 'sec-jvms', t: 'sec-timeline', e: 'sec-ends' };
  const SECTION_NAMES = { n: 'Now', j: 'JVMs', t: 'Timeline', e: 'Loose ends' };
  const ITEMS = '#cards .card[data-sid], #jvms tr.jr[data-jvm], #jvms tr[data-more], #ends .item';
  const HELP = [
    ['Site-wide', [
      [['?'], 'show this help'],
      [['⌘', 'K'], 'jump to a session, JVM or section by name'],
      [['/'], [], ['s'], 'search thread contents'],
      [['f'], 'filter sessions'],
      [['g', 'n'], 'go to Now'],
      [['g', 'j'], 'go to JVMs'],
      [['g', 't'], 'go to Timeline'],
      [['g', 'e'], 'go to Loose ends'],
      [['1'], ['…'], ['4'], 'time range 24h · 3d · 7d · 30d'],
      [['a'], 'show / hide archived sessions'],
    ]],
    ['Lists', [
      [['j'], 'next session, JVM or loose end'],
      [['k'], 'previous'],
      [['o'], [], ['Enter'], 'open the selection (a JVM full size), or show the rest of a list'],
      [['c'], 'continue the session in the Claude app'],
      [['x'], 'JVM: expand the row in place'],
      [['r'], 'JVM: start / stop recording'],
      [['z'], 'fold / unfold the section'],
    ]],
    ['Session panel', [
      [['j'], [], ['k'], 'next / previous session in the lists'],
      [['Esc'], 'close'],
    ]],
    ['Flame graphs', [
      [['?'], 'its own keys, while it has focus'],
    ]],
  ];
  const kbd = k => `<kbd>${esc(k)}</kbd>`;
  // a row is [keys, (or-separator [], keys)…, label]; keys in one array are a chord, pressed one after another
  const row = r => {
    const label = r[r.length - 1], parts = r.slice(0, -1);
    return `<dt>${parts.map(p => !p.length ? '<span class="or">or</span>' : p.length === 1 && p[0] === '…' ? '–' : p.map(kbd).join(' ')).join(' ')}</dt><dd>${esc(label)}</dd>`;
  };

  let sel = null, chord = null, chordTimer = null, dlg = null, pal = null;

  const keyOf = el => el.dataset.sid ? 's:' + el.dataset.sid : el.dataset.jvm ? 'j:' + el.dataset.jvm : el.dataset.more ? 'm:' + el.dataset.more
    : 'e:' + [...$('#ends').querySelectorAll('.panel')].indexOf(el.closest('.panel')) + ':' + (el.getAttribute('onclick') || el.textContent.slice(0, 60));
  const items = () => [...document.querySelectorAll(ITEMS)].filter(el => el.getClientRects().length);
  // after a re-render: the selected element is a new node, so mark it again
  function mark() {
    const all = items();
    let el = sel && all.find(x => keyOf(x) === sel);
    for (const x of document.querySelectorAll('.kbd-sel')) if (x !== el) x.classList.remove('kbd-sel');
    el?.classList.add('kbd-sel');
    return el;
  }
  function move(d) {
    const all = items(); if (!all.length) return;
    const cur = sel && all.findIndex(x => keyOf(x) === sel);
    let i;
    if (cur == null || cur < 0) {  // nothing selected yet: start at the first item on screen
      const hb = document.querySelector('header').getBoundingClientRect().bottom;
      i = all.findIndex(x => x.getBoundingClientRect().bottom > hb);
      if (i < 0) i = 0;
      if (d < 0 && all[i].getBoundingClientRect().top < hb) i = Math.max(0, i - 1);
    } else i = Math.max(0, Math.min(all.length - 1, cur + d));
    sel = keyOf(all[i]);
    const el = mark();
    el.scrollIntoView({ block: 'nearest' });
    if (openSid && opensSession(el)) el.click();  // the panel follows the selection
  }
  const opensSession = el => !!el.dataset.sid || /^openDrawer\(/.test(el.getAttribute('onclick') || '');
  function claude() {
    if (openSid) { const a = $('#dopen'); if (a && a.style.display !== 'none') a.click(); return; }
    const el = mark(), sid = el?.dataset.sid || /^openDrawer\('([^']+)'/.exec(el?.getAttribute('onclick') || '')?.[1], s = sid && S?.sMap[sid];
    if (s && !DEMO && s.local && !s.archived) location.href = `claude://code/continue?session=${encodeURIComponent(s.local)}`;
  }
  function fold() {
    // the selection's section, even once folded away (z again unfolds it)
    const el = sel && [...document.querySelectorAll(ITEMS)].find(x => keyOf(x) === sel), sec = el?.closest('main > section') || [...document.querySelectorAll('main > section')].find(s => s.getBoundingClientRect().bottom > innerHeight / 3);
    sec?.querySelector(':scope > h2')?.click();
  }
  function go(k) {
    const id = SECTIONS[k]; if (!id) return;
    if (openSid) closeDrawer();
    compactHeader(true);  // first, so the section lands under the header's scrolled height
    sel = null; mark();  // j then starts from the section's first item
    document.getElementById(id)?.scrollIntoView();
  }
  function help() {
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.className = 'keys-help';
      dlg.tabIndex = -1;  // focusable itself, so opening doesn't land on (and ring) its close button
      dlg.innerHTML = `<div class="kh-top"><b>Keyboard shortcuts</b><button class="close" title="close (Esc)">✕</button></div><div class="kh-cols">` +
        HELP.map(([h, rows]) => `<div><h3>${esc(h)}</h3><dl>${rows.map(row).join('')}</dl></div>`).join('') + `</div>`;
      dlg.querySelector('.close').onclick = () => dlg.close();
      dlg.onclick = e => { if (e.target === dlg) dlg.close(); };  // the backdrop
      document.body.appendChild(dlg);
    }
    if (dlg.open) return dlg.close();
    dlg.showModal(); dlg.focus();
  }
  // ---------------------------------------------------------------- ⌘K: jump to anything by name, after GitHub's command palette
  // Every term must appear somewhere in an entry; matches in its name rank first, then live sessions, then recent ones.
  let palItems = [], palIdx = 0;
  function palEntries() {
    const out = [];
    for (const s of S?.sessions || []) {
      const st = sessionState(s);
      out.push({ name: s.title, hint: `${s.lane} · ${st.label.replace(/^· /, '')} · ${ago(s.last)}`, kind: 'session', c: st.c,
        hay: [s.lane, s.branch, s.cwd, ...(s.prs || [])].join(' '), rank: s.live ? 2 : s.archived ? 0 : 1, t: s.last || 0, sid: s.sid, run: () => openDrawer(s.sid) });
    }
    for (const j of S?.jvms || []) {
      const s = j.sid && S.sMap[j.sid];
      out.push({ name: `${j.label} ${j.pid}`, hint: s ? `JVM · ${s.title}` : 'JVM · no session', kind: 'jvm', hay: [j.main, s?.lane].join(' '), rank: 1, t: j.start, run: () => openJvmBox(j.id) });
    }
    for (const k of Object.keys(SECTIONS)) {
      out.push({ name: 'Go to ' + SECTION_NAMES[k], hint: 'g ' + k, kind: 'go', hay: '', rank: 3, t: 0, run: () => go(k) });
    }
    out.push({ name: 'Keyboard shortcuts', hint: '?', kind: 'go', hay: 'help keys', rank: 3, t: 0, run: help });
    out.push({ name: (showArchived ? 'Hide' : 'Show') + ' archived sessions', hint: 'a', kind: 'go', hay: '', rank: 3, t: 0, run: () => $('#show-archived').click() });
    RANGES.forEach(([l], i) => out.push({ name: 'Time range ' + l, hint: String(i + 1), kind: 'go', hay: '', rank: 3, t: 0, run: () => $(`#ranges button:nth-child(${i + 1})`).click() }));
    return out;
  }
  function palSearch(q) {
    const all = palEntries(), terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) {  // nothing typed: recently opened sessions, then where you can go
      const recent = crumbs.map(sid => all.find(e => e.sid === sid)).filter(Boolean).map(e => ({ ...e, group: 'Recent sessions' }));
      return recent.concat(all.filter(e => e.kind === 'go').map(e => ({ ...e, group: 'Go to' })));
    }
    const scored = [];
    for (const e of all) {
      const name = e.name.toLowerCase(), hay = name + ' ' + e.hay.toLowerCase();
      if (!terms.every(t => hay.includes(t))) continue;
      const score = terms.reduce((a, t) => a + (name.startsWith(t) ? 3 : new RegExp('\\b' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(name) ? 2 : name.includes(t) ? 1 : 0), 0);
      scored.push([score, e]);
    }
    return scored.sort((a, b) => b[0] - a[0] || b[1].rank - a[1].rank || b[1].t - a[1].t).slice(0, 50).map(x => x[1]);
  }
  // the typed terms, underlined where they occur in a name
  function marked(text, q) {
    const terms = q.split(/\s+/).filter(Boolean).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!terms.length) return esc(text);
    return text.split(new RegExp(`(${terms.join('|')})`, 'gi')).map((p, i) => i % 2 ? `<mark>${esc(p)}</mark>` : esc(p)).join('');
  }
  function palRender() {
    const box = pal.querySelector('.pl-list'), q = pal.querySelector('input').value;
    const icon = e => e.kind === 'session' ? `<i style="background:${e.c}"></i>` : e.kind === 'jvm' ? '☕' : '→';
    box.innerHTML = palItems.length ? palItems.map((e, i) => (e.group && e.group !== palItems[i - 1]?.group ? `<div class="pl-g">${esc(e.group)}</div>` : '') +
      `<div class="pl-i ${i === palIdx ? 'on' : ''}" data-i="${i}"><span class="pl-k">${icon(e)}</span><span class="pl-n">${marked(e.name, q)}</span><span class="when">${e.kind === 'go' ? e.hint.split(' ').map(kbd).join(' ') : esc(e.hint)}</span></div>`).join('')
      : '<div class="empty" style="padding:8px 12px">nothing matches</div>';
    box.querySelector('.pl-i.on')?.scrollIntoView({ block: 'nearest' });
  }
  // closing hands focus back to where it was (say the filter box); after a jump the keys should drive the page instead
  function palRun(i) { const e = palItems[i]; if (!e) return; pal.close(); document.activeElement?.blur(); e.run(); }
  function palette() {
    if (!pal) {
      pal = document.createElement('dialog');
      pal.className = 'palette';
      pal.innerHTML = `<div class="pl-top"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="7" cy="7" r="5"/><path d="M11 11l3.5 3.5" stroke-linecap="round"/></svg>` +
        `<input type="text" placeholder="Jump to a session, JVM or section…" autocomplete="off" spellcheck="false" aria-label="Jump to"></div><div class="pl-list" role="listbox"></div>` +
        `<div class="pl-foot"><span><kbd>↑</kbd><kbd>↓</kbd> to move</span><span><kbd>↵</kbd> to open</span><span><kbd>esc</kbd> to close</span></div>`;
      const inp = pal.querySelector('input');
      inp.oninput = () => { palItems = palSearch(inp.value); palIdx = 0; palRender(); };
      inp.onkeydown = e => {
        const d = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n') ? 1 : e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p') ? -1 : 0;
        if (d) { e.preventDefault(); palIdx = Math.max(0, Math.min(palItems.length - 1, palIdx + d)); palRender(); }
        else if (e.key === 'Enter') { e.preventDefault(); palRun(palIdx); }
      };
      pal.onclick = e => { const it = e.target.closest('.pl-i'); if (it) palRun(+it.dataset.i); else if (e.target === pal) pal.close(); };
      pal.onmousemove = e => { const it = e.target.closest('.pl-i'); if (it && +it.dataset.i !== palIdx) { palIdx = +it.dataset.i; for (const x of pal.querySelectorAll('.pl-i')) x.classList.toggle('on', x === it); } };
      document.body.appendChild(pal);
    }
    if (pal.open) return pal.close();
    if (dlg?.open) dlg.close();
    const inp = pal.querySelector('input');
    inp.value = ''; palItems = palSearch(''); palIdx = 0;
    pal.showModal(); palRender(); inp.focus();
  }

  const typing = t => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

  // window, capture phase: ahead of the page's own Esc handlers on document, so Esc closes this help first
  addEventListener('keydown', e => {
    if (e.key === 'k' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) { e.preventDefault(); e.stopImmediatePropagation(); palette(); return; }
    if (dlg?.open && (e.key === 'Escape' || e.key === '?')) { e.preventDefault(); e.stopImmediatePropagation(); dlg.close(); }
    else if (pal?.open && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); pal.close(); }
  }, true);
  addEventListener('keydown', e => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || dlg?.open || pal?.open) return;
    const k = e.key;
    if (chord) {
      const c = chord; chord = null; clearTimeout(chordTimer);
      if (c === 'g' && SECTIONS[k]) { e.preventDefault(); go(k); }
      return;
    }
    if (k === 'g') { chord = 'g'; chordTimer = setTimeout(() => chord = null, 1500); return; }
    if (k === '?') help();
    else if (k === '/' || k === 's') { $('#tq').focus(); $('#tq').select(); }
    else if (k === 'f') { $('#q').focus(); $('#q').select(); }
    else if (k === 'j') move(1);
    else if (k === 'k') move(-1);
    else if (k === 'o' || k === 'Enter') { const el = mark(); if (!el || e.target.closest?.('a, button')) return; el.dataset.jvm ? openJvmBox(+el.dataset.jvm) : el.click(); }
    else if (k === 'x') { const el = mark(); if (el?.dataset.jvm) toggleJvm(+el.dataset.jvm); else if (el?.dataset.more) el.click(); else return; }
    else if (k === 'r') { const b = mark()?.querySelector('.recbtn'); if (b && !b.disabled) b.click(); else return; }
    else if (k === 'c') claude();
    else if (k === 'z') fold();
    else if (k === 'a') $('#show-archived').click();
    else if (k >= '1' && k <= '4') $(`#ranges button:nth-child(${k})`)?.click();
    else return;
    e.preventDefault();
  });
  // the lists re-render on every refresh (and the JVM table on its own); keep the selection marked on the new nodes
  let pending = false;
  addEventListener('DOMContentLoaded', () => {
    const mo = new MutationObserver(() => { if (!pending) { pending = true; queueMicrotask(() => { pending = false; mark(); }); } });
    for (const id of ['cards', 'jvms', 'ends']) mo.observe(document.getElementById(id), { childList: true, subtree: true });
  });
  return { mark, help, palette };
})();
