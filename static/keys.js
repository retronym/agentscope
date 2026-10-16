// Keyboard shortcuts, after GitHub's: ? lists them, / searches, g-chords jump to a section, j / k walk the lists
// and o / Enter opens what's selected. Keys typed into a field, with ⌘/Ctrl/Alt held, or already handled (a focused
// flame graph has its own) are left alone.
const Keys = (() => {
  const SECTIONS = { n: 'sec-now', j: 'sec-jvms', t: 'sec-timeline', e: 'sec-ends' };
  const ITEMS = '#cards .card[data-sid], #jvms tr.jr[data-jvm], #jvms tr[data-more], #ends .item';
  const HELP = [
    ['Site-wide', [
      [['?'], 'show this help'],
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
      [['o'], [], ['Enter'], 'open the selection, or show the rest of a list'],
      [['c'], 'continue the session in the Claude app'],
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

  let sel = null, chord = null, chordTimer = null, dlg = null;

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
    sel = null; mark();  // j then starts from the section's first item
    document.getElementById(id)?.scrollIntoView();
  }
  function help() {
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.className = 'keys-help';
      dlg.innerHTML = `<div class="kh-top"><b>Keyboard shortcuts</b><button class="close" title="close (Esc)">✕</button></div><div class="kh-cols">` +
        HELP.map(([h, rows]) => `<div><h3>${esc(h)}</h3><dl>${rows.map(row).join('')}</dl></div>`).join('') + `</div>`;
      dlg.querySelector('.close').onclick = () => dlg.close();
      dlg.onclick = e => { if (e.target === dlg) dlg.close(); };  // the backdrop
      document.body.appendChild(dlg);
    }
    dlg.open ? dlg.close() : dlg.showModal();
  }
  const typing = t => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

  // window, capture phase: ahead of the page's own Esc handlers on document, so Esc closes this help first
  addEventListener('keydown', e => {
    if (dlg?.open) { if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); e.stopImmediatePropagation(); dlg.close(); } return; }
  }, true);
  addEventListener('keydown', e => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || dlg?.open) return;
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
    else if (k === 'o' || k === 'Enter') { const el = mark(); if (!el || e.target.closest?.('a, button')) return; el.click(); }
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
  return { mark, help };
})();
