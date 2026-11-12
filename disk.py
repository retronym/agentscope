"""Disk: free space on / per minute, and which directories grew.

Agents fill disks: worktrees, build output, benchmark results, profiler traces, dependency caches, scratchpads. At
ENOSPC no session can run a shell command, so the page has to say so well before, and say what to delete. Free space
is one statvfs a minute. What grew is the difference of two `du` samples of a fixed set of directories; `du` walks
every file, so it runs in its own thread at background priority, well apart, never for a request.
"""
import glob, os, re, shutil, subprocess, threading, time, traceback

HOME = os.path.expanduser("~")
# Below LOW free the page warns and Loose ends lists the growers; below CRITICAL it turns red. Override to see either
# state on a machine with room: AGENTSCOPE_DISK_LOW_GB=2000 python3 agentscope.py --port 8378 --db dist/dev.db
LOW = float(os.environ.get("AGENTSCOPE_DISK_LOW_GB", 40)) * 1e9
CRITICAL = float(os.environ.get("AGENTSCOPE_DISK_CRITICAL_GB", 15)) * 1e9
FREE_RETENTION_DAYS, DU_RETENTION_DAYS = 30, 14
DU_PERIOD = 45 * 60  # between the starts of two passes
DU_TIMEOUT = 600  # one directory; a pass over ~600 worktrees takes minutes, mostly in a few big ones
WINDOW = 86400  # growth is reported over this long
MIN_GROWTH = 100e6  # smaller than this isn't worth a line
CACHES = ("Library/Caches/Coursier", ".ivy2", ".m2")
EXTRA = tuple(d for d in os.environ.get("AGENTSCOPE_DISK_DIRS", "").split(":") if d)  # more directories to measure

SCHEMA = """
CREATE TABLE IF NOT EXISTS disk_minute (t INTEGER PRIMARY KEY, free INTEGER, total INTEGER) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS disk_dir (
  id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, kind TEXT, born INTEGER, first_t INTEGER, last_t INTEGER, kb INTEGER);
CREATE TABLE IF NOT EXISTS disk_du (dir_id INTEGER NOT NULL, t INTEGER NOT NULL, kb INTEGER, PRIMARY KEY (dir_id, t)) WITHOUT ROWID;
"""


def prune(c, now):
    c.execute("DELETE FROM disk_minute WHERE t < ?", (now - FREE_RETENTION_DAYS * 86400,))
    # disk_du has a row only when a size changed, so a directory's newest row stays however old: it is its baseline
    c.execute("DELETE FROM disk_du WHERE t < ? AND t < (SELECT MAX(t) FROM disk_du u WHERE u.dir_id = disk_du.dir_id)",
              (now - DU_RETENTION_DAYS * 86400,))
    c.execute("DELETE FROM disk_dir WHERE last_t < ?", (now - DU_RETENTION_DAYS * 86400,))  # deleted directories
    c.execute("DELETE FROM disk_du WHERE dir_id NOT IN (SELECT id FROM disk_dir)")


def _subdirs(d):
    try:
        return sorted(e.path for e in os.scandir(d) if e.is_dir(follow_symlinks=False))
    except OSError:
        return []


def perflab_outputs(root):
    """The directories a perflab.toml in `root` sends results to: [paths] runs and campaigns, relative to the file."""
    try:
        text = open(os.path.join(root, "perflab.toml")).read()
    except OSError:
        return []
    m = re.search(r"^\[paths\]\s*$(.*?)(?=^\[|\Z)", text, re.M | re.S)  # by regex: tomllib needs Python 3.11
    out = []
    for k, v in re.findall(r'^\s*(\w+)\s*=\s*"([^"]*)"', m.group(1) if m else "", re.M):
        p = os.path.normpath(os.path.join(root, os.path.expanduser(v)))
        if k in ("runs", "campaigns") and os.path.isdir(p):
            out.append(p)
    return out


