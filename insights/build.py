#!/usr/bin/env python3
"""Join the index, GitHub activity, per-session cards and the synthesis into the one file the Insights page reads.

    python3 -m insights.build            # -> ~/.cache/agentscope/insights/insights.json

Inputs, all under ~/.cache/agentscope/insights/ (none of it is committed: it quotes your sessions):
  index.json, github.json           from insights.extract and insights.github
  cards/*.json                      one card per session, written by the mining agents (CARD_PROMPT.md)
  synthesis/threads.json            {themes:[{id,title,summary}], threads:[{id,title,theme,summary,status,slugs:[...],parents:[...]}]}
  synthesis/sections.json           {patterns, friction, research_ideas, lost_ideas, last_mile, loose_ends}
  synthesis/infra.json              {nodes, edges, gaps}
  synthesis/perf_process.json       how the compiler perf work was done, written from a second read of those sessions: see perf_process
  synthesis/last_week.json          the written standup summary of the last seven days: see last_week
"""
import collections
import glob
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import agentscope as A  # noqa: E402

OUT = os.path.join(A.CACHE, "insights")


def load(name, default):
    try:
        return json.load(open(os.path.join(OUT, name)))
    except (OSError, ValueError):
        return default


def followups(index, sections, infra):
    """Which sessions picked an item up after the synthesis was written: sets `followups` on those items, returns the summary.

    The usual route from the page to work is a prompt that pastes an item ("start a session for: <item>"), so a session's pasted
    prompts are matched against item titles and bodies. The follow-ups are the sessions started in answer to that prompt and
    whatever those started in turn; if none was started, the session the item was pasted into did the work itself.
    followups.json corrects it: {"analysed": epoch, "links": {item title or gap id: [sid prefix, ...]}, "drop": {the same}}.
    """
    manual = load("followups.json", {})
    try:
        analysed = manual.get("analysed") or os.path.getmtime(os.path.join(OUT, "synthesis", "threads.json"))
    except OSError:
        return dict(analysed=None, sessions=[], items=[])
    norm = lambda s: re.sub(r"\W+", " ", s or "").lower().strip()
    parent = lambda i: (i.get("spawned_from") or {}).get("sessionId") if isinstance(i.get("spawned_from"), dict) else i.get("spawned_from")
    kids = collections.defaultdict(list)
    for i in index:
        if parent(i):
            kids[parent(i)].append(i)
    items = [(k, it) for k, its in sections.items() for it in its] + [("gaps", g) for g in infra.get("gaps", [])]
    keys = [(norm(it.get("title")), norm((it.get("body") or "")[:70])) for _, it in items]
    hits = collections.defaultdict(dict)  # item number -> {sid: how}
    for i in index:
        for p in i.get("pastes") or []:
            if p["t"] < analysed:
                continue
            text = norm(p["text"])
            for n, (title, body) in enumerate(keys):
                if (len(title) > 12 and title in text) or (len(body) > 40 and body in text):
                    started = [k for k in kids.get(i.get("desktop_id"), []) if (k.get("title") in p["spawned"]
                               or (isinstance(k.get("spawned_from"), dict) and k["spawned_from"].get("title") in p["spawned"]))]
                    for k in started:
                        hits[n][k["sid"]] = "started for this"
                    if not started:
                        hits[n][i["sid"]] = "done in this session"
    for n, (_, it) in enumerate(items):
        for pre in (manual.get("links") or {}).get(it.get("id") or "", []) + (manual.get("links") or {}).get(it.get("title") or "", []):
            for i in index:
                if i["sid"].startswith(pre):
                    hits[n].setdefault(i["sid"], "follow-up")
    for n, (_, it) in enumerate(items):  # and what the matching got wrong
        for pre in (manual.get("drop") or {}).get(it.get("id") or it.get("title") or "", []):
            for sid in [s for s in hits.get(n, {}) if s.startswith(pre)]:
                del hits[n][sid]
    by_sid = {i["sid"]: i for i in index}
    summary = []
    for n, found in sorted((n, f) for n, f in hits.items() if f):
        todo = [by_sid[s] for s, how in found.items() if how == "started for this"]
        while todo:  # and what those sessions started in turn
            for k in kids.get(todo.pop().get("desktop_id"), []):
                if k["sid"] not in found:
                    found[k["sid"]] = "started from a follow-up"
                    todo.append(k)
        kind, it = items[n]
        it["followups"] = [dict(sid=s, how=how) for s, how in sorted(found.items(), key=lambda kv: by_sid[kv[0]]["first"])]
        summary.append(dict(section=kind, title=it.get("title"), sids=[f["sid"] for f in it["followups"]]))
    return dict(analysed=analysed, sessions=[i["sid"] for i in index if i["last"] > analysed], items=summary)


