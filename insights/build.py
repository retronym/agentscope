#!/usr/bin/env python3
"""Join the index, GitHub activity, per-session cards and the synthesis into the one file the Insights page reads.

    python3 -m insights.build            # -> ~/.cache/agentscope/insights/insights.json

Inputs, all under ~/.cache/agentscope/insights/ (none of it is committed: it quotes your sessions):
  index.json, github.json           from insights.extract and insights.github
  cards/*.json                      one card per session, written by the mining agents (CARD_PROMPT.md)
  synthesis/threads.json            {themes:[{id,title,summary}], threads:[{id,title,theme,summary,status,slugs:[...],parents:[...]}]}
  synthesis/sections.json           {patterns, friction, research_ideas, lost_ideas, last_mile, loose_ends}
  synthesis/infra.json              {nodes, edges, gaps}
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
    out = dict(generated=time.time(), since=gh.get("since", "2026-10-01"), stats=stats, themes=syn["themes"], threads=out_threads,
               sessions=sessions, prs=sorted(prs.values(), key=lambda p: p["created"]), repos=gh["repos"],
               narrative=syn.get("narrative", ""), sections=sections, infra=infra)
    json.dump(out, open(os.path.join(OUT, "insights.json"), "w"))
    # one self-contained file, for reading away from the server
    page = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "insights.html")).read()
    blob = json.dumps(out).replace("</", "<\\/")
    open(os.path.join(OUT, "insights-standalone.html"), "w").write(page.replace("<script>\nconst $", f"<script>window.INSIGHTS = {blob};</script>\n<script>\nconst $", 1))
    print(f"{stats['sessions']} sessions ({stats['carded']} carded), {len(out_threads)} threads, {len(prs)} PRs/issues -> {OUT}/insights.json "
          f"({os.path.getsize(os.path.join(OUT, 'insights.json')) // 1000} KB)")


if __name__ == "__main__":
    main()