def targets(code=os.path.join(HOME, "code")):
    """[(path, kind)] to measure one by one. The globs are of fixed depth: finding the set must not itself walk the trees."""
    out = {}
    roots = []
    for wt in [os.path.join(code, ".worktrees")] + glob.glob(os.path.join(code, "*", ".worktrees")) + glob.glob(os.path.join(code, "*", "*", ".worktrees")):
        for d in _subdirs(wt):
            # .worktrees/<name> is a worktree, or .worktrees/<repo>/ holds that repo's (the Claude app's layout)
            for w in [d] if os.path.exists(os.path.join(d, ".git")) else _subdirs(d):
                out[w] = "worktree"
                roots.append(w)
    for f in glob.glob(os.path.join(code, "*", "perflab.toml")) + glob.glob(os.path.join(code, "*", "*", "perflab.toml")):
        roots.append(os.path.dirname(f))
    for r in roots:
        for p in perflab_outputs(r):
            out.setdefault(p, "perflab")
    for d in CACHES:
        out[os.path.join(HOME, d)] = "cache"
    for d in EXTRA:
        out.setdefault(os.path.abspath(os.path.expanduser(d)), "dir")
    return [(p, k) for p, k in out.items() if os.path.isdir(p)]


# nice for the CPU; on macOS also the background band, which throttles its I/O and keeps it off the performance cores,
# so a pass doesn't show up in a build or a benchmark an agent is running
_QUIET = (["taskpolicy", "-b"] if shutil.which("taskpolicy") else []) + ["nice", "-n", "19"]


def du(path, depth=None):
    """{path: KiB}: `path` alone, or with depth also every directory down to that depth, in one walk. {} if it failed."""
    cmd = _QUIET + ["du", "-k"] + (["-d", str(depth)] if depth is not None else ["-s"]) + [path]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=DU_TIMEOUT)
    except (subprocess.TimeoutExpired, OSError):
        return {}
    out = {}
    for line in r.stdout.splitlines():  # unreadable entries make du exit non-zero with the rest still counted
        kb, _, p = line.partition("\t")
        if kb.isdigit():
            out[p.rstrip("/") or "/"] = int(kb)
    return out


def scratchpads():
    """{path: KiB} of every session's directory under /private/tmp/claude-<uid>/<project>/<session id>, one walk per root."""
    out = {}
    for root in glob.glob("/private/tmp/claude-*"):
        if os.path.isdir(root):
            out.update({p: kb for p, kb in du(root, 2).items() if p.count("/") == root.count("/") + 2})
    return out


