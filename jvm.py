"""JVMs: every JVM of the current user, observed through hsperfdata without attaching (tier 0 of docs/jvm-profiler.md).

HotSpot publishes its jstat counters (GC, heap per generation, safepoints, threads, classes, JIT) in a memory-mapped file,
<tmpdir>/hsperfdata_<user>/<pid>. Reading it costs the target nothing: no attach, no safepoint. Counter names vary
between JDKs and collectors, so every counter is optional.
"""
import collections, os, pwd, re, struct, subprocess, tempfile, threading, time, traceback

MINUTE_RETENTION_DAYS = 30
HIST = 120  # in-memory samples per JVM for sparklines (10 min at 5 s)

SCHEMA = """
CREATE TABLE IF NOT EXISTS jvm (
  id INTEGER PRIMARY KEY, pid INTEGER NOT NULL, start_t REAL NOT NULL, label TEXT, main TEXT, version TEXT, gc TEXT, args TEXT,
  sid TEXT, how TEXT, first_t INTEGER, last_t INTEGER, UNIQUE (pid, start_t));
CREATE INDEX IF NOT EXISTS jvm_sid ON jvm (sid, last_t);
CREATE TABLE IF NOT EXISTS jvm_minute (
  t INTEGER NOT NULL, jvm_id INTEGER NOT NULL, cpu REAL, rss INTEGER, heap_used INTEGER, heap_committed INTEGER, heap_max INTEGER,
  gc_pct REAL, sp_pct REAL, alloc REAL, threads INTEGER, classes INTEGER, young_gcs INTEGER, full_gcs INTEGER,
  PRIMARY KEY (jvm_id, t)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS jvm_minute_t ON jvm_minute (t);
"""


def prune(c, now):
    c.execute("DELETE FROM jvm_minute WHERE t < ?", (now - MINUTE_RETENTION_DAYS * 86400,))
    c.execute("DELETE FROM jvm WHERE last_t < ?", (now - MINUTE_RETENTION_DAYS * 86400,))


# ---------------------------------------------------------------------------------------------
# hsperfdata

def perf_dirs():
    """hsperfdata_<user> directories. On macOS HotSpot uses the per-user Darwin temp dir, whatever $TMPDIR says."""
    roots = {tempfile.gettempdir(), "/tmp"}
    try:
        roots.add(subprocess.run(["getconf", "DARWIN_USER_TEMP_DIR"], capture_output=True, text=True, timeout=5).stdout.strip())
    except Exception:
        pass
    user = pwd.getpwuid(os.getuid()).pw_name  # as HotSpot does; $USER may be unset or different
    return sorted({os.path.realpath(d) for r in roots if r for d in [os.path.join(r, "hsperfdata_" + user)] if os.path.isdir(d)})


_HEADER = struct.Struct("iiqii")  # used, overflow, modification time stamp, entry offset, number of entries (after magic+version)
_MAGIC = 0xcafec0c0


def read_perfdata(path):
    """Counters of one JVM as {name: int | str}, or None if the file isn't (yet) a valid perf data file."""
    try:
        with open(path, "rb") as f:
            b = f.read()
    except OSError:
        return None
    if len(b) < 32 or struct.unpack(">I", b[:4])[0] != _MAGIC or not b[7]:  # magic; byte 7: accessible (initialised)
        return None
    e = "<" if b[4] == 1 else ">"
    _, _, _, off, n = struct.unpack(e + _HEADER.format, b[8:32])
    entry = struct.Struct(e + "iiibbbbi")  # length, name offset, vector length, type, flags, units, variability, data offset
    out = {}
    for _ in range(n):
        if off + entry.size > len(b):
            break
        elen, noff, vlen, dtype, _, _, _, doff = entry.unpack_from(b, off)
        if elen <= 0:
            break
        end = b.find(b"\0", off + noff)
        name = b[off + noff:end].decode("ascii", "replace")
        if dtype == 74 and vlen == 0:  # 'J': a long
            out[name] = struct.unpack_from(e + "q", b, off + doff)[0]
        elif dtype == 66:  # 'B': a byte vector, i.e. a string
            out[name] = b[off + doff:off + doff + vlen].split(b"\0", 1)[0].decode("utf-8", "replace")
        off += elen
    return out


# ---------------------------------------------------------------------------------------------
# What a JVM is

