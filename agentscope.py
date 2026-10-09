#!/usr/bin/env python3
"""agentscope: one page for all Claude Code agent sessions, their PRs and their machine load.

Sources (all local except GitHub):
  - ~/Library/Application Support/Claude/claude-code-sessions/**/local_*.json  desktop session metadata
      (title, branch, archived, prs, postTurnSummary, spawnedFrom)
  - ~/.claude/sessions/<pid>.json   live CLI processes: pid -> sessionId, status (busy/idle/waiting)
  - ~/.claude/projects/**/*.jsonl   transcripts: activity timeline, prompts, proposals, tokens
  - ps / lsof                       process tree; CPU/RSS attributed to sessions by ancestry, else by cwd
  - gh api graphql                  your PRs (open + recently closed), CI and review state

Usage: python3 agentscope.py [--port 8377]   then open http://localhost:8377
       AGENTSCOPE_SYSTEM_HINTS="MyAntivirus:mdm-agent" python3 agentscope.py   # extra "system / security" processes
"""
import argparse, collections, glob, json, os, re, subprocess, threading, time, traceback
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from datetime import datetime, timezone

HOME = os.path.expanduser("~")
DESKTOP_META = os.path.join(HOME, "Library/Application Support/Claude/claude-code-sessions")
LIVE_DIR = os.path.join(HOME, ".claude/sessions")
PROJECTS = os.path.join(HOME, ".claude/projects")
CACHE = os.path.join(HOME, ".cache/agentscope")
HERE = os.path.dirname(os.path.abspath(__file__))
BUCKET = 300  # seconds per activity bucket
NCPU = os.cpu_count() or 1

os.makedirs(CACHE, exist_ok=True)


