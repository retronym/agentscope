#!/usr/bin/env python3
"""One session as agentscope sees it, small enough to poll: what the mod's pane shows.

agentscope's /api/state is every session it has ever indexed (megabytes). This asks for it once and prints the part
about one session as JSON: its attributed CPU and memory with the top processes, its JVMs, its PRs, the sessions it
spawned, and the other sessions using CPU now.

    session_view.py SESSION_ID [--url http://localhost:8377]

Always exits 0 and prints one JSON object: {"ok": true, ...} or {"ok": false, "error": "..."} when agentscope cannot
be asked, so the caller has one thing to read.
"""
import json
import sys
import urllib.request

URL = "http://localhost:8377"
BUSY = 10.0  # percent of a core, below which another session is not worth naming


def status(s):
    live = s.get("live")
    if not live:
        return "archived" if s.get("archived") else "not running"
    return f"waiting: {live['waiting']}" if live.get("waiting") else live.get("status") or "running"


def cores(s):
    return round(((s.get("load") or {}).get("cpu") or 0) / 100, 2)


def top_proc(s):
    procs = [p for p in (s.get("load") or {}).get("procs") or [] if not p.get("self")]
    return max(procs, key=lambda p: p.get("cpu") or 0)["label"] if procs else None


def brief(s):
    return dict(sid=s["sid"][:8], title=s.get("title") or s["sid"][:8], status=status(s), cores=cores(s), top=top_proc(s))


def summarize(state, sid):
    """The view of session `sid` from one /api/state answer."""
    sessions = state.get("sessions") or []
    me = next((s for s in sessions if s["sid"] == sid), None)
    if me is None:
        return dict(ok=False, error=f"agentscope does not know session {sid[:8]} yet (it indexes new sessions within a minute)")
    load = me.get("load") or {}
    prs = {p["key"]: p for p in state.get("prs") or []}
    parent = next((s for s in sessions if s["sid"] == me.get("spawned_from")), None)
    others = sorted((s for s in sessions if s["sid"] != sid and ((s.get("load") or {}).get("cpu") or 0) >= BUSY), key=lambda s: -s["load"]["cpu"])
    return dict(
        ok=True, at=state.get("now"), ncpu=state.get("ncpu"), mem_total=state.get("mem_total"),
        title=me.get("title"), status=status(me), cores=cores(me), rss=load.get("rss") or 0,
        procs=[dict(label=p["label"], pid=p["pid"], cores=round((p.get("cpu") or 0) / 100, 2), rss=p.get("rss") or 0)
               for p in sorted(load.get("procs") or [], key=lambda p: -(p.get("cpu") or 0))[:5]],
        jvms=[dict(label=j["label"], pid=j["pid"], cores=round((j.get("cpu") or 0) / 100, 2), rss=j.get("rss") or 0)
              for j in state.get("jvms") or [] if j.get("sid") == sid],
        prs=[dict(key=k, title=p.get("title") or k, url=p.get("url"), state=("DRAFT" if p.get("draft") and p.get("state") == "OPEN" else p.get("state")) or "?",
                  ci=p.get("ci"), review=p.get("review")) for k in me.get("prs") or [] for p in [prs.get(k)] if p],
        parent=brief(parent) if parent else None,
        spawned=[brief(s) for s in sorted((s for s in sessions if s.get("spawned_from") == sid), key=lambda s: -(s.get("last") or 0))[:8]],
        others=[brief(s) for s in others[:5]],
        others_cores=round(sum(s["load"]["cpu"] for s in others) / 100, 2),
        machine={k: round((v.get("cpu") or 0) / 100, 2) for k, v in (state.get("machine") or {}).items()},
    )


def main(argv):
    if not argv or argv[0].startswith("-"):
        sys.exit(__doc__)
    url = argv[argv.index("--url") + 1] if "--url" in argv else URL
    try:
        with urllib.request.urlopen(url.rstrip("/") + "/api/state", timeout=8) as r:
            state = json.load(r)
        out = summarize(state, argv[0])
    except Exception as e:  # not running, not JSON, a shape this script does not know
        out = dict(ok=False, error=f"agentscope is not answering at {url}: {getattr(e, 'reason', None) or e}")
    print(json.dumps(out))


if __name__ == "__main__":
    main(sys.argv[1:])
