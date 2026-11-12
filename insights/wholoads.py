#!/usr/bin/env python3
"""Who is loading this machine right now, by session: the question to ask before trusting a benchmark.

perflab's load gate can only wait for quiet. It cannot say which sibling session is making the noise, so a campaign
either stalls for hours or runs anyway and reports a 2x that is somebody's partest. agentscope already attributes
every process to a session each minute; this reads that history and names names.

    python3 -m insights.wholoads              # the last 5 minutes
    python3 -m insights.wholoads --since 60   # the last hour
    python3 -m insights.wholoads --json       # for a script: {"quiet": bool, "cores": ..., "sessions": [...]}

Exit status is 0 when the machine is quiet (under --quiet cores of attributed CPU, default 1.0), 1 when it is not, so
an agent can gate on it: `python3 -m insights.wholoads || echo "busy: do not start a timing run"`.
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import agentscope as A  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--since", type=float, default=5, metavar="MIN")
    ap.add_argument("--quiet", type=float, default=1.0, metavar="CORES")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    t1 = time.time()
    t0 = t1 - a.since * 60
    mins = max(1, a.since)
    with A.db(readonly=True) as c:
        last = c.execute("SELECT MAX(t) FROM session_minute").fetchone()[0] or 0
        sess = c.execute("SELECT sid, SUM(cpu), MAX(rss) FROM session_minute WHERE t >= ? GROUP BY sid ORDER BY 2 DESC LIMIT 12", (t0,)).fetchall()
        other = c.execute("SELECT bucket, SUM(cpu) FROM bucket_minute WHERE t >= ? GROUP BY bucket ORDER BY 2 DESC", (t0,)).fetchall()
    titles = {cli: m.get("title") for cli, m in A.read_desktop_meta().items()}
    rows = []
    for sid, cpu, rss in sess:
        cores = cpu / 100 / mins
        if cores < 0.05:
            continue
        procs = [p for p in A.top_procs(t0, t1, 40) if p["sid"] == sid][:3]
        rows.append(dict(sid=sid, title=titles.get(sid) or sid[:8], cores=round(cores, 2), rss_gb=round((rss or 0) / 1e6, 1),
                         procs=[dict(pid=p["pid"], label=p["label"], cpu_s=p["cpu_s"]) for p in procs]))
    total = sum(r["cores"] for r in rows)
    out = dict(quiet=total < a.quiet, cores=round(total, 2), ncpu=A.NCPU, loadavg=os.getloadavg()[0], window_min=a.since,
               stale_s=round(t1 - last) if last else None, sessions=rows, other={b: round(v / 100 / mins, 2) for b, v in other})
    if a.json:
        print(json.dumps(out))
    else:
        if out["stale_s"] is None or out["stale_s"] > 180:
            print(f"warning: agentscope last sampled {out['stale_s']} s ago; is the server running?")
        print(f"{'quiet' if out['quiet'] else 'BUSY'}: agent sessions used {total:.1f} of {A.NCPU} cores over the last {a.since:g} min (load average {out['loadavg']:.1f})")
        for r in rows:
            print(f"  {r['cores']:5.2f} cores  {r['title'][:60]:60}  {r['sid'][:8]}  " + ", ".join(f"{p['label']} (pid {p['pid']})" for p in r["procs"]))
        if out["other"]:
            print("  not agents: " + ", ".join(f"{b} {v}" for b, v in out["other"].items() if v >= 0.05))
    sys.exit(0 if out["quiet"] else 1)


if __name__ == "__main__":
    main()