KNOWN = [  # (pattern on the main class / jar, label), first match wins
    (r"sbt\.ForkMain", "sbt forked test JVM"),
    (r"sbt-launch|xsbt\.boot\.Boot|sbt\.internal\.client", "sbt server"),
    (r"bloop\.BloopServer|bloop\.Server", "Bloop"),
    (r"scala\.meta\.metals", "Metals"),
    (r"org\.gradle\.launcher\.daemon", "Gradle daemon"),
    (r"GradleWorkerMain|org\.gradle\.process\.internal\.worker", "Gradle worker"),
    (r"GradleWrapperMain|org\.gradle\.launcher\.GradleMain", "Gradle client"),
    (r"org\.jetbrains\.kotlin\.daemon", "Kotlin daemon"),
    (r"org\.mvndaemon|mvnd", "Maven daemon"),
    (r"org\.codehaus\.plexus\.classworlds|org\.apache\.maven", "Maven"),
    (r"surefire|failsafe", "Maven test JVM"),
    (r"com\.intellij\.idea\.Main", "IntelliJ IDEA"),
    (r"org\.jetbrains\.jps", "IntelliJ build (JPS)"),
    (r"jetbrains-toolbox", "JetBrains Toolbox"),
    (r"org\.jetbrains\.idea\.maven\.server", "IntelliJ Maven server"),
    (r"scala\.cli|scala-cli", "Scala CLI"),
    (r"coursier", "Coursier"),
]
TOOL_MAIN = re.compile(r"^(sun\.tools\.|jdk\.jcmd/|jdk\.jartool/|jdk\.jfr/|jdk\.jshell/)")  # jcmd, jps, jstat...: short-lived noise


def jvm_label(cmd, args):
    m = re.match(r"(?:jdk\.compiler/)?com\.sun\.tools\.javac\.launcher\.\w+\s+(\S+\.java)", cmd or "")
    if m:  # java Foo.java: the source launcher
        return os.path.basename(m.group(1))
    hay = (cmd or "") + " " + (args or "")
    for pat, label in KNOWN:
        if re.search(pat, hay):
            return label
    main = (cmd or "").split(" ", 1)[0]
    if main.endswith(".jar"):
        return os.path.basename(main)
    if main:
        return main.rsplit("/", 1)[-1].rsplit(".", 1)[-1]
    exe = (args or "?").split(" ", 1)[0]
    return os.path.basename(exe)[:40]


def _gens(c):
    """[(name, used, capacity, max)] per generation, plus metaspace."""
    out = []
    for g in range(4):
        pre = f"sun.gc.generation.{g}."
        if pre + "name" not in c:
            continue
        used = sum(v for k, v in c.items() if k.startswith(pre + "space.") and k.endswith(".used"))
        out.append((c[pre + "name"], used, c.get(pre + "capacity", 0), c.get(pre + "maxCapacity", 0)))
    return out


def _heap_max(c, gens, args):
    m = re.findall(r"-Xmx(\d+)([kKmMgGtT]?)", args or "")
    if m:
        n, u = m[-1]
        return int(n) * {"": 1, "k": 1 << 10, "m": 1 << 20, "g": 1 << 30, "t": 1 << 40}[u.lower()]
    maxes = [g[3] for g in gens if g[3]]
    if not maxes:
        return 0
    # G1, ZGC, Shenandoah report the whole heap as each generation's max; generational collectors report their own share
    return maxes[0] if len(set(maxes)) == 1 else sum(maxes)


def _is_full(name):
    return bool(re.search(r"full|MarkSweep|MSC|ParallelCompact", name or "", re.I))  # not ZGC's "major": concurrent, tiny pauses


