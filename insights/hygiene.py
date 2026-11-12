#!/usr/bin/env python3
"""What exists only on this machine, and what is quietly broken.

Agents commit to worktrees and move on; a branch that was never pushed, or a tree left dirty, is one `git worktree
prune` or disk cleanup away from gone, and nothing lists them. This does: every worktree of every repo under ~/code,
with its uncommitted files and the commits no remote has. It also checks that each scheduled task's paths still exist
(a task wired to a pruned worktree fails on every run without telling anyone) and how much disk is left.

    python3 -m insights.hygiene            # -> ~/.cache/agentscope/insights/hygiene.json, and a summary
    python3 -m insights.hygiene --all      # print every worktree with something unpushed, not just the top
"""
import argparse
import concurrent.futures
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import agentscope as A  # noqa: E402

OUT = os.path.join(A.CACHE, "insights")
CODE = os.path.join(A.HOME, "code")


def git(path, *args, timeout=40):
    try:
        r = subprocess.run(["git", "-C", path, *args], capture_output=True, text=True, timeout=timeout)
        return r.stdout if r.returncode == 0 else ""
    except (subprocess.TimeoutExpired, OSError):
        return ""


def repos():
    """Main checkouts under ~/code, three levels down: a directory whose .git is a directory."""
    out = []
    for pat in ("*", "*/*", "*/*/*"):
        for g in glob.glob(os.path.join(CODE, pat, ".git")):
            if os.path.isdir(g) and "/.worktrees/" not in g:
                out.append(os.path.dirname(g))
    return sorted(set(out))


def worktrees(repo):
    out, cur = [], {}
    for line in git(repo, "worktree", "list", "--porcelain").splitlines() + [""]:
        if not line:
            if cur.get("path"):
                out.append(cur)
            cur = {}
        elif line.startswith("worktree "):
            cur["path"] = line[9:]
        elif line.startswith("branch "):
            cur["branch"] = line[7:].replace("refs/heads/", "")
        elif line == "detached":
            cur["branch"] = None
    return out


def inspect(repo, wt):
    p = wt["path"]
    if not os.path.isdir(p):
        return dict(repo=repo, path=p, branch=wt.get("branch"), missing=True)
    dirty = [l for l in git(p, "status", "--porcelain", "--untracked-files=no").splitlines() if l.strip()]
    untracked = git(p, "ls-files", "--others", "--exclude-standard", "--directory", "--no-empty-directory").splitlines()
    ahead = int(git(p, "rev-list", "--count", "HEAD", "--not", "--remotes").strip() or 0)
    last = git(p, "log", "-1", "--format=%ct%x09%s").strip().split("\t")
    subjects = git(p, "log", "--format=%s", "-5", "HEAD", "--not", "--remotes").splitlines() if ahead else []
    return dict(repo=repo, path=p, branch=wt.get("branch"), dirty=len(dirty), dirty_files=[l[3:] for l in dirty[:8]],
                untracked=len(untracked), untracked_files=untracked[:8], unpushed=ahead, unpushed_subjects=subjects,
                last_commit=int(last[0]) if last and last[0].isdigit() else None, last_subject=last[1] if len(last) > 1 else "",
                mtime=os.path.getmtime(p))


def scheduled():
    """Scheduled tasks whose instructions name absolute paths that no longer exist."""
    out = []
    for f in sorted(glob.glob(os.path.join(A.HOME, ".claude", "scheduled-tasks", "*", "*.md"))):
        text = open(f, errors="replace").read()
        paths = sorted(set(re.findall(r"(?:~|/Users/[\w.-]+)/[\w./@+-]+", text)))
        gone = [p for p in paths if not os.path.exists(os.path.expanduser(p.rstrip(".,)")))]
        out.append(dict(task=os.path.basename(os.path.dirname(f)), file=f, paths=len(paths), missing=gone))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--all", action="store_true")
    a = ap.parse_args()
    jobs = [(r, w) for r in repos() for w in worktrees(r)]
    with concurrent.futures.ThreadPoolExecutor(8) as ex:
        trees = list(ex.map(lambda j: inspect(*j), jobs))
    stashes = {r: n for r in repos() if (n := len(git(r, "stash", "list").splitlines()))}
    du = shutil.disk_usage(A.HOME)
    at_risk = sorted((t for t in trees if not t.get("missing") and (t["unpushed"] or t["dirty"])),
                     key=lambda t: (-(t["unpushed"] > 0), -(t["last_commit"] or 0)))
    out = dict(generated=time.time(), worktrees=len(trees), at_risk=at_risk, untracked_only=[t for t in trees if not t.get("missing") and not t["unpushed"] and not t["dirty"] and t["untracked"]],
               missing=[t for t in trees if t.get("missing")], stashes=stashes, scheduled=scheduled(),
               disk=dict(free_gb=round(du.free / 1e9), total_gb=round(du.total / 1e9)))
    os.makedirs(OUT, exist_ok=True)
    json.dump(out, open(os.path.join(OUT, "hygiene.json"), "w"), indent=1)
    rel = lambda p: p.replace(A.HOME, "~")
    print(f"{len(trees)} worktrees in {len(repos())} repos; {len(at_risk)} hold work no remote has "
          f"({sum(t['unpushed'] for t in at_risk)} commits, {sum(t['dirty'] for t in at_risk)} modified files); "
          f"{len(out['missing'])} registered but gone; disk {out['disk']['free_gb']} GB free of {out['disk']['total_gb']}")
    for t in at_risk[: None if a.all else 25]:
        print(f"  {t['unpushed']:3} commits {t['dirty']:3} dirty  {rel(t['path'])}  [{t['branch'] or 'detached'}]  {t['last_subject'][:60]}")
    for s in out["scheduled"]:
        if s["missing"]:
            print(f"  scheduled task {s['task']}: missing {', '.join(s['missing'])}")
    if stashes:
        print("  stashes:", ", ".join(f"{rel(r)}×{n}" for r, n in stashes.items()))


if __name__ == "__main__":
    main()
