"""Continuous JFR recording (tier 1 of docs/jvm-profiler.md): opt-in, via the page's Record button.

While Record is on, every JVM in scope (agent JVMs, or all of yours) gets an `agentscope` JFR recording once it has
been up a few seconds, and the Java helper follows it. A JVM can also be switched on or off by hand. Recordings stop
when Record goes off and when the server exits; pids are remembered on disk so a crash's leftovers are stopped on the
next start.
"""
import concurrent.futures, json, os, queue, re, threading, time, traceback

import profiles

MIN_UPTIME = 5  # seconds before a new JVM is worth attaching to
MIN_JDK = 14  # live streaming from a repository needs JDK 14+ on the recording side
# Stack depth: JFR's default is 64, too shallow for a compiler's recursion; async-profiler's is 2048.
DEFAULTS = dict(record_depth=512, capture_depth=4096)
DEPTHS = dict(record_depth=(64, 2048), capture_depth=(256, 16384))


def jdk_major(version):
    m = re.match(r"(?:1\.)?(\d+)", version or "")
    return int(m.group(1)) if m else 0


class Recorder:
    def __init__(self, tracker, helper, state_file, db=None):
        self.tracker, self.helper, self.state_file, self.db = tracker, helper, state_file, db
        self.stored = dict(t=0, first=None)  # earliest stored minute, refreshed now and then
        self.lock = threading.Lock()
        self.on, self.scope, self.since = False, "agents", None
        self.manual = {}  # jvm id -> True / False: the user's choice for that JVM, over the global switch
        self.recs = {}  # jvm id -> dict(pid, since, live, error, gen)
        self.work = queue.Queue()
        self.queued = set()  # (op, jvm id) waiting for the worker, so ticks don't pile up duplicates
        self.settings = dict(DEFAULTS)
        self._ta_cache = {}
        helper.keepalive = lambda: any(r["live"] for r in self.recs.values())
        threading.Thread(target=self._worker, daemon=True).start()
        threading.Thread(target=self._poll, daemon=True).start()
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

    def set_settings(self, **kv):
        with self.lock:
            for k, v in kv.items():
                if k in DEPTHS and v is not None:
                    lo, hi = DEPTHS[k]
                    self.settings[k] = max(lo, min(int(v), hi))
        self._save()
        return dict(self.settings)

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
                    r.update(live=False, ended=now)  # the JVM exited; its profile stays browsable in the helper
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
                    rec = self.helper.call("record_start", timeout=60, pid=pid, stack_depth=self.settings["record_depth"])["recording"]
                    with self.lock:
                        self.recs[jid] = dict(pid=pid, since=self.recs.get(jid, {}).get("since") or rec["since"] / 1000, live=True,
                                              error=None, gen=self.helper.gen, adopted=rec.get("adopted"), stack_depth=rec.get("stack_depth"))
                else:
                    self.helper.call("record_stop", timeout=60, pid=pid)
                    with self.lock:
                        if jid in self.recs:
                            self.recs[jid].update(live=False, ended=time.time())
            except Exception as e:
                with self.lock:
                    r = self.recs.setdefault(jid, dict(pid=pid, since=None, live=False))
                    r.update(error=str(e), tried=time.time())
            finally:
                with self.lock:
                    self.queued.discard((op, jid))
                self._save()

    # -------------------------------------------------------------- what recorded JVMs are doing, and storing it

    def _poll(self, period=5):
        while True:
            time.sleep(period)
            try:
                self._activities()
                self._store_minutes()
                self.stored_first()
            except Exception:
                traceback.print_exc()

    def _activities(self, window=30):
        with self.lock:
            live = [(jid, r["pid"]) for jid, r in self.recs.items() if r["live"] and r.get("gen") == self.helper.gen]
        for jid, pid in live:
            acts = self.helper.call("activities", pid=pid, since=int((time.time() - window) * 1000))["activities"]
            total = sum(a["samples"] for a in acts) or 1
            with self.lock:
                if jid in self.recs:
                    self.recs[jid]["activities"] = [[a["activity"], round(a["samples"] / total * 100), a["threads"]] for a in acts[:4]]

    def _store_minutes(self):
        """Every complete minute of every recording (live, or ended in the last couple of minutes) goes to SQLite once."""
        if not self.db:
            return
        now = time.time()
        this_minute = int(now // 60) * 60
        with self.lock:
            todo = [(jid, dict(r)) for jid, r in self.recs.items() if r.get("gen") == self.helper.gen and r.get("since")
                    and (r["live"] or now - r.get("ended", 0) < 120)]
        for jid, r in todo:
            start = r.get("stored_to") or int(r["since"] // 60) * 60
            for t in range(max(start, this_minute - 1800), this_minute, 60):
                profiles.store_minute(self.db, self.helper, r["gen"], r["pid"], jid, t)
                with self.lock:
                    self.recs[jid]["stored_to"] = t + 60

    def thread_activity(self, window=300, bins=150):
        """Every recorded JVM's threads, what they're doing now and per time bin, for the machine-wide live view.
        Queried in parallel; cached a couple of seconds since every open page polls it."""
        key = (window, bins)
        hit = self._ta_cache.get(key)
        if hit and time.time() - hit[0] < 2:
            return hit[1]
        with self.lock:
            live = [(jid, r["pid"]) for jid, r in self.recs.items() if r["live"] and r.get("gen") == self.helper.gen]
        since = int((time.time() - window) * 1000)

        def one(job):
            jid, pid = job
            try:
                return jid, self.helper.call("thread_activity", timeout=10, pid=pid, since=since, bins=bins)["threads"]
            except Exception as e:
                return jid, dict(error=str(e))
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
            out = dict(now=time.time(), since=since / 1000, window=window, jvms={str(jid): r for jid, r in ex.map(one, live)})
        self._ta_cache[key] = (time.time(), out)
        return out

    def stored_first(self):
        if self.db and time.time() - self.stored["t"] > 60:
            with self.db() as c:
                self.stored.update(t=time.time(), first=c.execute("SELECT MIN(t) FROM sample_blob").fetchone()[0])
        return self.stored["first"]

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
        """The switch, scope and per-JVM choices survive a restart; so do the pids, to clean up after a crash."""
        try:
            pids = sorted({r["pid"] for r in self.recs.values() if r["live"]})
            with open(self.state_file, "w") as f:
                json.dump(dict(pids=pids, on=self.on, scope=self.scope, since=self.since, manual={str(k): v for k, v in self.manual.items()},
                               settings=self.settings), f)
        except OSError:
            pass

    def _stop_leftovers(self):
        try:
            saved = json.load(open(self.state_file))
        except (OSError, ValueError):
            return
        self.on, self.scope, self.since = bool(saved.get("on")), saved.get("scope") or "agents", saved.get("since")
        self.manual = {int(k): v for k, v in (saved.get("manual") or {}).items()}
        self.settings.update({k: v for k, v in (saved.get("settings") or {}).items() if k in DEFAULTS})
        if self.on or any(self.manual.values()):
            return  # recording carries on: reconcile adopts the running 'agentscope' recordings instead of restarting them
        for pid in saved.get("pids", []):
            try:
                os.kill(pid, 0)
            except OSError:
                continue
            threading.Thread(target=lambda p=pid: _quiet(lambda: self.helper.call("record_stop", timeout=30, pid=p)), daemon=True).start()

    # -------------------------------------------------------------- reads

    def state(self, now):
        with self.lock:
            return dict(on=self.on, scope=self.scope, since=self.since, manual={str(k): v for k, v in self.manual.items()},
                        jvms={str(k): dict(since=r.get("since"), live=r["live"], error=r.get("error"), activities=r.get("activities") if r["live"] else None,
                                           stack_depth=r.get("stack_depth")) for k, r in self.recs.items()},
                        stored_since=self.stored["first"], settings=dict(self.settings))

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