def last_week(sessions, threads, prs, place):
    """The seven days up to the last day anything ran, for a standup: where the time went and which PRs moved, both derived, and the
    written summary from synthesis/last_week.json, {to: "YYYY-MM-DD", headline, groups: [{title, items: [{title, text, prs, threads}]}]}.
    The written part is of its own week: the page says so when the data has moved past it."""
    end = max((d for s in sessions for d in s["days"]), default=time.strftime("%Y-%m-%d"))
    t1 = time.mktime(time.strptime(end, "%Y-%m-%d")) + 86400
    t0 = t1 - 7 * 86400
    days = {time.strftime("%Y-%m-%d", time.localtime(t0 + i * 86400 + 43200)) for i in range(7)}
    by_thread, n = collections.defaultdict(lambda: dict(min=0, sessions=[])), 0
    for s in sessions:
        m = sum(v for d, v in s["days"].items() if d in days)
        if m:
            n += 1
            by_thread[s["thread"]]["min"] += m
            by_thread[s["thread"]]["sessions"].append(s["sid"])
    mine = [p for p in prs.values() if p["kind"] == "pr" and p["role"] == "author"]
    hit = lambda k: sorted((p["key"] for p in mine if p.get(k) and t0 <= p[k] < t1), key=lambda key: prs[key][k])
    upstream = lambda keys: [k for k in keys if not k.startswith("retronym/")]
    merged, opened = hit("merged"), hit("created")
    written = load("synthesis/last_week.json", {})
    for g in written.get("groups", []):
        for it in g.get("items", []):
            it["threads"] = [place(t) for t in it.get("threads", []) if place(t) in threads]
    return dict(start=t0, end=t1 - 1, sessions=n, active_min=sum(t["min"] for t in by_thread.values()),
                threads=sorted((dict(id=k, **v) for k, v in by_thread.items()), key=lambda t: -t["min"]),
                merged=merged, merged_upstream=upstream(merged), opened=opened, opened_upstream=upstream(opened), written=written)


def perf_process(sessions, threads, prs, place):
    """How the compiler perf work was done, from synthesis/perf_process.json: {lead, achieved: {tiles, items}, loop: [{id, title, text}],
    ladder: {title, note, url}, questions, techniques, tools, wins, dead_ends, corrections, next, principles}. Session ids in it are prefixes; they are made whole
    here, thread slugs are placed, and the hours behind it are counted from the perf themes."""
    pp = load("synthesis/perf_process.json", {})
    if not pp:
        return pp
    full = lambda sid: next((s["sid"] for s in sessions if s["sid"].startswith(str(sid)[:8])), None)

    def walk(x):
        if isinstance(x, list):
            for y in x:
                walk(y)
        elif isinstance(x, dict):
            if "sids" in x:
                x["sids"] = [f for f in map(full, x["sids"]) if f]
            if "threads" in x:
                x["threads"] = list(dict.fromkeys(place(t) for t in x["threads"] if place(t) in threads))
            for y in x.values():
                walk(y)
    walk(pp)
    rows = load("perf/inputs/ladder.json", [])  # a measured branch, one row per commit: {what, pr, ms, step, sig, total, label}
    if rows:
        pp["ladder"] = dict(load("perf/inputs/ladder_meta.json", {}), **(pp.get("ladder") or {}), rows=rows)
    themes = set(pp.get("themes") or ["scala2-perf", "scala3-perf", "perf-tooling"])
    mine = [s for s in sessions if threads[s["thread"]]["theme"] in themes]
    keys = {k for s in mine for k in s["prs"]}
    pp["stats"] = dict(sessions=len(mine), active_min=sum(s["active_min"] for s in mine), threads=len({s["thread"] for s in mine}),
                       prs=sum(1 for k in keys if k in prs and prs[k]["kind"] == "pr"),
                       merged_upstream=sum(1 for k in keys if k in prs and prs[k]["state"] == "MERGED" and not k.startswith("retronym/")))
    return pp