def derive(c, prev, dt):
    """The metrics we show, from one sample of counters and (optionally) the previous one dt seconds earlier."""
    freq = c.get("sun.os.hrt.frequency") or 1
    gens = _gens(c)
    args = c.get("java.rt.vmArgs", "")
    colls = [(c.get(f"sun.gc.collector.{i}.name", ""), c.get(f"sun.gc.collector.{i}.invocations", 0), c.get(f"sun.gc.collector.{i}.time", 0))
             for i in range(4) if f"sun.gc.collector.{i}.invocations" in c]
    eden = next(((c.get(f"sun.gc.generation.0.space.{i}.used", 0), c.get(f"sun.gc.generation.0.space.{i}.capacity", 0))
                 for i in range(3) if c.get(f"sun.gc.generation.0.space.{i}.name") == "eden"), None)
    young = sum(n for name, n, _ in colls if not _is_full(name) and "concurrent" not in name.lower())
    m = dict(
        heap_used=sum(g[1] for g in gens), heap_committed=sum(g[2] for g in gens), heap_max=_heap_max(c, gens, args),
        gens=[dict(name=g[0], used=g[1], cap=g[2]) for g in gens],
        meta_used=c.get("sun.gc.metaspace.used", 0),
        threads=c.get("java.threads.live", 0), daemon=c.get("java.threads.daemon", 0),
        classes=c.get("java.cls.loadedClasses", 0) + c.get("java.cls.sharedLoadedClasses", 0)
        - c.get("java.cls.unloadedClasses", 0) - c.get("java.cls.sharedUnloadedClasses", 0),
        gc_count=sum(n for _, n, _ in colls), young_gcs=young, full_gcs=sum(n for name, n, _ in colls if _is_full(name)),
        _gc_ticks=sum(t for _, _, t in colls), _sp_ticks=c.get("sun.rt.safepointTime", 0), _jit_ticks=c.get("sun.ci.totalTime", 0), _eden=eden,
        gc_pct=None, sp_pct=None, jit_pct=None, alloc=None,
    )
    if prev and dt > 0:
        span = dt * freq / 100  # ticks in 1% of the interval
        m["gc_pct"] = round(max(0, m["_gc_ticks"] - prev["_gc_ticks"]) / span, 1)
        m["sp_pct"] = round(max(0, m["_sp_ticks"] - prev["_sp_ticks"]) / span, 1)
        m["jit_pct"] = round(max(0, m["_jit_ticks"] - prev["_jit_ticks"]) / span, 1)
        if eden and prev["_eden"] and m["gc_pct"] < 50:  # when collecting most of the time, eden isn't full at each GC
            # Allocation goes to eden. Across a young GC, assume eden was filled to capacity before each collection.
            (u, cap), (pu, pcap) = eden, prev["_eden"]
            ny = m["young_gcs"] + m["full_gcs"] - prev["young_gcs"] - prev["full_gcs"]  # a full GC empties eden too
            m["alloc"] = max(0, u - pu if ny <= 0 else (pcap - pu) + (ny - 1) * cap + u) / dt
    return m


# ---------------------------------------------------------------------------------------------
# Tracker