class Monitor:
    def __init__(self, db, mount="/"):
        self.db = db
        self.mount = mount
        self.lock = threading.Lock()
        self.free = dict(free=None, total=None, d24=None, span=None, hist=[])
        self.pass_ = dict(t=None, secs=None, dirs=0, scanning=False, growers=[])

    # ---- free space

    def sample_free(self, now):
        u = shutil.disk_usage(self.mount)  # what df calls available; APFS's purgeable space is not in it
        with self.db() as c:
            c.execute("INSERT OR REPLACE INTO disk_minute VALUES (?,?,?)", (int(now // 60) * 60, u.free, u.total))
            # the trend: a week by the hour, each hour's low; and the change over the last day (or since we started)
            hist = c.execute("SELECT t / 3600 * 3600, MIN(free) FROM disk_minute WHERE t >= ? GROUP BY 1 ORDER BY 1", (now - 7 * 86400,)).fetchall()
            then = c.execute("SELECT t, free FROM disk_minute WHERE t >= ? ORDER BY t LIMIT 1", (now - WINDOW,)).fetchone()
        span = now - then[0] if then else 0
        with self.lock:
            self.free = dict(free=u.free, total=u.total, hist=[list(r) for r in hist] + [[int(now), u.free]],
                             d24=u.free - then[1] if span >= 600 else None, span=round(span))

    def free_loop(self):
        while True:
            try:
                self.sample_free(time.time())
            except Exception:
                traceback.print_exc()
            time.sleep(60 - time.time() % 60)

    # ---- what grew

    def scan(self, now):
        """One pass: measure everything, then store it in one transaction, so a pass cut short leaves no partial sample."""
        sizes = {}
        for p, kind in targets():
            kb = du(p).get(p)
            if kb is not None:
                sizes[p] = (kind, kb)
        for p, kb in scratchpads().items():
            sizes[p] = ("scratch", kb)
        t = int(now)
        with self.db() as c:
            known = {r[0]: (r[1], r[2]) for r in c.execute("SELECT path, id, kb FROM disk_dir")}
            for p, (kind, kb) in sizes.items():
                if p not in known:
                    try:
                        st = os.stat(p)
                        born = int(getattr(st, "st_birthtime", st.st_ctime))
                    except OSError:
                        born = t
                    did = c.execute("INSERT INTO disk_dir (path, kind, born, first_t, last_t, kb) VALUES (?,?,?,?,?,?)", (p, kind, born, t, t, kb)).lastrowid
                    c.execute("INSERT INTO disk_du VALUES (?,?,?)", (did, t, kb))
                else:
                    did, old = known[p]
                    c.execute("UPDATE disk_dir SET last_t = ?, kb = ?, kind = ? WHERE id = ?", (t, kb, kind, did))
                    if kb != old:  # most directories don't change between passes: a row per change, not per pass
                        c.execute("INSERT INTO disk_du VALUES (?,?,?)", (did, t, kb))
        return t, len(sizes)

    def growers(self):
        """Directories of the last pass by how much they grew over WINDOW, biggest first."""
        with self.db() as c:
            t = c.execute("SELECT MAX(last_t) FROM disk_dir").fetchone()[0]
            if not t:
                return None, []
            cut = t - WINDOW
            rows = c.execute("""SELECT d.path, d.kind, d.kb, d.born, d.first_t,
                (SELECT kb FROM disk_du u WHERE u.dir_id = d.id AND u.t <= ? ORDER BY u.t DESC LIMIT 1),
                (SELECT kb FROM disk_du u WHERE u.dir_id = d.id ORDER BY u.t LIMIT 1)
                FROM disk_dir d WHERE d.last_t = ?""", (cut, t)).fetchall()
        out = []
        for path, kind, kb, born, first_t, base, first_kb in rows:
            if base is not None:
                since = cut
            elif born and born >= cut:  # created inside the window: all of it is growth, whenever we first measured it
                base, since = 0, born
            else:  # older than the window but we've watched it for less: growth since we started
                base, since = first_kb if first_kb is not None else kb, first_t
            grew = (kb - base) * 1024
            if grew >= MIN_GROWTH:
                out.append(dict(path=path, kind=kind, size=kb * 1024, grew=grew, since=since, new=base == 0))
        # a perflab output directory inside a measured worktree is part of that worktree's growth, not a second grower
        tops = {g["path"]: g for g in out if g["kind"] != "perflab"}
        for g in [g for g in out if g["kind"] == "perflab"]:
            parent = next((tops[p] for p in tops if g["path"].startswith(p + "/")), None)
            if parent:
                parent.setdefault("parts", []).append(dict(path=os.path.relpath(g["path"], parent["path"]), kind="perflab", grew=g["grew"]))
                out.remove(g)
        return t, sorted(out, key=lambda g: -g["grew"])[:20]

    def du_loop(self):
        try:
            t, growers = self.growers()  # a restart shows the last pass at once and doesn't start another early
            with self.lock:
                self.pass_.update(t=t, growers=growers)
        except Exception:
            traceback.print_exc()
        time.sleep(20)  # let a starting server index transcripts first
        while True:
            last = self.pass_["t"] or 0
            if time.time() - last < DU_PERIOD:
                time.sleep(min(60, DU_PERIOD - (time.time() - last)))
                continue
            t0 = time.time()
            try:
                with self.lock:
                    self.pass_["scanning"] = True
                _, n = self.scan(t0)
                t, growers = self.growers()
                with self.lock:
                    self.pass_.update(t=t, secs=round(time.time() - t0), dirs=n, growers=growers)
            except Exception:
                traceback.print_exc()
                self.pass_["t"] = t0  # try again a period from now, not in a tight loop
            finally:
                self.pass_["scanning"] = False

    def start(self):
        threading.Thread(target=self.free_loop, daemon=True).start()
        threading.Thread(target=self.du_loop, daemon=True).start()

    def state(self):
        with self.lock:
            p = self.pass_
            return dict(self.free, low=LOW, critical=CRITICAL, window=WINDOW, du_t=p["t"], du_secs=p["secs"], du_dirs=p["dirs"],
                        scanning=p["scanning"], growers=[dict(g) for g in p["growers"]])
