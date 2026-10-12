"""async-profiler captures (tier 2 of docs/jvm-profiler.md): one JVM, a bounded window, on an explicit click.

`asprof` attaches a native agent that can't be unloaded, so a capture is never automatic. Each one is a JFR file kept
beside the database; the helper reads it on demand for flame graphs and diffs, `jfrconv` renders async-profiler's own
HTML, and the file can be downloaded for JMC.

A capture is a Record with async-profiler's samples on top (PLAN.md): the JVM records with JFR for the capture's window
(held on by the capture if it wasn't), which fills in thread CPU load, GC pauses and any kind async-profiler lacks; the
file is written in chunks (--chunktime) the helper reads as they finish, so a capture shows while it runs; and at the end
JFR's window is dumped beside it (capture-N-...-jfr.jfr), so it reads the same once the JVM is gone.
"""
import glob, json, os, shutil, signal, subprocess, threading, time, traceback

RETENTION_DAYS = 30
CHUNK_SECONDS = 5  # how often a running capture's file gains a finished chunk, so how often its view grows

# Presets. On macOS, CPU and wall-clock sampling can't run together, so they're separate presets.
MODES = {
    "cpu": ("CPU, allocation, locks", ["-e", "cpu", "--alloc", "512k", "--lock", "10ms"]),
    "wall": ("Wall clock, every thread", ["-e", "wall"]),
    "all": ("Everything (wall, alloc, live, native memory, locks)", ["--all"]),
}

# Power-user options, each a whitelist: what the settings panel offers, passed to asprof as given.
OPTIONS = {
    "interval": ("-i", ["1ms", "2ms", "5ms", "10ms", "20ms", "50ms", "100ms"]),  # CPU / wall sampling interval (asprof's default: 10ms)
    "alloc": ("--alloc", ["0", "16k", "64k", "256k", "512k", "2m", "10m"]),  # bytes between allocation samples (0: every TLAB)
    "lock": ("--lock", ["0", "100us", "1ms", "10ms", "100ms"]),  # contended locks held at least this long
    "cstack": ("--cstack", ["fp", "dwarf", "vm", "no"]),  # how native stacks are walked
}
FEATURES = ["vtable", "comptask", "mixed", "pcaddr"]  # -F: megamorphic call targets above vtable/itable stubs, the method a JIT thread compiles...


def clean_opts(opts):
    """The options as asprof will get them: unknown keys and values dropped."""
    out = {}
    for k, (_, allowed) in OPTIONS.items():
        if (opts or {}).get(k) in allowed:
            out[k] = opts[k]
    feats = [f for f in FEATURES if f in ((opts or {}).get("features") or [])]
    if feats:
        out["features"] = feats
    return out


def asprof_args(mode, opts):
    """A preset's arguments, with the options in place of its own values (an option the preset lacks is added)."""
    args = list(MODES[mode][1])
    for k, v in opts.items():
        if k == "features":
            args += ["-F", ",".join(v)]
            continue
        flag = OPTIONS[k][0]
        if flag in args:
            args[args.index(flag) + 1] = v
        else:
            args += [flag, v]
    return args


SCHEMA = """
CREATE TABLE IF NOT EXISTS capture (
  id INTEGER PRIMARY KEY, jvm_id INTEGER NOT NULL, pid INTEGER, mode TEXT, seconds INTEGER, started REAL, finished REAL,
  status TEXT, error TEXT, path TEXT, bytes INTEGER, kinds TEXT, opts TEXT);
CREATE INDEX IF NOT EXISTS capture_jvm ON capture (jvm_id, started);
"""


def jfr_path(path):
    """Where JFR's recording of a capture's window goes, beside it."""
    return path[:-4] + "-jfr.jfr"


def asprof():
    for p in (shutil.which("asprof"), "/opt/homebrew/bin/asprof", "/usr/local/bin/asprof"):
        if p and os.access(p, os.X_OK):
            return p
    return None


def jfrconv():
    a = asprof()
    for p in (shutil.which("jfrconv"), a and os.path.join(os.path.dirname(a), "jfrconv")):
        if p and os.access(p, os.X_OK):
            return p
    return None


