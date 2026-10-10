"""async-profiler captures (tier 2 of docs/jvm-profiler.md): one JVM, a bounded window, on an explicit click.

`asprof` attaches a native agent that can't be unloaded, so a capture is never automatic. Each one is a JFR file kept
beside the database; the helper reads it on demand for flame graphs and diffs, `jfrconv` renders async-profiler's own
HTML, and the file can be downloaded for JMC.
"""
import json, os, shutil, subprocess, threading, time, traceback

RETENTION_DAYS = 30

# Presets. On macOS, CPU and wall-clock sampling can't run together, so they're separate presets.
MODES = {
    "cpu": ("CPU, allocation, locks", ["-e", "cpu", "--alloc", "512k", "--lock", "10ms"]),
    "wall": ("Wall clock, every thread", ["-e", "wall"]),
    "all": ("Everything (wall, alloc, live, native memory, locks)", ["--all"]),
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS capture (
  id INTEGER PRIMARY KEY, jvm_id INTEGER NOT NULL, pid INTEGER, mode TEXT, seconds INTEGER, started REAL, finished REAL,
  status TEXT, error TEXT, path TEXT, bytes INTEGER, kinds TEXT);
CREATE INDEX IF NOT EXISTS capture_jvm ON capture (jvm_id, started);
"""


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
    def __init__(self, db, helper, tracker, folder):
        self.db, self.helper, self.tracker, self.folder = db, helper, tracker, folder
        os.makedirs(folder, exist_ok=True)
        with db() as c:  # a capture can't survive a restart of the server that was running asprof for it
            c.execute("UPDATE capture SET status = 'failed', error = 'interrupted' WHERE status = 'running'")

    def start(self, jvm_id, mode, seconds, stack_depth=4096):
        if mode not in MODES:
            raise ValueError(f"mode: one of {list(MODES)}")
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
            cid = c.execute("INSERT INTO capture (jvm_id, pid, mode, seconds, started, status) VALUES (?,?,?,?,?, 'running')",
                            (jvm_id, j["pid"], mode, seconds, time.time())).lastrowid
        path = os.path.join(self.folder, f"capture-{cid}-{j['pid']}-{mode}.jfr")
        threading.Thread(target=self._run, args=(cid, tool, j["pid"], mode, seconds, path, stack_depth), daemon=True).start()
        return cid

    def _run(self, cid, tool, pid, mode, seconds, path, stack_depth):
        status, error, kinds, size = "done", None, None, None
        try:
            r = subprocess.run([tool, *MODES[mode][1], "-j", str(stack_depth), "-d", str(seconds), "-o", "jfr", "-f", path, str(pid)],
                               capture_output=True, text=True, timeout=seconds + 60)
            if r.returncode != 0 or not os.path.exists(path):
                raise RuntimeError((r.stderr or r.stdout).strip().splitlines()[-1] if (r.stderr or r.stdout).strip() else f"asprof exited {r.returncode}")
            size = os.path.getsize(path)
            kinds = self.helper.call("capture_stats", timeout=120, path=path)["stats"].get("kinds", {})
        except Exception as e:
            status, error = "failed", str(e)
        with self.db() as c:
            c.execute("UPDATE capture SET status = ?, error = ?, path = ?, bytes = ?, kinds = ?, finished = ? WHERE id = ?",
                      (status, error, path if status == "done" else None, size, json.dumps(kinds) if kinds else None, time.time(), cid))

    def list(self, jvm_id=None, limit=50):
        q = "SELECT id, jvm_id, pid, mode, seconds, started, finished, status, error, bytes, kinds FROM capture"
        args = ()
        if jvm_id is not None:
            q += " WHERE jvm_id = ?"
            args = (jvm_id,)
        with self.db() as c:
            rows = c.execute(q + " ORDER BY started DESC LIMIT ?", (*args, limit)).fetchall()
        return [dict(id=r[0], jvm_id=r[1], pid=r[2], mode=r[3], mode_label=MODES.get(r[3], (r[3],))[0], seconds=r[4], started=r[5], finished=r[6],
                     status=r[7], error=r[8], bytes=r[9], kinds=json.loads(r[10]) if r[10] else {}) for r in rows]

    def path(self, cid):
        with self.db() as c:
            r = c.execute("SELECT path FROM capture WHERE id = ? AND status = 'done'", (cid,)).fetchone()
        if not r or not r[0] or not os.path.exists(r[0]):
            raise ValueError("no such capture")
        return r[0]

    def flame(self, cid, kind, reverse=False, base=None, zoom=None):
        args = dict(path=self.path(cid), kind=kind, reverse=reverse, zoom=zoom or [])
        if base:
            args["base"] = self.path(base)
        return self.helper.call("capture_flame", timeout=120, **args)["flame"]

    def html(self, cid, kind):
        tool = jfrconv()
        if not tool:
            raise RuntimeError("jfrconv (async-profiler's converter) isn't installed")
        out = self.path(cid)[:-4] + f"-{kind}.html"
        if not os.path.exists(out):
            flag = {"cpu": "--cpu", "wall": "--wall", "alloc": "--alloc", "live": "--live", "nativemem": "--nativemem", "lock": "--lock", "nativelock": "--lock"}.get(kind, "--cpu")
            r = subprocess.run([tool, flag, "-o", "html", self.path(cid), out], capture_output=True, text=True, timeout=120)
            if r.returncode != 0:
                raise RuntimeError((r.stderr or r.stdout).strip()[-300:])
        return open(out, encoding="utf-8").read()

    def prune(self, c, now):
        for (path,) in c.execute("SELECT path FROM capture WHERE started < ? AND path IS NOT NULL", (now - RETENTION_DAYS * 86400,)).fetchall():
            for f in [path] + [path[:-4] + f"-{k}.html" for k in ("cpu", "wall", "alloc", "live", "nativemem", "lock", "nativelock")]:
                try:
                    os.remove(f)
                except OSError:
                    pass
        c.execute("DELETE FROM capture WHERE started < ?", (now - RETENTION_DAYS * 86400,))
