"""The Java helper (profiler/): attaches to JVMs on our behalf. Started on first use, stopped when idle.

One JSON request per line on its stdin, one response per line on its stdout, matched by id (see profiler/.../Main.java).
"""
import itertools, json, os, shutil, subprocess, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
JAR = os.path.join(HERE, "profiler", "target", "agentscope-profiler.jar")
IDLE_EXIT = 300  # seconds without a request before the helper JVM is stopped
# The helper holds every recorded JVM's last 30 minutes and parses their JFR streams: give it room, and C2.
HEAP = os.environ.get("AGENTSCOPE_HELPER_HEAP", "1g")


def java():
    home = os.environ.get("JAVA_HOME")
    if home and os.path.exists(os.path.join(home, "bin", "java")):
        return os.path.join(home, "bin", "java")
    return shutil.which("java")


class Helper:
    def __init__(self, jar=JAR):
        self.jar = jar
        self.lock = threading.Lock()
        self.proc = None
        self.ids = itertools.count(1)
        self.pending = {}  # id -> [event, response]
        self.last_used = 0
        self.gen = 0  # bumped on every (re)start: state the helper held, like followed recordings, is gone
        self.keepalive = lambda: False  # e.g. while recordings are being followed

    def unavailable(self):
        """Why the helper can't run, or None."""
        if not os.path.exists(self.jar):
            return "the JVM helper isn't built: run `mise run build-profiler` (needs JDK 21+)"
        if not java():
            return "no java found (set JAVA_HOME)"
        return None

    def _start(self):
        self.gen += 1
        self.proc = subprocess.Popen([java(), f"-Xmx{HEAP}", "-jar", self.jar],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
        threading.Thread(target=self._read, args=(self.proc,), daemon=True).start()
        threading.Thread(target=self._reap, args=(self.proc,), daemon=True).start()

    def _read(self, proc):
        for line in proc.stdout:
            try:
                r = json.loads(line)
            except ValueError:
                continue
            p = self.pending.pop(r.get("id"), None)
            if p:
                p[1] = r
                p[0].set()
        for p in list(self.pending.values()):  # the helper died: fail whatever was waiting
            p[0].set()

    def _reap(self, proc):
        while proc.poll() is None:
            time.sleep(10)
            with self.lock:
                if self.proc is proc and not self.pending and not self.keepalive() and time.time() - self.last_used > IDLE_EXIT:
                    proc.stdin.close()
                    self.proc = None

    def call(self, op, timeout=30, **args):
        """Send one request; returns the response dict, or raises RuntimeError with the helper's error."""
        why = self.unavailable()
        if why:
            raise RuntimeError(why)
        ev = threading.Event()
        with self.lock:
            if self.proc is None or self.proc.poll() is not None:
                self._start()
            rid = next(self.ids)
            slot = self.pending[rid] = [ev, None]
            self.last_used = time.time()
            self.proc.stdin.write(json.dumps(dict(args, id=rid, op=op)) + "\n")
            self.proc.stdin.flush()
        if not ev.wait(timeout):
            self.pending.pop(rid, None)
            raise RuntimeError(f"the helper didn't answer within {timeout}s")
        r = slot[1]
        if r is None:
            raise RuntimeError("the helper exited")
        if "error" in r:
            raise RuntimeError(r["error"])
        return r