def iso_to_epoch(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def run(cmd, timeout=30):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    except Exception:
        return ""


# ---------------------------------------------------------------------------------------------
# Repo / lane naming

_remote_cache = {}


def repo_of(path):
    """owner/repo from the git remote of `path`, or None."""
    if not path or not os.path.isdir(path):
        return None
    if path in _remote_cache:
        return _remote_cache[path]
    url = run(["git", "-C", path, "config", "--get", "remote.origin.url"], 5).strip()
    m = re.search(r"github\.com[:/]([^/]+)/([^/]+?)(?:\.git)?$", url)
    _remote_cache[path] = f"{m.group(1)}/{m.group(2)}" if m else None
    return _remote_cache[path]


def lane_of(cwd, origin=None):
    """A short lane name. Forks and upstream share a lane (sbt/zinc + retronym/zinc -> zinc)."""
    r = repo_of(origin) or repo_of(cwd)
    if r:
        return r.split("/")[1]
    p = cwd or ""
    if "scratch-workspaces" in p:
        return "scratch"
    m = re.search(r"/code/\.worktrees/([^/]+)/", p)
    if m:
        return m.group(1)
    m = re.search(r"/code/(?:[^/]+/)?([^/]+)$", p)
    if m:
        return m.group(1)
    return os.path.basename(p.rstrip("/")) or "?"


# ---------------------------------------------------------------------------------------------
# Transcript index (incremental, cached by mtime/size)

INDEX_FILE = os.path.join(CACHE, "transcripts.json")
INDEX_VERSION = 5
_index = {}
_index_lock = threading.Lock()
_index_ready = threading.Event()

WORKTREE_PATH = re.compile(r"(/[\w./-]*?/\.worktrees/[\w.-]+/[\w.-]+)")
PR_URL = re.compile(r"github\.com/([\w.-]+/[\w.-]+)/pull/(\d+)")
NOISE_PREFIX = ("<command-", "<local-command", "<system-reminder", "Caveat:", "[Request interrupted", "<task-notification", "<side-sessions-event", "<ci-monitor-event")


def _text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def _is_human_prompt(rec):
    if rec.get("type") != "user" or rec.get("isMeta") or rec.get("isSidechain"):
        return None
    c = (rec.get("message") or {}).get("content")
    if isinstance(c, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c):
        return None
    t = _text_of(c).strip()
    if not t or t.startswith(NOISE_PREFIX):
        return None
    return t


def parse_transcript(path):
    sid = os.path.splitext(os.path.basename(path))[0]
    d = dict(sid=sid, cwd=None, branches=[], first=None, last=None, act={}, prompts=0, first_prompt=None,
             last_prompt=None, last_prompt_t=None, last_text=None, out_tokens=0, title=None, pr_mentions={},
             proposals=[], subagents=0, paths={})
    pending_props = {}
    branches = collections.Counter()
    for line in open(path, errors="replace"):
        if ".worktrees/" in line and '"type":"assistant"' in line and '"tool_use"' in line:  # the agent acting on it, not reading about it
            m = re.search(r'"timestamp":"([^"]+)"', line)
            lt = iso_to_epoch(m.group(1)) if m else 0
            for wp in set(WORKTREE_PATH.findall(line)):
                d["paths"][wp] = max(d["paths"].get(wp, 0), lt or 0)
        try:
            r = json.loads(line)
        except ValueError:
            continue
        typ = r.get("type")
        if typ == "custom-title":
            d["title"] = r.get("customTitle")
            continue
        if typ == "agent-name" and not d["title"]:
            d["title"] = r.get("agentName")
            continue
        t = iso_to_epoch(r.get("timestamp"))
        if r.get("cwd") and not d["cwd"]:
            d["cwd"] = r["cwd"]
        if r.get("gitBranch") and r["gitBranch"] != "HEAD":
            branches[r["gitBranch"]] += 1
        if t is None or typ not in ("user", "assistant"):
            continue
        d["first"] = t if d["first"] is None else min(d["first"], t)
        d["last"] = t if d["last"] is None else max(d["last"], t)
        b = str(int(t // BUCKET))
        slot = d["act"].setdefault(b, [0, 0])
        msg = r.get("message") or {}
        if typ == "assistant":
            slot[1] += 1
            d["out_tokens"] += ((msg.get("usage") or {}).get("output_tokens") or 0)
            for blk in msg.get("content") or []:
                if not isinstance(blk, dict):
                    continue
                if blk.get("type") == "text" and blk.get("text", "").strip():
                    d["last_text"] = blk["text"].strip()[-1500:]
                    for repo, n in PR_URL.findall(blk["text"]):
                        d["pr_mentions"][f"{repo}#{n}"] = d["pr_mentions"].get(f"{repo}#{n}", 0) + 1
                if blk.get("type") == "tool_use" and "start_session" in blk.get("name", ""):
                    inp = blk.get("input") or {}
                    if inp.get("initiation") in ("own_initiative", "offer"):
                        pending_props[blk["id"]] = dict(t=t, title=inp.get("title"), prompt=(inp.get("prompt") or "")[:1200],
                                                        initiation=inp.get("initiation"))
        else:
            c = msg.get("content")
            if isinstance(c, list):
                for blk in c:
                    if isinstance(blk, dict) and blk.get("type") == "tool_result" and blk.get("tool_use_id") in pending_props:
                        m = re.search(r"task_id: (task_\w+)", json.dumps(blk.get("content")))
                        p = pending_props.pop(blk["tool_use_id"])
                        p["task_id"] = m.group(1) if m else None
                        d["proposals"].append(p)
            hp = _is_human_prompt(r)
            if hp:
                slot[0] += 1
                d["prompts"] += 1
                if d["first_prompt"] is None:
                    d["first_prompt"] = hp[:1500]
                d["last_prompt"], d["last_prompt_t"] = hp[:1500], t
    d["branches"] = [b for b, _ in branches.most_common(5)]
    # Fold subagent transcripts' activity into the parent (as agent activity).
    subdir = os.path.join(os.path.dirname(path), sid, "subagents")
    for sp in glob.glob(os.path.join(subdir, "*.jsonl")):
        d["subagents"] += 1
        for line in open(sp, errors="replace"):
            m = re.search(r'"timestamp":"([^"]+)"', line)
            t = iso_to_epoch(m.group(1)) if m else None
            if t:
                d["act"].setdefault(str(int(t // BUCKET)), [0, 0])[1] += 1
    return d


def refresh_index():
    global _index
    if not _index:
        try:
            cached = json.load(open(INDEX_FILE))
            if cached.get("v") == INDEX_VERSION:
                _index = cached["files"]
        except Exception:
            pass
    seen, changed = set(), 0
    for path in glob.glob(os.path.join(PROJECTS, "*", "*.jsonl")):
        seen.add(path)
        try:
            st = os.stat(path)
        except OSError:
            continue
        # subagent files change without the parent changing; key on the newest of both
        subs = glob.glob(os.path.join(os.path.dirname(path), os.path.splitext(os.path.basename(path))[0], "subagents", "*.jsonl"))
        key = [st.st_size, max([st.st_mtime] + [os.path.getmtime(s) for s in subs])]
        e = _index.get(path)
        if e and e["key"] == key:
            continue
        try:
            data = parse_transcript(path)
        except Exception:
            traceback.print_exc()
            continue
        with _index_lock:
            _index[path] = dict(key=key, d=data)
        changed += 1
    for p in list(_index):
        if p not in seen:
            del _index[p]
    if changed:
        tmp = INDEX_FILE + ".tmp"
        json.dump(dict(v=INDEX_VERSION, files=_index), open(tmp, "w"))
        os.replace(tmp, INDEX_FILE)
    _index_ready.set()
    return changed


# ---------------------------------------------------------------------------------------------
# Live sessions + process attribution

def read_live():
    live = {}
    for f in glob.glob(os.path.join(LIVE_DIR, "*.json")):
        try:
            j = json.load(open(f))
            os.kill(j["pid"], 0)
        except Exception:
            continue
        live[j["pid"]] = j
    return live


def parse_cputime(s):
    days = 0
    if "-" in s:
        dd, s = s.split("-", 1)
        days = int(dd)
    parts = [float(x) for x in s.split(":")]
    secs = 0.0
    for p in parts:
        secs = secs * 60 + p
    return days * 86400 + secs


def ps_snapshot():
    out = run(["ps", "-axww", "-o", "pid=,ppid=,time=,rss=,args="])
    procs = {}
    for line in out.splitlines():
        parts = line.split(None, 4)
        if len(parts) < 5:
            continue
        try:
            pid, ppid, rss = int(parts[0]), int(parts[1]), int(parts[3])
            procs[pid] = dict(pid=pid, ppid=ppid, cpu_s=parse_cputime(parts[2]), rss=rss * 1024, args=parts[4])
        except ValueError:
            continue
    return procs


def proc_label(args):
    exe = args.split()[0] if args else "?"
    base = os.path.basename(exe)
    if "claude.app/Contents/MacOS/claude" in args:
        return "claude (agent)"
    if "sbtn" in base or "sbt-launch" in args or "xsbt.boot" in args or "sbt.ForkMain" in args:
        if "sbt.ForkMain" in args:
            return "sbt forked test JVM"
        return "sbt" if base != "java" else "sbt server (java)"
    if base == "java":
        m = re.search(r"\s-jar\s+(\S+)", args)
        if m:
            return f"java -jar {os.path.basename(m.group(1))}"
        toks = args.split()[1:]
        skip = False
        for t in toks:
            if skip:
                skip = False
                continue
            if t in ("-cp", "-classpath", "--class-path", "-p", "--module-path", "--add-opens", "--add-exports"):
                skip = True
                continue
            if not t.startswith("-"):
                return f"java {t.rsplit('.', 1)[-1]}"
        return "java"
    if "node" == base or base.startswith("node"):
        m = re.search(r"node_modules/(@?[\w.-]+(?:/[\w.-]+)?)", args)
        return f"node {m.group(1)}" if m else "node " + " ".join(args.split()[1:2])
    if base.startswith("python"):
        return "python " + os.path.basename(" ".join(args.split()[1:2]))
    return base[:40]


def batch_cwds(pids):
    if not pids:
        return {}
    out = run(["lsof", "-a", "-d", "cwd", "-Fpn", "-p", ",".join(map(str, pids))], 10)
    res, cur = {}, None
    for line in out.splitlines():
        if line.startswith("p"):
            cur = int(line[1:])
        elif line.startswith("n") and cur:
            res[cur] = line[1:]
    return res


# Command-line substrings of OS / endpoint-security processes, bucketed as "system / security" rather than "other".
# Add site-specific ones (antivirus, MDM agents...) via AGENTSCOPE_SYSTEM_HINTS, colon-separated.
SYSTEM_HINTS = ("/System/", "/usr/libexec", "/usr/sbin", "/sbin/", "/Library/SystemExtensions", "/Library/Apple/") + \
    tuple(h for h in os.environ.get("AGENTSCOPE_SYSTEM_HINTS", "").split(":") if h)


class Sampler:
    """Samples the process tree every few seconds, attributing CPU (from cputime deltas) and RSS to sessions."""

    def __init__(self, period=5):
        self.period = period
        self.prev = {}  # pid -> (cpu_s, t)
        self.lock = threading.Lock()
        self.current = dict(t=0, sessions={}, buckets={}, orphans=[])
        self.hist = collections.deque(maxlen=int(3 * 3600 / period))  # (t, {sid: [cpu, rss]}, {bucket: [cpu, rss]})
        self.minute_acc = collections.defaultdict(lambda: [0.0, 0, 0])
        self.minute = None
        self._cwd_cache = {}  # pid -> cwd (pids are not reused quickly enough to matter here)
        self.sticky = {}  # pid -> (sid, how): a daemonized child keeps the session it was first seen under

    def attribute(self, procs, live, meta_by_cli, mentions):
        claude_pids = {pid: j for pid, j in live.items() if pid in procs}
        owner = {}

        def find_owner(pid, depth=0):
            if pid in owner:
                return owner[pid]
            if pid in claude_pids:
                owner[pid] = (claude_pids[pid]["sessionId"], "tree")
                return owner[pid]
            p = procs.get(pid)
            if not p or p["ppid"] <= 1 or depth > 40:
                owner[pid] = None
                return None
            owner[pid] = find_owner(p["ppid"], depth + 1)
            return owner[pid]

        for pid in procs:
            find_owner(pid)

        # cwd fallback for heavy unowned processes (detached sbt servers, nohup'd builds...)
        cands = [p for p in procs.values() if owner.get(p["pid"]) is None and p["rss"] > 150e6
                 and not any(h in p["args"] for h in SYSTEM_HINTS) and not p["args"].startswith("/Applications/")]
        need = [p["pid"] for p in cands if p["pid"] not in self._cwd_cache]
        self._cwd_cache.update(batch_cwds(need))
        # candidate dirs per session, most recently active first
        dirs = []
        for pid, j in claude_pids.items():
            dirs.append((j.get("cwd") or "", j["sessionId"], j.get("updatedAt") or 0))
        for cli, m in meta_by_cli.items():
            for k in ("worktreePath", "cwd"):
                if m.get(k):
                    dirs.append((m[k], cli, m.get("lastActivityAt") or 0))
        # A session rooted at a broad dir (~, ~/code) would claim everything below it; only use specific dirs.
        dirs = [x for x in dirs if x[0] and len(os.path.relpath(x[0], HOME).split(os.sep)) >= 2]
        dirs.sort(key=lambda x: (-len(x[0]), -x[2]))
        for p in cands:
            cwd = self._cwd_cache.get(p["pid"]) or ""
            m = re.search(r"/claude-\d+/[^/]+/([0-9a-f-]{36})/", cwd + "/")  # scratchpad encodes the session id
            if m:
                owner[p["pid"]] = (m.group(1), "scratchpad")
                continue
            for d, sid, _ in dirs:
                if d and (cwd == d or cwd.startswith(d.rstrip("/") + "/")):
                    owner[p["pid"]] = (sid, "cwd")
                    break
        for p in cands:
            pid = p["pid"]
            if owner.get(pid) is None and pid in self.sticky:
                owner[pid] = (self.sticky[pid][0], "sticky")
            if owner.get(pid) is None:
                # an extra worktree an agent made for itself: credit whoever mentioned that path most recently
                cwd = self._cwd_cache.get(pid) or ""
                best = max(((t, sid) for wp, hits in mentions.items() if cwd == wp or cwd.startswith(wp + "/") for sid, t in hits), default=None)
                if best:
                    owner[pid] = (best[1], "mentioned")
        for pid, o in owner.items():
            if o and pid in procs:
                self.sticky.setdefault(pid, o)
        for pid in [k for k in self.sticky if k not in procs]:
            del self.sticky[pid]
        return owner

    def sample(self, meta_by_cli):
        now = time.time()
        procs = ps_snapshot()
        live = read_live()
        owner = self.attribute(procs, live, meta_by_cli, worktree_mentions())
        sess = {}
        buckets = collections.defaultdict(lambda: dict(cpu=0.0, rss=0))
        orphans = []
        newprev = {}
        for pid, p in procs.items():
            pc, pt = self.prev.get(pid, (None, None))
            cpu = max(0.0, (p["cpu_s"] - pc) / (now - pt) * 100) if pc is not None and now > pt else 0.0
            newprev[pid] = (p["cpu_s"], now)
            o = owner.get(pid)
            if o:
                s = sess.setdefault(o[0], dict(cpu=0.0, rss=0, procs=[]))
                s["cpu"] += cpu
                s["rss"] += p["rss"]
                s["procs"].append(dict(pid=pid, label=proc_label(p["args"]), cpu=round(cpu, 1), rss=p["rss"], how=o[1],
                                       self=pid in live))
                buckets["agents"]["cpu"] += cpu
                buckets["agents"]["rss"] += p["rss"]
            else:
                a = p["args"]
                if "Claude.app/Contents/" in a and "claude-code/" not in a:
                    k = "Claude app"
                elif any(h in a for h in SYSTEM_HINTS):
                    k = "system / security"
                else:
                    k = "other"
                    if cpu > 20 or p["rss"] > 500e6:
                        orphans.append(dict(pid=pid, label=proc_label(a), cpu=round(cpu, 1), rss=p["rss"], args=a[:300],
                                            cwd=self._cwd_cache.get(pid)))
                buckets[k]["cpu"] += cpu
                buckets[k]["rss"] += p["rss"]
        warm = bool(self.prev)
        self.prev = newprev
        if not warm:
            return
        for s in sess.values():
            s["procs"].sort(key=lambda x: (-x["cpu"], -x["rss"]))
            s["cpu"] = round(s["cpu"], 1)
        live_by_sid = {j["sessionId"]: j for j in live.values()}
        with self.lock:
            self.current = dict(t=now, ncpu=NCPU, sessions=sess, buckets=dict(buckets), orphans=sorted(orphans, key=lambda o: -o["cpu"])[:15],
                                live=live_by_sid)
            self.hist.append((now, {k: [round(v["cpu"], 1), v["rss"]] for k, v in sess.items()},
                              {k: [round(v["cpu"], 1), v["rss"]] for k, v in buckets.items()}))
        self._persist(now, sess, buckets)

    def _persist(self, now, sess, buckets):
        minute = int(now // 60)
        if self.minute is None:
            self.minute = minute
        if minute != self.minute:
            rows = {k: [round(v[0] / max(v[2], 1), 1), int(v[1] / max(v[2], 1))] for k, v in self.minute_acc.items()}
            day = datetime.fromtimestamp(self.minute * 60).strftime("%Y%m%d")
            with open(os.path.join(CACHE, f"load-{day}.jsonl"), "a") as f:
                f.write(json.dumps(dict(t=self.minute * 60, s=rows)) + "\n")
            self.minute_acc.clear()
            self.minute = minute
        for k, v in list(sess.items()) + [("@" + k, v) for k, v in buckets.items()]:
            a = self.minute_acc[k]
            a[0] += v["cpu"]
            a[1] += v["rss"]
            a[2] += 1

    def loop(self, meta_fn):
        while True:
            try:
                self.sample(meta_fn())
            except Exception:
                traceback.print_exc()
            time.sleep(self.period)


_mentions = dict(t=0, d={})


def worktree_mentions():
    """worktree path -> [(sid, last time mentioned)], from the transcript index."""
    if time.time() - _mentions["t"] > 20:
        d = collections.defaultdict(list)
        with _index_lock:
            for e in _index.values():
                for wp, t in (e["d"].get("paths") or {}).items():
                    d[wp].append((e["d"]["sid"], t))
        _mentions.update(t=time.time(), d=dict(d))
    return _mentions["d"]


def load_history(since):
    rows = []
    for f in sorted(glob.glob(os.path.join(CACHE, "load-*.jsonl"))):
        day = datetime.strptime(os.path.basename(f)[5:13], "%Y%m%d").timestamp()
        if day + 86400 < since:
            continue
        for line in open(f):
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r["t"] >= since:
                rows.append(r)
    return rows


# ---------------------------------------------------------------------------------------------
# Desktop metadata

def read_desktop_meta():
    out = {}
    for f in glob.glob(os.path.join(DESKTOP_META, "*", "*", "local_*.json")):
        try:
            j = json.load(open(f))
        except Exception:
            continue
        cli = j.get("cliSessionId")
        if not cli:
            continue
        keep = {k: j.get(k) for k in ("sessionId", "cliSessionId", "cwd", "originCwd", "worktreePath", "worktreeName", "branch",
                                      "sourceBranch", "writtenBranches", "createdAt", "lastActivityAt", "lastFocusedAt", "isArchived",
                                      "title", "prs", "postTurnSummary", "spawnedFrom", "forkedFromSessionId", "model", "effort",
                                      "lastTurnReport", "publishedArtifacts", "isStarred", "completedTurns", "scheduledTaskId",
                                      "resolvedBackgroundTaskSuggestions")}
        prev = out.get(cli)
        if not prev or (keep.get("lastActivityAt") or 0) > (prev.get("lastActivityAt") or 0):
            out[cli] = keep
    return out


# ---------------------------------------------------------------------------------------------
# GitHub

PR_FIELDS = """number title url state isDraft createdAt updatedAt mergedAt closedAt headRefName baseRefName
  reviewDecision mergeable additions deletions repository { nameWithOwner }
  comments { totalCount } reviewRequests(first:5){ nodes { requestedReviewer { ... on User { login } } } }
  commits(last:1){ nodes { commit { committedDate statusCheckRollup { state } } } }"""

_gh = dict(t=0, prs=[], err=None, login=None)
_gh_lock = threading.Lock()


def gh_search(query, pages=2):
    q = f"""query($q:String!,$after:String){{ search(query:$q, type:ISSUE, first:50, after:$after){{
      pageInfo {{ hasNextPage endCursor }} nodes {{ ... on PullRequest {{ {PR_FIELDS} }} }} }} }}"""
    nodes, after = [], None
    for _ in range(pages):
        cmd = ["gh", "api", "graphql", "-f", f"query={q}", "-f", f"q={query}"] + (["-f", f"after={after}"] if after else [])
        for attempt in range(3):  # GitHub's GraphQL search 502s intermittently
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            if not r.returncode:
                break
            time.sleep(2 * (attempt + 1))
        else:
            raise RuntimeError(f"gh: {r.stderr.strip()[:300]}")
        sr = json.loads(r.stdout)["data"]["search"]
        nodes += sr["nodes"]
        if not sr["pageInfo"]["hasNextPage"]:
            break
        after = sr["pageInfo"]["endCursor"]
    return nodes


def fetch_prs(days=45):
    since = datetime.fromtimestamp(time.time() - days * 86400, timezone.utc).strftime("%Y-%m-%d")
    nodes = gh_search("is:pr author:@me is:open archived:false sort:updated-desc", 3) + \
        gh_search(f"is:pr author:@me is:closed closed:>={since} sort:updated-desc", 2)
    prs = {}
    for n in nodes:
        if not n:
            continue
        c = (n.get("commits") or {}).get("nodes") or []
        roll = ((c[0]["commit"].get("statusCheckRollup") or {}).get("state")) if c else None
        key = f"{n['repository']['nameWithOwner']}#{n['number']}"
        prs[key] = dict(key=key, repo=n["repository"]["nameWithOwner"], lane=n["repository"]["nameWithOwner"].split("/")[1],
                        number=n["number"], title=n["title"], url=n["url"], state=n["state"], draft=n["isDraft"],
                        created=iso_to_epoch(n["createdAt"]), updated=iso_to_epoch(n["updatedAt"]),
                        merged=iso_to_epoch(n.get("mergedAt")), closed=iso_to_epoch(n.get("closedAt")),
                        head=n["headRefName"], base=n["baseRefName"], review=n.get("reviewDecision"),
                        mergeable=n.get("mergeable"), ci=roll, comments=n["comments"]["totalCount"],
                        adds=n.get("additions"), dels=n.get("deletions"),
                        last_commit=iso_to_epoch(c[0]["commit"]["committedDate"]) if c else None,
                        reviewers=[r["requestedReviewer"].get("login") for r in n["reviewRequests"]["nodes"] if r.get("requestedReviewer")])
    return list(prs.values())


def gh_loop(period=120):
    while True:
        try:
            login = _gh["login"] or run(["gh", "api", "user", "-q", ".login"], 30).strip() or None
            prs = fetch_prs()
            with _gh_lock:
                _gh.update(t=time.time(), prs=prs, err=None, login=login)
        except Exception as e:
            with _gh_lock:
                _gh["err"] = str(e)[:500]
        time.sleep(period)


# ---------------------------------------------------------------------------------------------
# Model assembly

_meta = dict(t=0, d={})


def meta_cached():
    if time.time() - _meta["t"] > 10:
        _meta.update(t=time.time(), d=read_desktop_meta())
    return _meta["d"]


def build_state(sampler):
    meta = meta_cached()
    with _index_lock:
        idx = {e["d"]["sid"]: e["d"] for e in _index.values()}
    with sampler.lock:
        cur = dict(sampler.current)
        hist = list(sampler.hist)
    with _gh_lock:
        gh = dict(_gh)
    live = cur.get("live", {})
    sessions = []
    for sid in set(idx) | set(meta) | set(live):
        t, m, l = idx.get(sid, {}), meta.get(sid, {}), live.get(sid)
        cwd = m.get("cwd") or t.get("cwd") or (l or {}).get("cwd")
        if cwd and "/private/tmp/claude-" in cwd and "scratchpad" in cwd:
            continue  # sessions started inside another session's scratchpad: noise
        if not t.get("prompts") and not l and not m:
            continue
        load = cur["sessions"].get(sid)
        spark = [[round(h[0]), h[1].get(sid, [0, 0])[0]] for h in hist[-240:]] if load else []
        last = max(filter(None, [t.get("last"), (m.get("lastActivityAt") or 0) / 1000 or None, ((l or {}).get("updatedAt") or 0) / 1000 or None]), default=None)
        sessions.append(dict(
            sid=sid, local=m.get("sessionId"), title=m.get("title") or (l or {}).get("name") or t.get("title") or (t.get("first_prompt") or "")[:80] or sid[:8],
            cwd=cwd, lane=lane_of(cwd, m.get("originCwd")), branch=m.get("branch") or (t.get("branches") or [None])[0],
            branches=list(dict.fromkeys([b for b in [m.get("branch")] + (m.get("writtenBranches") or []) + (t.get("branches") or []) if b])),
            first=t.get("first") or (m.get("createdAt") or 0) / 1000 or None, last=last,
            act=t.get("act", {}), prompts=t.get("prompts", 0), out_tokens=t.get("out_tokens", 0), subagents=t.get("subagents", 0),
            first_prompt=t.get("first_prompt"), last_prompt=t.get("last_prompt"), last_prompt_t=t.get("last_prompt_t"),
            last_text=t.get("last_text"), proposals=t.get("proposals", []),
            archived=bool(m.get("isArchived")), starred=bool(m.get("isStarred")),
            summary=m.get("postTurnSummary"), report=m.get("lastTurnReport"), spawned_from=(m.get("spawnedFrom") or {}).get("sessionId"),
            meta_prs=m.get("prs") or [], artifacts=[dict(url=a.get("url"), title=a.get("title")) for a in (m.get("publishedArtifacts") or [])],
            resolved=m.get("resolvedBackgroundTaskSuggestions") or {}, model=m.get("model"), scheduled=bool(m.get("scheduledTaskId")),
            pr_mentions=t.get("pr_mentions", {}),
            live=dict(pid=l["pid"], status=l.get("status"), waiting=l.get("waitingFor"), name=l.get("name")) if l else None,
            load=load,
            spark=spark,
        ))
    # map local_* ids to cli ids for spawn edges
    local2cli = {s["local"]: s["sid"] for s in sessions if s["local"]}
    for s in sessions:
        s["spawned_from"] = local2cli.get(s["spawned_from"])
    # link PRs to sessions: desktop binding, then head branch == session branch in the same lane
    prs = {p["key"]: p for p in gh["prs"]}
    for s in sessions:
        keys = []
        for mp in s["meta_prs"]:
            k = f"{mp['repo']}#{mp['prNumber']}"
            keys.append(k)
            if k not in prs:
                prs[k] = dict(key=k, repo=mp["repo"], lane=mp["repo"].split("/")[1], number=mp["prNumber"], title=f"{mp['repo']}#{mp['prNumber']}",
                              url=mp["url"], state=mp.get("state"), head=mp.get("branch"), base=mp.get("baseRef"), foreign=True)
        for p in gh["prs"]:
            if p["lane"] == s["lane"] and p["head"] in s["branches"] and p["key"] not in keys:
                keys.append(p["key"])
        s["prs"] = keys
    for p in prs.values():
        p["sessions"] = [s["sid"] for s in sessions if p["key"] in s["prs"]]
    # proposals and their fates
    resolved = {}
    for s in sessions:
        resolved.update(s["resolved"])
    proposals = []
    for s in sessions:
        for p in s["proposals"]:
            proposals.append(dict(p, sid=s["sid"], lane=s["lane"], fate=resolved.get(p.get("task_id"), "unresolved")))
    return dict(now=time.time(), ncpu=NCPU, mem_total=_memsize(), sessions=sessions, prs=list(prs.values()), proposals=proposals,
                machine=cur.get("buckets", {}), orphans=cur.get("orphans", []), gh_t=gh["t"], gh_err=gh["err"], gh_login=gh["login"],
                index_ready=_index_ready.is_set(), bucket=BUCKET,
                machine_hist=[[round(h[0]), {k: v[0] for k, v in h[2].items()}] for h in hist[-720:]])


_mem = []


def _memsize():
    if not _mem:
        _mem.append(int(run(["sysctl", "-n", "hw.memsize"]).strip() or 0))
    return _mem[0]


# ---------------------------------------------------------------------------------------------
# HTTP

def serve(port):
    sampler = Sampler()
    threading.Thread(target=sampler.loop, args=(meta_cached,), daemon=True).start()
    threading.Thread(target=gh_loop, daemon=True).start()

    def index_loop():
        while True:
            try:
                n = refresh_index()
                if n:
                    print(f"indexed {n} transcripts")
            except Exception:
                traceback.print_exc()
            time.sleep(20)

    threading.Thread(target=index_loop, daemon=True).start()

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body, ctype):
            b = body.encode() if isinstance(body, str) else body
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(b)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(b)

        def do_GET(self):
            try:
                path, _, qs = self.path.partition("?")
                q = dict(p.split("=", 1) for p in qs.split("&") if "=" in p)
                if path == "/":
                    self._send(200, open(os.path.join(HERE, "index.html")).read(), "text/html; charset=utf-8")
                elif path == "/api/state":
                    self._send(200, json.dumps(build_state(sampler)), "application/json")
                elif path == "/api/load":
                    self._send(200, json.dumps(load_history(float(q.get("since", time.time() - 86400)))), "application/json")
                else:
                    self._send(404, "not found", "text/plain")
            except Exception:
                self._send(500, traceback.format_exc(), "text/plain")

    print(f"agentscope on http://localhost:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8377)
    serve(ap.parse_args().port)
