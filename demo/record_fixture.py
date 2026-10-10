#!/usr/bin/env python3
"""Record the demo's profiles: real JVMs building public code, recorded the way agentscope records any JVM.

The static demo shows the profiler working (Activity, a JVM's heatmap, lanes and flame graph, Across JVMs) on these
recordings rather than on the user's own, whose class and package names would leak. Three workloads run side by side:

  - sbt, compiling and testing a generated Scala 2.13 project (dependency resolution, zinc, scalac phases, munit)
  - javac, compiling generated sources in a loop (the overhead benchmark's workload)
  - a small Java service: a worker pool hashing and parsing, with a contended lock and a parked queue

Each is recorded with agentscope's helper (JFR, agentscope.jfc) and dumped raw; the fixture keeps what the page needs,
subsampled to stay small. Run it again after changing what the profiler records or how it classifies activities.

Usage: python3 demo/record_fixture.py [--minutes 8] [--out demo/fixture/profiles.json.gz]
"""
import argparse, gzip, json, os, random, shutil, signal, subprocess, sys, textwrap, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import helper as H  # noqa: E402

SBT_VERSION, SCALA_VERSION, MUNIT_VERSION = "1.12.15", "2.13.18", "1.0.0"


# ---------------------------------------------------------------------------------------------- workloads

def scala_project(d, files=48):
    """A Scala project with enough type-level work to keep every compiler phase busy, and tests that compute."""
    os.makedirs(os.path.join(d, "project"), exist_ok=True)
    open(os.path.join(d, "project", "build.properties"), "w").write(f"sbt.version={SBT_VERSION}\n")
    open(os.path.join(d, "build.sbt"), "w").write(textwrap.dedent(f"""\
        scalaVersion := "{SCALA_VERSION}"
        libraryDependencies += "org.scalameta" %% "munit" % "{MUNIT_VERSION}" % Test
        scalacOptions ++= Seq("-deprecation", "-feature")
        Global / excludeLintKeys += Global / onChangedBuildSource
    """))
    src, tst = os.path.join(d, "src/main/scala/shapes"), os.path.join(d, "src/test/scala/shapes")
    os.makedirs(src, exist_ok=True)
    os.makedirs(tst, exist_ok=True)
    r = random.Random(7)
    for i in range(files):
        defs = []
        for k in range(14):
            defs.append(textwrap.dedent(f"""\
                sealed trait Expr{k}
                final case class Num{k}(v: Int) extends Expr{k}
                final case class Add{k}(a: Expr{k}, b: Expr{k}) extends Expr{k}
                final case class Mul{k}(a: Expr{k}, b: Expr{k}) extends Expr{k}
                final case class Neg{k}(a: Expr{k}) extends Expr{k}
                object Expr{k} {{
                  def eval(e: Expr{k}): Int = e match {{
                    case Num{k}(v) => v
                    case Add{k}(Num{k}(0), b) => eval(b)
                    case Add{k}(a, b) => eval(a) + eval(b)
                    case Mul{k}(Num{k}(1), b) => eval(b)
                    case Mul{k}(a, b) => eval(a) * eval(b)
                    case Neg{k}(Neg{k}(a)) => eval(a)
                    case Neg{k}(a) => -eval(a)
                  }}
                  implicit val ord{k}: Ordering[Expr{k}] = Ordering.by(eval)
                  def gen(n: Int): Expr{k} = if (n <= 0) Num{k}(n % {r.randint(3, 9)}) else if (n % 3 == 0) Add{k}(gen(n - 1), gen(n - 2)) else if (n % 3 == 1) Mul{k}(gen(n - 1), Num{k}(1)) else Neg{k}(gen(n - 1))
                  def table[F[_]](xs: List[Int])(implicit F: Folder[F]): Map[String, List[(Int, Option[String])]] =
                    xs.groupBy(x => (x % {r.randint(2, 7)}).toString).view.mapValues(_.map(x => x -> Option(x).filter(_ > 0).map(_.toString)).sortBy(_._1)).toMap
                }}
            """))
        open(os.path.join(src, f"Model{i}.scala"), "w").write(
            ("package shapes\n\ntrait Folder[F[_]] { def fold[A](xs: List[A]): F[A] }\n\n" if i == 0 else "package shapes\n\n")
            + "\n".join(f"object M{i}_{k} {{\n" + textwrap.indent(d_, "  ") + "}\n" for k, d_ in enumerate(defs)))
    for i in range(6):
        open(os.path.join(tst, f"Suite{i}.scala"), "w").write(textwrap.dedent(f"""\
            package shapes
            class Suite{i} extends munit.FunSuite {{
              test("evaluation agrees with a fold") {{
                for (n <- 1 to 22) {{
                  val e = M{i}_0.Expr0.gen(n)
                  assertEquals(M{i}_0.Expr0.eval(e), M{i}_0.Expr0.eval(e))
                }}
              }}
              test("sorting is stable") {{
                val xs = Vector.tabulate(30000)(k => (k * 7919L % 100003).toInt)
                for (_ <- 1 to 2) assertEquals(xs.sorted.distinct.size, xs.distinct.size)
              }}
            }}
        """))


