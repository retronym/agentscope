"""Continuous JFR recording (tier 1 of docs/jvm-profiler.md): opt-in, via the page's Record button.

While Record is on, every JVM in scope (agent JVMs, or all of yours) gets an `agentscope` JFR recording once it has
been up a few seconds, and the Java helper follows it. A JVM can also be switched on or off by hand. Recordings stop
when Record goes off and when the server exits; pids are remembered on disk so a crash's leftovers are stopped on the
next start.
"""
import json, os, queue, re, threading, time, traceback

MIN_UPTIME = 5  # seconds before a new JVM is worth attaching to
MIN_JDK = 14  # live streaming from a repository needs JDK 14+ on the recording side


def jdk_major(version):
    m = re.match(r"(?:1\.)?(\d+)", version or "")
    return int(m.group(1)) if m else 0


class Recorder:
    def __init__(self, tracker, helper, state_file):
        self.tracker, self.helper, self.state_file = tracker, helper, state_file
        self.lock = threading.Lock()
        self.on, self.scope, self.since = False, "agents", None
        self.manual = {}  # jvm id -> True / False: the user's choice for that JVM, over the global switch
        self.recs = {}  # jvm id -> dict(pid, since, live, error, gen)
        self.work = queue.Queue()
        self.queued = set()  # (op, jvm id) waiting for the worker, so ticks don't pile up duplicates
        helper.keepalive = lambda: any(r["live"] for r in self.recs.values())
        threading.Thread(target=self._worker, daemon=True).start()
        self._stop_leftovers()

    # -------------------------------------------------------------- controls (from HTTP handlers)

    def set(self, on, scope=None):
        with self.lock:
            if scope in ("agents", "all"):
                self.scope = scope
            if on and not self.on:
                self.since = time.time()
                self.manual = {k: v for k, v in self.manual.items() if v}  # a fresh Record forgets earlier opt-outs
            self.on = bool(on)
            if not on:
                self.manual.clear()
        self.reconcile()

    def set_jvm(self, jvm_id, on):
        with self.lock:
            self.manual[jvm_id] = bool(on)
        self.reconcile()

    # -------------------------------------------------------------- what should be recording

    def wanted(self, j, now):
        if j["label"] == "agentscope helper" or jdk_major(j["version"]) < MIN_JDK:
            return False
        if j["id"] in self.manual:
            return self.manual[j["id"]]
        return self.on and (self.scope == "all" or bool(j["sid"])) and now - j["start"] >= MIN_UPTIME

    def reconcile(self):
        """Called every sampler tick and after any control change; the starting and stopping happens on a worker."""
        now = time.time()
        with self.tracker.lock:
            jvms = list(self.tracker.jvms.values())
        alive = {j["id"] for j in jvms}
        with self.lock:
            for j in jvms:
                r = self.recs.get(j["id"])
                want = self.wanted(j, now)
                # a restarted helper has lost its streams: start again, which adopts the running recording
                have = r is not None and r["live"] and r.get("gen") == self.helper.gen
                if want and not have and not (r and r.get("error") and r.get("tried", 0) > now - 60):
                    self._queue("start", j["id"], j["pid"])
                elif not want and r and r["live"]:
                    self._queue("stop", j["id"], j["pid"])
            for jid, r in self.recs.items():
                if jid not in alive and r["live"]:
                    r["live"] = False  # the JVM exited; its profile stays browsable in the helper
        self._save()

    def _queue(self, op, jid, pid):
        if (op, jid) not in self.queued:
            self.queued.add((op, jid))
            self.work.put((op, jid, pid))

    def _worker(self):
        while True:
            op, jid, pid = self.work.get()
            try:
                if op == "start":
                    rec = self.helper.call("record_start", timeout=60, pid=pid)["recording"]
                    with self.lock:
                        self.recs[jid] = dict(pid=pid, since=self.recs.get(jid, {}).get("since") or rec["since"] / 1000, live=True,
                                              error=None, gen=self.helper.gen, adopted=rec.get("adopted"))
                else:
                    self.helper.call("record_stop", timeout=60, pid=pid)
                    with self.lock:
                        if jid in self.recs:
                            self.recs[jid]["live"] = False
            except Exception as e:
                with self.lock:
                    r = self.recs.setdefault(jid, dict(pid=pid, since=None, live=False))
                    r.update(error=str(e), tried=time.time())
            finally:
                with self.lock:
                    self.queued.discard((op, jid))
                self._save()

    # -------------------------------------------------------------- shutdown and leftovers

    def stop_all(self):
        """On exit: stop every recording we own, synchronously (the helper is about to go)."""
        with self.lock:
            live = [(jid, r["pid"]) for jid, r in self.recs.items() if r["live"]]
        for jid, pid in live:
            try:
                self.helper.call("record_stop", timeout=15, pid=pid)
                self.recs[jid]["live"] = False
            except Exception:
                traceback.print_exc()
        self._save()

    def _save(self):
        try:
            pids = sorted({r["pid"] for r in self.recs.values() if r["live"]})
            with open(self.state_file, "w") as f:
                json.dump(dict(pids=pids), f)
        except OSError:
            pass

    def _stop_leftovers(self):
        try:
            pids = json.load(open(self.state_file)).get("pids", [])
        except (OSError, ValueError):
            return
        for pid in pids:
            try:
                os.kill(pid, 0)
            except OSError:
                continue
            threading.Thread(target=lambda p=pid: _quiet(lambda: self.helper.call("record_stop", timeout=30, pid=p)), daemon=True).start()

    # -------------------------------------------------------------- reads

    def state(self, now):
        with self.lock:
            return dict(on=self.on, scope=self.scope, since=self.since, manual={str(k): v for k, v in self.manual.items()},
                        jvms={str(k): dict(since=r.get("since"), live=r["live"], error=r.get("error")) for k, r in self.recs.items()})

    def pid_of(self, jvm_id):
        with self.lock:
            r = self.recs.get(jvm_id)
        if not r:
            raise ValueError("that JVM hasn't been recorded")
        return r["pid"]


def _quiet(f):
    try:
        f()
    except Exception:
        pass
