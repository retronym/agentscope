#!/usr/bin/env python3
"""Which fork PRs have gone upstream, and which open ones are now only clutter.

Work here starts as a PR on a fork (retronym/scala, retronym/zinc, ...) and, once it has earned it, is rewritten and
opened upstream. Nothing joins the two, so a fork PR stays open long after its upstream twin merged, and "which of my
fork PRs still need upstreaming?" means reading a few hundred titles. This joins them from what github.json already
holds: a body that names the other PR, the same head branch, or the same title.

    python3 -m insights.upstream           # -> ~/.cache/agentscope/insights/upstream.json, and a summary
"""
import collections
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import agentscope as A  # noqa: E402

OUT = os.path.join(A.CACHE, "insights")
norm = lambda t: re.sub(r"[^a-z0-9]+", " ", re.sub(r"^\s*\[[^\]]*\]\s*", "", t.lower())).strip()


def main():
    gh = json.load(open(os.path.join(OUT, "github.json")))
    prs = {p["key"]: p for p in gh["items"] if p["kind"] == "pr" and p["role"] == "author"}
    me = collections.Counter(p["repo"].split("/")[0] for p in prs.values()).most_common(1)[0][0]  # the fork owner: where most PRs are
    fork = {k: p for k, p in prs.items() if p["repo"].startswith(me + "/")}
    up = {k: p for k, p in prs.items() if not p["repo"].startswith(me + "/")}
    by_head, by_title = collections.defaultdict(list), collections.defaultdict(list)
    for k, p in up.items():
        by_head[(p["repo"].split("/")[1], p["head"])].append(k)
        by_title[(p["repo"].split("/")[1], norm(p["title"]))].append(k)
    links = collections.defaultdict(dict)  # fork key -> {upstream key: how}
    for k, p in fork.items():
        name = p["repo"].split("/")[1]
        for r in p.get("refs") or []:
            if r in up and r.split("/")[1].split("#")[0] == name:
                links[k][r] = "fork PR names it"
        for u in by_head.get((name, p["head"]), []):
            links[k].setdefault(u, "same branch")
        for u in by_title.get((name, norm(p["title"])), []):
            links[k].setdefault(u, "same title")
    for u, p in up.items():
        for r in p.get("refs") or []:
            if r in fork and r.split("/")[1].split("#")[0] == p["repo"].split("/")[1]:
                links[r].setdefault(u, "upstream PR names it")
    rows = []
    for k, p in fork.items():
        ups = [dict(key=u, state=up[u]["state"], how=h, url=up[u]["url"], title=up[u]["title"]) for u, h in links.get(k, {}).items()]
        verdict = ("closable: upstream merged" if any(u["state"] == "MERGED" for u in ups) and p["state"] == "OPEN" else
                   "upstream open" if any(u["state"] == "OPEN" for u in ups) else
                   "upstream closed unmerged" if ups and p["state"] == "OPEN" else
                   "fork only" if p["state"] == "OPEN" else "done")
        rows.append(dict(key=k, title=p["title"], url=p["url"], state=p["state"], draft=p["draft"], created=p["created"], updated=p["updated"],
                         upstream=ups, verdict=verdict))
    rows.sort(key=lambda r: (r["verdict"], -r["updated"]))
    json.dump(dict(generated=time.time(), rows=rows), open(os.path.join(OUT, "upstream.json"), "w"), indent=1)
    c = collections.Counter(r["verdict"] for r in rows if r["state"] == "OPEN")
    print(f"{len(fork)} fork PRs, {len(up)} upstream; of {sum(c.values())} open fork PRs:", ", ".join(f"{v} {k}" for k, v in c.most_common()))
    for r in rows:
        if r["verdict"].startswith("closable"):
            print(f"  {r['key']:24} {r['title'][:60]:60} -> {', '.join(u['key'] + ' ' + u['state'].lower() for u in r['upstream'])}")


if __name__ == "__main__":
    main()