SERVICE = """\
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;

/** A service-shaped workload: workers parse and hash requests, share a contended cache, and wait on a queue. */
public class InventoryService {
  static final Map<String, byte[]> cache = new HashMap<>();
  static final BlockingQueue<String> queue = new LinkedBlockingQueue<>();

  public static void main(String[] args) throws Exception {
    ExecutorService workers = Executors.newFixedThreadPool(6, r -> { Thread t = new Thread(r); t.setName("worker-" + t.threadId()); return t; });
    for (int i = 0; i < 6; i++) workers.submit(InventoryService::work);
    Thread producer = new Thread(() -> {
      Random r = new Random(1);
      while (true) {
        for (int i = 0; i < 60; i++) queue.add("{\\"sku\\": \\"" + r.nextInt(5000) + "\\", \\"qty\\": " + r.nextInt(99) + ", \\"tags\\": [\\"a\\", \\"b\\", \\"c\\"]}");
        try { Thread.sleep(r.nextInt(4) == 0 ? 2500 : 400); } catch (InterruptedException e) { return; }
      }
    }, "request-reader");
    producer.start();
    producer.join();
  }

  static Object work() throws Exception {
    MessageDigest md = MessageDigest.getInstance("SHA-256");
    while (true) {
      String req = queue.take();
      Map<String, String> fields = parse(req);
      byte[] h = req.getBytes();
      for (int i = 0; i < 300; i++) h = md.digest(h);
      synchronized (cache) {  // the hot lock: long enough that workers queue up behind it
        cache.put(fields.get("sku"), h);
        if (cache.size() > 2000) cache.clear();
        long x = 0;
        for (int i = 0; i < 4_000_000; i++) x += (x ^ i) * 31 + h[i & 31];
        h[0] ^= (byte) x;
      }
    }
  }

  static Map<String, String> parse(String s) {
    Map<String, String> m = new TreeMap<>();
    for (String part : s.replaceAll("[{}\\\\[\\\\]]", "").split(",")) {
      String[] kv = part.split(":", 2);
      if (kv.length == 2) m.put(kv[0].trim().replace("\\"", ""), kv[1].trim().replace("\\"", ""));
    }
    return m;
  }
}
"""


def descendants(pid):
    out = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,command="], capture_output=True, text=True).stdout
    kids, cmd = {}, {}
    for line in out.splitlines():
        p, pp, c = line.strip().split(None, 2)
        kids.setdefault(int(pp), []).append(int(p))
        cmd[int(p)] = c
    todo, found = [pid], []
    while todo:
        p = todo.pop()
        found.append(p)
        todo += kids.get(p, [])
    return [(p, cmd.get(p, "")) for p in found]


def java_pid(proc, timeout=60):
    """The java process at or under a launched process (sbt's runner is a script)."""
    end = time.time() + timeout
    while time.time() < end:
        for p, c in descendants(proc.pid):
            if c.split()[0].endswith("java"):
                return p
        time.sleep(0.2)
    raise RuntimeError(f"no java under pid {proc.pid}")


# ---------------------------------------------------------------------------------------------- fixture