class Captures:
    def __init__(self, db, helper, tracker, folder, recorder=None):
        self.db, self.helper, self.tracker, self.folder, self.recorder = db, helper, tracker, folder, recorder
        os.makedirs(folder, exist_ok=True)
        self.procs = {}  # capture id -> the running asprof client, which Stop interrupts
        with db() as c:
            if "opts" not in [r[1] for r in c.execute("PRAGMA table_info(capture)")]:
                c.execute("ALTER TABLE capture ADD COLUMN opts TEXT")
            # a capture can't survive a restart of the server that was running asprof for it
            c.execute("UPDATE capture SET status = 'failed', error = 'interrupted' WHERE status = 'running'")

    def start(self, jvm_id, mode, seconds, stack_depth=4096, opts=None):
        if mode not in MODES:
            raise ValueError(f"mode: one of {list(MODES)}")
        opts = clean_opts(opts)
        if mode == "wall":  # no allocation or lock profiling to tune: keep only what applies, as listed with the capture
            opts = {k: v for k, v in opts.items() if k not in ("alloc", "lock")}
        seconds = max(5, min(int(seconds), 300))
        tool = asprof()
        if not tool:
            raise RuntimeError("async-profiler isn't installed (brew install async-profiler)")
        with self.tracker.lock:
            j = next((j for j in self.tracker.jvms.values() if j["id"] == jvm_id), None)
        if not j:
            raise ValueError("no such JVM running")
        with self.db() as c:
            if c.execute("SELECT 1 FROM capture WHERE jvm_id = ? AND status = 'running'", (jvm_id,)).fetchone():
                raise ValueError("a capture of this JVM is already running")
            cid = c.execute("INSERT INTO capture (jvm_id, pid, mode, seconds, started, status, opts) VALUES (?,?,?,?,?, 'running', ?)",
                            (jvm_id, j["pid"], mode, seconds, time.time(), json.dumps(opts) if opts else None)).lastrowid
        path = os.path.join(self.folder, f"capture-{cid}-{j['pid']}-{mode}.jfr")
        with self.db() as c:  # known from the start: a running capture can be read
            c.execute("UPDATE capture SET path = ? WHERE id = ?", (path, cid))
        threading.Thread(target=self._run, args=(cid, tool, j, asprof_args(mode, opts), seconds, path, stack_depth), daemon=True).start()
        return cid

    def _run(self, cid, tool, j, args, seconds, path, stack_depth):
        status, error, kinds, size = "done", None, None, None
        pid = j["pid"]
        held = self.recorder.hold(j) if self.recorder else False
        t0 = time.time()
        with self.db() as c:  # the window starts once JFR records too
            c.execute("UPDATE capture SET started = ? WHERE id = ?", (t0, cid))
        try:
            p = subprocess.Popen([tool, *args, "-j", str(stack_depth), "-d", str(seconds), "--chunktime", str(CHUNK_SECONDS), "-o", "jfr", "-f", path, str(pid)],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.procs[cid] = p
            try:
                out, err = p.communicate(timeout=seconds + 60)
            finally:
                self.procs.pop(cid, None)
            if p.returncode != 0 or not os.path.exists(path):
                raise RuntimeError((err or out).strip().splitlines()[-1] if (err or out).strip() else f"asprof exited {p.returncode}")
            size = os.path.getsize(path)
            self._dump_jfr(j, path, time.time() - t0)
            kinds = self.helper.call("capture_stats", timeout=120, path=path, **self._context(j["id"], pid, path, t0, time.time()))["stats"].get("kinds", {})
        except Exception as e:
            status, error = "failed", str(e)
        finally:
            if held:
                self.recorder.release(j["id"])
        with self.db() as c:
            # stopped early: the seconds it actually ran
            c.execute("UPDATE capture SET status = ?, error = ?, path = ?, bytes = ?, kinds = ?, finished = ?, seconds = MIN(seconds, ?) WHERE id = ?",
                      (status, error, path if status == "done" else None, size, json.dumps(kinds) if kinds else None, time.time(),
                       max(1, round(time.time() - t0)), cid))

    def _dump_jfr(self, j, path, seconds):
        """JFR's recording of the capture's window, beside it: the capture then reads the same once the JVM is gone."""
        if not self.recorder or not self.recorder.live(j["id"]):
            return
        try:
            self.helper.call("jcmd", timeout=60, pid=j["pid"], cmd=f"JFR.dump name=agentscope begin=-{int(seconds) + 10}s filename={jfr_path(path)}")
        except Exception:
            traceback.print_exc()

    def _context(self, jvm_id, pid, path, t0, t1):
        """What the helper needs to fill a capture in from JFR: the dumped window once there is one, else the live
        recording of its JVM; and the window, in ms."""
        ctx = dict(t0=int(t0 * 1000), t1=int(t1 * 1000) + 1000)
        if os.path.exists(jfr_path(path)):
            ctx["jfr"] = jfr_path(path)
        elif self.recorder and self.recorder.live(jvm_id):
            ctx["pid"] = pid
        return ctx

    def _row(self, cid):
        with self.db() as c:
            r = c.execute("SELECT jvm_id, pid, path, started, finished, status FROM capture WHERE id = ?", (cid,)).fetchone()
        if not r or not r[2] or not os.path.exists(r[2]) or r[5] not in ("done", "running"):
            raise ValueError("no such capture")
        return r

    def stop(self, cid):
        """Ends a running capture now. Interrupted, the asprof client stops the profiler and writes what it has, as at the
        end of its duration, so the capture finishes as usual, just shorter."""
        p = self.procs.get(cid)
        if not p:
            raise ValueError("no such capture running")
        p.send_signal(signal.SIGTERM)

    def list(self, jvm_id=None, limit=50):
        """Newest first, with the JVM's label and session (from the jvm table: it outlives the JVM, so do its captures)."""
        q = ("SELECT c.id, c.jvm_id, c.pid, c.mode, c.seconds, c.started, c.finished, c.status, c.error, c.bytes, c.kinds, c.opts, j.label, j.sid, c.path"
             " FROM capture c LEFT JOIN jvm j ON j.id = c.jvm_id")
        args = ()
        if jvm_id is not None:
            q += " WHERE c.jvm_id = ?"
            args = (jvm_id,)
        with self.db() as c:
            rows = c.execute(q + " ORDER BY c.started DESC LIMIT ?", (*args, limit)).fetchall()
        out = [dict(id=r[0], jvm_id=r[1], pid=r[2], mode=r[3], mode_label=MODES.get(r[3], (r[3],))[0], seconds=r[4], started=r[5], finished=r[6],
                    status=r[7], error=r[8], bytes=r[9], kinds=json.loads(r[10]) if r[10] else {}, opts=json.loads(r[11]) if r[11] else {},
                    jvm_label=r[12], sid=r[13], jfr=bool(r[14] and os.path.exists(jfr_path(r[14])))) for r in rows]
        for c in out:  # a running capture: what its finished chunks hold so far
            if c["status"] == "running":
                try:
                    _, pid, path, started, _, _ = self._row(c["id"])
                    c["bytes"] = os.path.getsize(path)
                    c["kinds"] = self.helper.call("capture_stats", timeout=10, path=path, **self._context(c["jvm_id"], pid, path, started, time.time()))["stats"].get("kinds", {})
                except Exception:
                    pass
        return out

    def path(self, cid):
        return self._row(cid)[2]

    def _query(self, cid, t0=None, t1=None):
        """The helper's arguments for a capture: its file, JFR's context and the window (all of it, or [t0, t1] within)."""
        jvm_id, pid, path, started, finished, status = self._row(cid)
        ctx = self._context(jvm_id, pid, path, started, finished if status == "done" and finished else time.time())
        if t0 is not None:
            ctx["t0"] = max(ctx["t0"], int(t0 * 1000))
        if t1 is not None:
            ctx["t1"] = min(ctx["t1"], int(t1 * 1000))
        return dict(path=path, **ctx)

    def summary(self, cid, bins=300):
        return self.helper.call("capture_summary", timeout=120, bins=bins, **self._query(cid))["summary"]

    def flame(self, cid, kind, reverse=False, base=None, zoom=None, frames="", classes=False, categories=False, t0=None, t1=None, threads=(), group=None):
        if frames not in ("", "line", "bci"):
            raise ValueError("frames: '', line or bci")
        args = dict(self._query(cid, t0, t1), kind=kind, reverse=reverse, zoom=zoom or [], frames=frames, classes=classes, categories=categories,
                    threads=list(threads), group=group)
        if base:
            args["base"] = self.path(base)
        return self.helper.call("capture_flame", timeout=120, **args)["flame"]

    def html(self, cid, kind, frames="", reverse=False):
        tool = jfrconv()
        if not tool:
            raise RuntimeError("jfrconv (async-profiler's converter) isn't installed")
        if frames not in ("", "line", "bci"):
            raise ValueError("frames: '', line or bci")
        out = self.path(cid)[:-4] + f"-{kind}{'-' + frames if frames else ''}{'-rev' if reverse else ''}.html"
        if not os.path.exists(out):
            flag = {"cpu": "--cpu", "wall": "--wall", "alloc": "--alloc", "live": "--live", "nativemem": "--nativemem", "lock": "--lock", "nativelock": "--lock"}.get(kind, "--cpu")
            r = subprocess.run([tool, flag, *(["--" + frames] if frames else []), *(["--reverse"] if reverse else []), "-o", "html", self.path(cid), out],
                               capture_output=True, text=True, timeout=120)
            if r.returncode != 0:
                raise RuntimeError((r.stderr or r.stdout).strip()[-300:])
        return open(out, encoding="utf-8").read()

    def prune(self, c, now):
        for (path,) in c.execute("SELECT path FROM capture WHERE started < ? AND path IS NOT NULL", (now - RETENTION_DAYS * 86400,)).fetchall():
            for f in [path] + glob.glob(glob.escape(path[:-4]) + "-*"):  # its HTML renderings and JFR's window
                try:
                    os.remove(f)
                except OSError:
                    pass
        c.execute("DELETE FROM capture WHERE started < ?", (now - RETENTION_DAYS * 86400,))
