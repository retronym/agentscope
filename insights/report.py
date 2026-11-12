#!/usr/bin/env python3
"""The retrospective as one markdown file, from the same insights.json the page reads.

    python3 -m insights.report            # -> ~/.cache/agentscope/insights/REPORT.md
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import agentscope as A  # noqa: E402

OUT = os.path.join(A.CACHE, "insights")
SECTIONS = [("patterns", "Patterns"), ("friction", "Friction points"), ("research_ideas", "Research ideas"), ("lost_ideas", "Lost ideas"),
            ("last_mile", "Last mile needed"), ("loose_ends", "Loose ends")]


def main():
    d = json.load(open(os.path.join(OUT, "insights.json")))
    sess = {s["sid"][:8]: s for s in d["sessions"]}
    threads = {t["id"]: t for t in d["threads"]}
    s = d["stats"]
    day = lambda t: time.strftime("%-d %b", time.localtime(t))
    o = [f"# Retrospective: {d['since']} to {time.strftime('%Y-%m-%d', time.localtime(d['generated']))}", "",
         f"{s['sessions']} sessions, {s['active_hours']} h of agent-active time, {s['prompts']:,} prompts, about ${s['cost']:,} API-equivalent. "
         f"{s['threads']} threads of work; {s['prs_opened']} PRs opened, {s['prs_merged']} merged, {s['prs_open']} still open. "
         f"{s['interrupts']} interrupts, {s['corrections']} corrections, {s['denials']} permission denials, {s['compactions']} context compactions.", "",
         d.get("narrative", ""), "", "## Themes and threads", ""]
    for th in d["themes"]:
        ts = [t for t in d["threads"] if t["theme"] == th["id"]]
        o += [f"### {th['title']}", "", f"{th['summary']} ({len(ts)} threads, {sum(t['active_min'] for t in ts) // 60} h, ${sum(t['cost'] for t in ts):,})", ""]
        for t in sorted(ts, key=lambda t: -t["active_min"]):
            par = ", ".join(threads[p]["title"] for p in t.get("parents", []) if p in threads)
            o.append(f"- **{t['title']}** ({t['status']}; {day(t['first'])} to {day(t['last'])}; {len(t['sessions'])} sessions, {t['active_min'] // 60} h). "
                     f"{t['summary']}{' Grew out of: ' + par + '.' if par else ''}")
        o.append("")
    for key, label in SECTIONS:
        items = d["sections"].get(key) or []
        if not items:
            continue
        o += [f"## {label}", ""]
        for i, it in enumerate(items, 1):
            tags = ", ".join(f"{k}: {it[k]}" for k in ("kind", "type", "count", "impact", "effort", "blocked_on", "by") if it.get(k))
            o.append(f"### {i}. {it['title']}")
            o.append(f"*{tags}*" if tags else "")
            for k, lab in (("body", ""), ("exists", "**Exists:** "), ("why", "**Why:** "), ("missing", "**Missing:** "), ("fix", "**Fix:** "),
                           ("next_step", "**Next:** "), ("action", "**Action:** ")):
                if it.get(k):
                    o += ["", lab + it[k]]
            ev = []
            for e in it.get("evidence") or []:
                if isinstance(e, dict):
                    se = sess.get(str(e.get("sid", ""))[:8])
                    ev.append(("> " + e["quote"].replace("\n", " ") if e.get("quote") else "> ") +
                              (f" ({se['title'][:60]}, {day(se['first'])}, `{se['sid'][:8]}`)" if se else "") + (f" {e['pr']}" if e.get("pr") else ""))
            if it.get("threads"):
                o += ["", "Threads: " + "; ".join(threads[t]["title"] for t in it["threads"] if t in threads)]
            o += [""] + ev + [""]
    inf = d.get("infra") or {}
    if inf.get("nodes"):
        o += ["## Dev infra map", ""]
        for layer in inf.get("layers", []):
            o += [f"### {layer}", ""] + [f"- **{n['name']}** ({n.get('kind', '')}; {n.get('where', '')}). {n.get('detail') or n.get('role', '')}" for n in inf["nodes"] if n["layer"] == layer] + [""]
        o += ["### Gaps", ""]
        for g in inf.get("gaps", []):
            o += [f"- **{g['title']}** [{'filled' if g.get('fill') == 'done' else 'open'}; {g.get('effort', '')}]. {g.get('body', '')} "
                  f"{'Done' if g.get('fill') == 'done' else 'Proposed'}: {g.get('what', '')}"]
        o.append("")
    h = d.get("hygiene") or {}
    if h.get("at_risk"):
        named = [t for t in h["at_risk"] if t["branch"]]
        o += ["## Only on this machine", "",
              f"{len(h['at_risk'])} of {h['worktrees']} worktrees hold work no remote has: {sum(t['unpushed'] for t in named)} commits on {len(named)} named branches, "
              f"{sum(t['dirty'] for t in h['at_risk'])} modified files. Disk: {h['disk']['free_gb']} GB free of {h['disk']['total_gb']}.", ""]
        o += [f"- `{t['path'].replace(A.HOME, '~')}` [{t['branch']}]: {t['unpushed']} commits, {t['dirty']} dirty. {t['last_subject'][:80]}"
              for t in sorted(named, key=lambda t: -t["unpushed"])[:40]]
        o += [""] + [f"- Scheduled task **{x['task']}** names paths that no longer exist: {', '.join(x['missing'])}" for x in h.get("scheduled", []) if x["missing"]]
    open(os.path.join(OUT, "REPORT.md"), "w").write("\n".join(o) + "\n")
    print(f"{len(o)} lines -> {OUT}/REPORT.md")


if __name__ == "__main__":
    main()