def main():
    index = load("index.json", [])
    gh = load("github.json", dict(items=[], repos=[]))
    cards = {}
    for f in sorted(glob.glob(os.path.join(OUT, "cards", "*.json"))):
        try:
            for c in json.load(open(f)).get("sessions", []):
                cards[c["sid"]] = c
        except (ValueError, KeyError) as e:
            print(f"skipped {f}: {e}", file=sys.stderr)
    # cards sometimes carry a truncated sid; match by prefix
    by_sid = {i["sid"]: i for i in index}
    for sid in list(cards):
        if sid not in by_sid:
            hit = [s for s in by_sid if s.startswith(sid[:8])]
            if len(hit) == 1:
                cards[hit[0]] = cards.pop(sid)
    syn = load("synthesis/threads.json", dict(themes=[], threads=[]))
    slug_to_thread = {s: t["id"] for t in syn["threads"] for s in t.get("slugs", [])}
    threads = {t["id"]: dict(t, sessions=[], prs=set(), days=collections.Counter(), cost=0, first=None, last=None, ideas=[],
                             last_mile=[], loose_ends=[]) for t in syn["threads"]}
    sessions = []
    for i in index:
        c = cards.get(i["sid"], {})
        slug = c.get("thread") or f"lane-{i['lane']}"
        tid = slug_to_thread.get(slug)
        if tid is None:  # a line of work the synthesis did not place: its own thread under "other"
            tid = slug
            threads.setdefault(tid, dict(id=tid, title=slug.replace("-", " "), theme="other", summary="", status="", slugs=[slug],
                                         parents=[], sessions=[], prs=set(), days=collections.Counter(), cost=0, first=None,
                                         last=None, ideas=[], last_mile=[], loose_ends=[]))
        t = threads[tid]
        t["sessions"].append(i["sid"])
        t["prs"].update(i.get("prs") or [])
        t["cost"] += i.get("cost") or 0
        t["first"] = i["first"] if t["first"] is None else min(t["first"], i["first"])
        t["last"] = i["last"] if t["last"] is None else max(t["last"], i["last"])
        for d, m in (i.get("days") or {}).items():
            t["days"][d] += m
        for k in ("ideas", "last_mile", "loose_ends"):
            for x in c.get(k) or []:
                t[k].append(dict(x, sid=i["sid"]) if isinstance(x, dict) else dict(text=x, sid=i["sid"]))
        sessions.append(dict(sid=i["sid"], local=i.get("desktop_id"), archived=i.get("archived"), title=c.get("title") or i.get("title") or "(untitled)",
                             thread=tid, lane=i["lane"], first=i["first"], last=i["last"], active_min=i["active_min"],
                             cost=round(i.get("cost") or 0, 1), prompts=i["prompts"], interrupts=i["interrupts"],
                             corrections=i["corrections"], denials=i["denials"], compactions=i["compactions"],
                             subagents=i["subagents"], prs=i.get("prs") or [], status=c.get("status") or "", goal=c.get("goal") or "",
                             outcome=c.get("outcome") or "", friction=c.get("friction") or [], infra=c.get("infra") or [],
                             quotes=c.get("quotes") or [], days=i.get("days") or {}))
    prs = {p["key"]: {k: p[k] for k in ("key", "kind", "role", "repo", "number", "title", "url", "state", "draft", "created", "updated",
                                         "merged", "closed", "head", "adds", "dels", "comments")} for p in gh["items"]}
    # a PR nobody's session mentioned still belongs somewhere: by head branch, else it is listed unplaced
    branch_thread = {}
    for i in index:
        for b in i.get("branches") or []:
            branch_thread.setdefault(b, next(s["thread"] for s in sessions if s["sid"] == i["sid"]))
    for t in threads.values():
        for k in t["prs"]:
            if k in prs:
                prs[k]["thread"] = t["id"]
    for p in prs.values():
        if "thread" not in p and p.get("head") in branch_thread:
            p["thread"] = branch_thread[p["head"]]
            threads[p["thread"]]["prs"].add(p["key"])
    out_threads = []
    for t in threads.values():
        if not t["sessions"]:
            continue
        t["prs"] = sorted(k for k in t["prs"] if k in prs)
        t["days"] = dict(sorted(t["days"].items()))
        t["cost"] = round(t["cost"])
        t["active_min"] = sum(t["days"].values())
        out_threads.append(t)
    out_threads.sort(key=lambda t: t["first"])
    stats = dict(sessions=len(sessions), carded=sum(1 for s in sessions if s["status"]), prompts=sum(s["prompts"] for s in sessions),
                 cost=round(sum(s["cost"] for s in sessions)), active_hours=round(sum(s["active_min"] for s in sessions) / 60),
                 interrupts=sum(s["interrupts"] for s in sessions), corrections=sum(s["corrections"] for s in sessions),
                 denials=sum(s["denials"] for s in sessions), compactions=sum(s["compactions"] for s in sessions),
                 prs_opened=sum(1 for p in prs.values() if p["kind"] == "pr" and p["role"] == "author" and p["created"] >= time.mktime(time.strptime(gh.get("since", "2026-10-01"), "%Y-%m-%d"))),
                 prs_merged=sum(1 for p in prs.values() if p["kind"] == "pr" and p["role"] == "author" and p["state"] == "MERGED"),
                 prs_open=sum(1 for p in prs.values() if p["kind"] == "pr" and p["role"] == "author" and p["state"] == "OPEN"),
                 threads=len(out_threads))
    # the synthesis agents name threads by card slug; the page wants thread ids
    sections = load("synthesis/sections.json", {})
    for part in ("patterns_friction", "research_ideas", "lost_ideas", "last_mile", "loose_ends"):
        sections.update(load(f"synthesis/{part}.json", {}))
    place = lambda s: slug_to_thread.get(s, s)
    for items in sections.values():
        for it in items:
            ts = it.pop("threads", None) or ([it.pop("thread")] if it.get("thread") else [])
            it["threads"] = list(dict.fromkeys(place(t) for t in ts if place(t) in threads))
    infra = load("synthesis/infra.json", dict(nodes=[], edges=[], gaps=[]))
    for g in infra.get("gaps", []):  # gaps filled since: insights/gaps_filled.json, {gap id: what was done}
        done = load("gaps_filled.json", {}).get(g.get("id"))
        if done:
            g.update(fill="done", what=done)
    since_analysis = followups(index, sections, infra)
    week = last_week(sessions, threads, prs, place)
    perf = perf_process(sessions, threads, prs, place)
    out = dict(generated=time.time(), last_week=week, perf_process=perf, since_analysis=since_analysis, since=gh.get("since", "2026-10-01"), stats=stats, themes=syn["themes"], threads=out_threads,
               sessions=sessions, prs=sorted(prs.values(), key=lambda p: p["created"]), repos=gh["repos"],
               narrative=syn.get("narrative", ""), sections=sections, infra=infra,
               hygiene=load("hygiene.json", {}), upstream=[r for r in load("upstream.json", {}).get("rows", []) if r["state"] == "OPEN"])
    json.dump(out, open(os.path.join(OUT, "insights.json"), "w"))
    # one self-contained file, for reading away from the server
    page = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "insights.html")).read()
    blob = json.dumps(out).replace("</", "<\\/")
    open(os.path.join(OUT, "insights-standalone.html"), "w").write(page.replace("<script>\nconst $", f"<script>window.INSIGHTS = {blob};</script>\n<script>\nconst $", 1))
    if perf:  # the perf write-up needs only its own part of the data, the PRs and the sessions it cites
        cited = {sid for sid in re.findall(r'"([0-9a-f]{8}-[0-9a-f-]{27})"', json.dumps(perf))}
        small = dict(generated=out["generated"], since=out["since"], perf_process=perf, prs=[p for p in out["prs"] if p["key"] in json.dumps(perf)],
                     sessions=[dict(sid=s["sid"], title=s["title"], local=s["local"], archived=s["archived"]) for s in sessions if s["sid"] in cited])
        doc = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "insights-perf.html")).read()
        open(os.path.join(OUT, "perf-standalone.html"), "w").write(doc.replace("<script>\nconst $", "<script>window.INSIGHTS = " + json.dumps(small).replace("</", "<\\/") + ";</script>\n<script>\nconst $", 1))
    print(f"{stats['sessions']} sessions ({stats['carded']} carded), {len(out_threads)} threads, {len(prs)} PRs/issues -> {OUT}/insights.json "
          f"({os.path.getsize(os.path.join(OUT, 'insights.json')) // 1000} KB)")


if __name__ == "__main__":
    main()