class JvmTracker:
    """Called by the Sampler every tick: reads every JVM's perf data, keeps a short history, writes per-minute rows."""

    def __init__(self, db):
        self.db = db
        self.dirs = perf_dirs()
        self.lock = threading.Lock()
        self.jvms = {}  # (pid, start) -> state
        self.minute = None
        self.acc = {}  # jvm id -> accumulators for the current minute

    def _identify(self, pid, start, info):
        with self.db() as c:
            c.execute("INSERT OR IGNORE INTO jvm (pid, start_t, label, main, version, gc, args, first_t, last_t) VALUES (?,?,?,?,?,?,?,?,?)",
                      (pid, start, info["label"], info["main"], info["version"], info["gc"], info["args"], int(time.time()), int(time.time())))
            return c.execute("SELECT id FROM jvm WHERE pid = ? AND start_t = ?", (pid, start)).fetchone()[0]

    def pids(self):
        """Pids with perf data, so attribution can look at JVMs too small to be considered otherwise."""
        out = set()
        for d in self.dirs:
            try:
                out.update(int(n) for n in os.listdir(d) if n.isdigit())
            except OSError:
                pass
        return out

    def sample(self, now, procs, cpu_of, owner):
        seen = {}
        for d in self.dirs:
            try:
                names = os.listdir(d)
            except OSError:
                continue
            for name in names:
                if not name.isdigit():
                    continue
                pid = int(name)
                p = procs.get(pid)
                if not p or pid == os.getpid():
                    continue  # a stale file from a JVM that died without cleaning up, or not ours to show
                c = read_perfdata(os.path.join(d, name))
                if not c:
                    continue
                cmd = c.get("sun.rt.javaCommand", "")
                if TOOL_MAIN.match(cmd):
                    continue
                start = (c.get("sun.rt.createVmBeginTime") or 0) / 1000
                key = (pid, start)
                old = self.jvms.get(key)
                if old is None:
                    info = dict(label=jvm_label(cmd, p["args"]), main=cmd[:300], gc=c.get("sun.gc.policy.name") or _gc_from_collectors(c),
                                version=c.get("java.property.java.vm.version") or c.get("java.property.java.version", ""),
                                vendor=c.get("java.property.java.vm.vendor", ""), args=c.get("java.rt.vmArgs", "")[:2000],
                                home=c.get("java.property.java.home", ""))
                    try:
                        info["id"] = self._identify(pid, start, info)
                    except Exception:
                        traceback.print_exc()
                        continue
                    old = dict(info, pid=pid, start=start, hist=collections.deque(maxlen=HIST), m=None, t=None, full_t=None)
                m = derive(c, old["m"], now - old["t"] if old["t"] else 0)
                if old["m"] and m["full_gcs"] > old["m"]["full_gcs"]:
                    old["full_t"] = now
                o = owner.get(pid)
                old.update(m=m, t=now, cpu=round(cpu_of.get(pid, 0.0), 1), rss=p["rss"], sid=o[0] if o else None, how=o[1] if o else None)
                if m["gc_pct"] is not None:
                    old["hist"].append((round(now), old["cpu"], m["heap_used"], m["gc_pct"]))
                seen[key] = old
        with self.lock:
            self.jvms = seen
        self._persist(now)

    def _persist(self, now):
        minute = int(now // 60)
        if self.minute is not None and minute != self.minute:
            try:
                self._flush(self.minute * 60)
            except Exception:
                traceback.print_exc()
            self.acc.clear()
        self.minute = minute
        for j in self.jvms.values():
            m = j["m"]
            if m["gc_pct"] is None:
                continue
            a = self.acc.setdefault(j["id"], dict(n=0, cpu=0.0, rss=0, heap_used=0, gc_pct=0.0, sp_pct=0.0, alloc=0.0, threads=0, heap_committed=0, heap_max=0,
                                                  classes=0, y0=m["young_gcs"], f0=m["full_gcs"], sid=j["sid"], how=j["how"]))
            a["n"] += 1
            a["cpu"] += j["cpu"]
            a["gc_pct"] += m["gc_pct"]
            a["sp_pct"] += m["sp_pct"]
            a["rss"] += j["rss"]
            a["heap_used"] += m["heap_used"]
            a["alloc"] += m["alloc"] or 0
            a["threads"] += m["threads"]
            a["heap_committed"] = max(a["heap_committed"], m["heap_committed"])
            a["heap_max"] = max(a["heap_max"], m["heap_max"])
            a["classes"], a["y1"], a["f1"] = m["classes"], m["young_gcs"], m["full_gcs"]
            a["sid"], a["how"] = a["sid"] or j["sid"], a["how"] or j["how"]

    def _flush(self, t):
        rows = []
        for jid, a in self.acc.items():
            n = a["n"]
            rows.append((t, jid, round(a["cpu"] / n, 1), int(a["rss"] / n), int(a["heap_used"] / n), a["heap_committed"], a["heap_max"],
                         round(a["gc_pct"] / n, 2), round(a["sp_pct"] / n, 2), round(a["alloc"] / n), round(a["threads"] / n), a["classes"],
                         a["y1"] - a["y0"], a["f1"] - a["f0"]))
        with self.db() as c:
            c.executemany("INSERT OR REPLACE INTO jvm_minute VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
            c.executemany("UPDATE jvm SET last_t = ?, sid = COALESCE(sid, ?), how = COALESCE(how, ?) WHERE id = ?",
                          [(t, a["sid"], a["how"], jid) for jid, a in self.acc.items()])

    def snapshot(self, now):
        """The current JVMs for /api/state, with health flags."""
        with self.lock:
            jvms = list(self.jvms.values())
        out = []
        for j in jvms:
            m = j["m"]
            h = list(j["hist"])
            recent = [x for x in h if x[0] >= now - 60]
            flags = []
            if recent and sum(x[3] for x in recent) / len(recent) >= 20:
                flags.append("gc")  # sustained: a fifth of wall time in GC pauses over the last minute
            if len(recent) >= 6 and m["heap_max"] and min(x[2] for x in recent) >= 0.85 * m["heap_max"]:
                flags.append("heap")  # even right after collections, the heap stays near its max
            if j["full_t"] and now - j["full_t"] < 300:
                flags.append("full")
            out.append(dict(
                id=j["id"], pid=j["pid"], start=j["start"], label=j["label"], main=j["main"], version=j["version"], vendor=j["vendor"],
                gc=j["gc"], args=j["args"], sid=j["sid"], how=j["how"], cpu=j["cpu"], rss=j["rss"],
                flags=flags, spark=[[x[0], x[1], x[2], x[3]] for x in h[-60:]],
                **{k: v for k, v in m.items() if not k.startswith("_")}))
        return sorted(out, key=lambda j: (-j["cpu"], -j["rss"]))


def _gc_from_collectors(c):
    n = c.get("sun.gc.collector.0.name", "")
    return n.split(" ")[0] if n else ""


def history(db, jvm_id, since):
    """Per-minute rows of one JVM: [[t, cpu, rss, heap_used, heap_committed, heap_max, gc_pct, sp_pct, alloc, threads, classes, young_gcs, full_gcs]]."""
    with db() as c:
        return [list(r) for r in c.execute(
            """SELECT t, cpu, rss, heap_used, heap_committed, heap_max, gc_pct, sp_pct, alloc, threads, classes, young_gcs, full_gcs
               FROM jvm_minute WHERE jvm_id = ? AND t >= ? ORDER BY t""", (jvm_id, since))]