def compact(dumps, t0, t1, keep_alloc=0.5):
    """Raw dumps -> the fixture. Frames once; stacks as one prefix tree shared by every JVM (parent and frame per
    node); per JVM its stacks (leaf node, activity, the "doing what" frame's depth), threads, and samples, CPU loads and
    GC pauses as columns, times in ms after t0. Allocation samples (JFR takes 50 a second whatever the rate) are kept
    at random with probability keep_alloc and weighted up, so totals still hold."""
    frames, fid, parent, frame, node_of, acts, aid = [], {}, [], [], {}, [], {}
    rnd = random.Random(1)
    out = []
    for name, d in dumps:
        fmap = []
        for f in d["frames"]:
            if f not in fid:
                fid[f] = len(frames)
                frames.append(f)
            fmap.append(fid[f])
        leaf, act, top = [], [], []
        for fs, a, tp in d["stacks"]:
            n = 0
            for f in fs:
                k = (n, fmap[f])
                if k not in node_of:
                    parent.append(n)
                    frame.append(fmap[f])
                    node_of[k] = len(parent)  # node ids start at 1; 0 is the root
                n = node_of[k]
            if a not in aid:
                aid[a] = len(acts)
                acts.append(a)
            leaf.append(n)
            act.append(aid[a])
            top.append(tp)
        alloc = d["kinds"].index("alloc")
        cols = [[], [], [], [], []]  # t, thread, stack, kind, weight
        for t, th, st, k, w in sorted(d["samples"]):
            if not t0 <= t < t1:
                continue
            if k == alloc:
                if rnd.random() >= keep_alloc:
                    continue
                w = round(w / keep_alloc)
            for c, v in zip(cols, (t - t0, th, st, k, w)):
                c.append(v)
        cpu = [[], [], []]
        for t, th, load in sorted(d["cpu"]):
            if t0 <= t < t1 and load > 0:
                for c, v in zip(cpu, (t - t0, th, load)):
                    c.append(v)
        gc = [[t - t0, us, n] for t, us, n in d["gc"] if t0 <= t < t1]
        out.append(dict(name=name, stacks=dict(leaf=leaf, act=act, top=top), threads=d["threads"],
                        samples=dict(zip(("t", "th", "st", "k", "w"), cols)), cpu=dict(zip(("t", "th", "load"), cpu)), gc=gc))
    return dict(span=t1 - t0, kinds=dumps[0][1]["kinds"], frames=frames, tree=dict(parent=parent, frame=frame), activities=acts, jvms=out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--minutes", type=float, default=8)
    ap.add_argument("--out", default=os.path.join(ROOT, "demo", "fixture", "profiles.json.gz"))
    ap.add_argument("--work", default=os.path.join(ROOT, "dist", "fixture-work"))
    ap.add_argument("--from-dumps", action="store_true", help="re-make the fixture from the last recording's raw dumps")
    a = ap.parse_args()
    raw = os.path.join(a.work, "dumps.json.gz")
    if a.from_dumps:
        rec = json.load(gzip.open(raw))
    else:
        rec = record(a)
        with gzip.open(raw, "wt") as f:
            json.dump(rec, f)
    write(compact(rec["dumps"], rec["start"], rec["end"]), a.out)


def record(a):

    helper = H.Helper()
    helper.keepalive = lambda: True  # it holds the recordings: no idle exit while we wait
    why = helper.unavailable()
    if why:
        sys.exit(why)
    tests = os.path.join(ROOT, "profiler", "target", "test-classes")
    if not os.path.exists(os.path.join(tests, "agentscope", "profiler", "CompileWorkload.class")):
        subprocess.run(["./mvnw", "-q", "-B", "test-compile"], cwd=os.path.join(ROOT, "profiler"), check=True)
    shutil.rmtree(a.work, ignore_errors=True)
    proj = os.path.join(a.work, "shapes")
    scala_project(proj)
    svc = os.path.join(a.work, "service")
    os.makedirs(svc)
    open(os.path.join(svc, "InventoryService.java"), "w").write(SERVICE)

    log = open(os.path.join(a.work, "workloads.log"), "w")
    rounds = "; ".join(["clean; compile; test"] * 200)
    procs = {
        "sbt": subprocess.Popen(["sbt", "-batch", "-Dsbt.server.forcestart=false", rounds], cwd=proj, stdout=log, stderr=log, start_new_session=True),
        "javac": subprocess.Popen(["java", "-cp", tests, "agentscope.profiler.CompileWorkload"], stdout=subprocess.DEVNULL, stderr=log, start_new_session=True),
        "service": subprocess.Popen(["java", "InventoryService.java"], cwd=svc, stdout=log, stderr=log, start_new_session=True),
    }
    pids = {}
    try:
        for name, p in procs.items():
            pids[name] = java_pid(p)
        time.sleep(3)  # long enough for JFR to attach to, short enough that sbt's dependency resolution is still in it
        start = int(time.time() * 1000)
        for name, pid in pids.items():
            r = helper.call("record_start", timeout=60, pid=pid, stack_depth=512)["recording"]
            print(f"recording {name} (pid {pid}, depth {r.get('stack_depth')})", file=sys.stderr)
        end = start + int(a.minutes * 60_000)
        while time.time() * 1000 < end:
            left = (end - time.time() * 1000) / 1000
            print(f"\r{left:5.0f} s left ", end="", file=sys.stderr)
            time.sleep(min(10, max(0.1, left)))
        print(file=sys.stderr)
        dumps = [(name, helper.call("dump", timeout=120, pid=pid, since=start)["dump"]) for name, pid in pids.items()]
        for pid in pids.values():
            helper.call("record_stop", timeout=30, pid=pid)
    finally:
        for p in procs.values():
            try:
                os.killpg(p.pid, signal.SIGTERM)
            except OSError:
                pass
    return dict(start=start, end=end, dumps=dumps)


def write(fx, out):
    os.makedirs(os.path.dirname(out), exist_ok=True)
    data = json.dumps(fx, separators=(",", ":")).encode()
    with gzip.open(out, "wb", compresslevel=9) as f:
        f.write(data)
    for j in fx["jvms"]:
        print(f"{j['name']}: {len(j['samples']['t'])} samples, {len(j['stacks']['leaf'])} stacks, {len(j['threads'])} threads, {len(j['gc'])} GCs", file=sys.stderr)
    print(f"wrote {out}: {len(fx['frames'])} frames, {len(fx['tree']['parent'])} nodes, {os.path.getsize(out) / 1e6:.2f} MB ({len(data) / 1e6:.1f} MB as JSON)", file=sys.stderr)


if __name__ == "__main__":
    main()
