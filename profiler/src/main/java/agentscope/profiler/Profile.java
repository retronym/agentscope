package agentscope.profiler;

import jdk.jfr.consumer.RecordedEvent;
import jdk.jfr.consumer.RecordedFrame;
import jdk.jfr.consumer.RecordedMethod;
import jdk.jfr.consumer.RecordedStackTrace;
import jdk.jfr.consumer.RecordedThread;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * What one JVM's recording has said over the last {@link #WINDOW_MS}, kept compact enough to query interactively:
 * interned frames and stacks, and samples as parallel primitive arrays. Thread-safe by synchronizing every method:
 * one writer (the event stream), occasional readers (queries).
 */
public final class Profile {
  public static final long WINDOW_MS = 30 * 60_000;

  /** Sample kinds, also the {@code kind} names queries take. The last four come from async-profiler captures. */
  public static final int CPU = 0, NATIVE = 1, ALLOC = 2, LOCK = 3, PARK = 4, WALL = 5, LIVE = 6, NATIVEMEM = 7, NATIVELOCK = 8;
  static final List<String> KINDS = List.of("cpu", "native", "alloc", "lock", "park", "wall", "live", "nativemem", "nativelock");
  private final long[] kindTotals = new long[KINDS.size()];

  // interning
  private final Map<String, Integer> frameIds = new HashMap<>();
  private final List<String> frames = new ArrayList<>();
  private final Map<IntArray, Integer> stackIds = new HashMap<>();
  private final List<int[]> stacks = new ArrayList<>();  // frame ids, root first
  private final List<Activities.Activity> stackActivity = new ArrayList<>();  // by stack id, classified lazily
  private final Map<Long, Integer> threadIds = new HashMap<>();
  private final List<String> threadNames = new ArrayList<>();
  private final List<Long> threadJavaIds = new ArrayList<>();

  // samples: time (ms), thread, stack, kind, weight (1 for cpu/native, bytes for alloc, ms for lock/park)
  private final Ring samples = new Ring();
  // per-thread CPU (jdk.ThreadCPULoad), stored like samples: time, thread, -, -, load in 1/10000 of a core
  private final Ring cpu = new Ring();
  // GC pauses: time, -, -, -, duration µs; names kept alongside
  private final Ring gcs = new Ring();
  private final List<String> gcNames = new ArrayList<>();

  private final int ncpu;
  private long first = Long.MAX_VALUE, last, events;

  public Profile(int ncpu) {
    this.ncpu = ncpu;
  }

  // ---------------------------------------------------------------- ingest

  public synchronized void accept(RecordedEvent e) {
    long t = e.getStartTime().toEpochMilli();
    first = Math.min(first, t);
    last = Math.max(last, t);
    switch (e.getEventType().getName()) {
      case "jdk.ExecutionSample" -> sample(t, e.getThread("sampledThread"), e.getStackTrace(), CPU, 1);
      case "jdk.NativeMethodSample" -> sample(t, e.getThread("sampledThread"), e.getStackTrace(), NATIVE, 1);
      case "jdk.ObjectAllocationSample" -> sample(t, e.getThread("eventThread"), e.getStackTrace(), ALLOC, e.getLong("weight"));
      case "jdk.JavaMonitorEnter" -> sample(t, e.getThread("eventThread"), e.getStackTrace(), LOCK, e.getDuration().toMillis());
      case "jdk.ThreadPark" -> sample(t, e.getThread("eventThread"), e.getStackTrace(), PARK, e.getDuration().toMillis());
      // async-profiler's events (in capture files); weights are what its own converter totals
      case "profiler.WallClockSample" -> sample(t, e.getThread("sampledThread"), e.getStackTrace(), WALL, e.hasField("samples") ? Math.max(1, e.getInt("samples")) : 1);
      case "jdk.ObjectAllocationInNewTLAB", "jdk.ObjectAllocationOutsideTLAB" -> sample(t, e.getThread("eventThread"), e.getStackTrace(), ALLOC,
          e.hasField("tlabSize") && e.getLong("tlabSize") > 0 ? e.getLong("tlabSize") : e.getLong("allocationSize"));
      case "profiler.LiveObject" -> sample(t, e.getThread("eventThread"), e.getStackTrace(), LIVE, e.getLong("allocationSize"));
      case "profiler.Malloc" -> sample(t, e.getThread("eventThread"), e.getStackTrace(), NATIVEMEM, e.getLong("size"));
      case "profiler.NativeLock" -> sample(t, e.getThread("eventThread"), e.getStackTrace(), NATIVELOCK, e.getDuration().toMillis());
      case "jdk.ThreadCPULoad" -> {
        // user and system are fractions of the whole machine; scale to cores
        double load = (e.getFloat("user") + e.getFloat("system")) * ncpu;
        cpu.add(t, thread(e.getThread("eventThread")), 0, 0, Math.round(load * 10_000));
      }
      case "jdk.GarbageCollection" -> {
        gcs.add(t, 0, 0, 0, e.getDuration("sumOfPauses").toNanos() / 1000);  // µs: most pauses are well under a millisecond
        gcNames.add(e.getString("name"));
      }
      default -> { }
    }
    if (++events % 4096 == 0) trim(last - WINDOW_MS);
  }

  private void sample(long t, RecordedThread th, RecordedStackTrace st, int kind, long weight) {
    if (th == null) return;
    samples.add(t, thread(th), stack(st), kind, weight);
    kindTotals[kind] += weight;
  }

  private int thread(RecordedThread th) {
    if (th == null) return -1;
    long id = th.getJavaThreadId() > 0 ? th.getJavaThreadId() : -th.getOSThreadId();
    Integer i = threadIds.get(id);
    String name = th.getJavaName() != null ? th.getJavaName() : th.getOSName();
    if (i == null) {
      i = threadNames.size();
      threadIds.put(id, i);
      threadNames.add(name);
      threadJavaIds.add(id);
    } else if (name != null && !name.equals(threadNames.get(i))) {
      threadNames.set(i, name);  // threads get renamed (pool workers, sbt tasks): keep the latest
    }
    return i;
  }

  private int stack(RecordedStackTrace st) {
    if (st == null) return -1;
    List<RecordedFrame> fs = st.getFrames();
    int[] ids = new int[fs.size() + (st.isTruncated() ? 1 : 0)];
    int k = 0;
    if (st.isTruncated()) ids[k++] = frame("…");
    for (int j = fs.size() - 1; j >= 0; j--) ids[k++] = frame(fs.get(j));  // JFR is leaf first; we keep root first
    IntArray key = new IntArray(ids);
    Integer id = stackIds.get(key);
    if (id == null) {
      id = stacks.size();
      stackIds.put(key, id);
      stacks.add(ids);
    }
    return id;
  }

  // JFR's and async-profiler's names for frames of Java code; anything else (Native, C++, Kernel, whatever comes next) isn't
  private static final java.util.Set<String> JAVA_FRAME_TYPES = java.util.Set.of("Interpreted", "JIT compiled", "Inlined", "C1 compiled", "C2 compiled");
  private static final java.util.regex.Pattern LIBRARY = java.util.regex.Pattern.compile("(^|/)lib[^/]*\\.(dylib|so)(\\.[\\d.]+)?$|\\.dll$|^\\[");

  /**
   * A frame is an opaque string from here on, decided by its frame type, never by parsing its name. Java frames are
   * "class.method". Others are tagged with their type (" [Native]", " [C++]", " [Kernel]"...); their "class" is dropped
   * when it's really a library (async-profiler puts libjvm.dylib there), kept when it's a Java class (a JNI method).
   */
  private int frame(RecordedFrame f) {
    RecordedMethod m = f.getMethod();
    if (m == null) return frame("?");
    String owner = m.getType() == null ? null : m.getType().getName();
    String ft = f.getType();
    boolean java = ft == null || JAVA_FRAME_TYPES.contains(ft);
    boolean library = owner == null || owner.isEmpty() || !java && ("C++".equals(ft) || "Kernel".equals(ft) || LIBRARY.matcher(owner).find());
    String name = library ? m.getName() : owner + "." + m.getName();
    return frame(java ? name : name + " [" + ft + "]");
  }

  private int frame(String name) {
    return frameIds.computeIfAbsent(name, n -> {
      frames.add(n);
      return frames.size() - 1;
    });
  }

  private void trim(long before) {
    samples.trim(before);
    cpu.trim(before);
    int dropped = gcs.trim(before);
    if (dropped > 0) gcNames.subList(0, dropped).clear();
  }

  // ---------------------------------------------------------------- queries

  /**
   * Thread lanes, a heatmap and GC pauses for [since, now], in at most {@code maxBins} time bins.
   * Lanes are per thread: [cpu cores, cpu samples, native samples, park ms, lock ms] per bin, sparse.
   * The heatmap is per bin: CPU samples in each of 20 sub-second slots (as async-profiler's heatmap).
   */
  public synchronized Map<String, Object> summary(long since, int maxBins) {
    long now = Math.max(last, since);
    long span = Math.max(1000, now - since);
    long bin = Math.max(1000, (span / maxBins + 999) / 1000 * 1000);
    int nbins = (int) (span / bin) + 1;
    Map<Integer, double[][]> lanes = new HashMap<>();
    int[][] heat = new int[nbins][20];
    for (int i = samples.lo; i < samples.n; i++) {
      long t = samples.t[i];
      if (t < since) continue;
      int b = (int) ((t - since) / bin), th = samples.a[i], kind = samples.c[i];
      if (b >= nbins) continue;
      double[] cell = lanes.computeIfAbsent(th, x -> new double[nbins][5])[b];
      switch (kind) {
        case CPU -> {
          cell[1]++;
          heat[b][(int) (t % 1000 / 50)]++;
        }
        case NATIVE -> cell[2]++;
        case PARK -> cell[3] += samples.w[i];
        case LOCK -> cell[4] += samples.w[i];
        default -> { }
      }
    }
    for (int i = cpu.lo; i < cpu.n; i++) {
      if (cpu.t[i] < since) continue;
      int b = (int) ((cpu.t[i] - since) / bin);
      if (b < nbins) lanes.computeIfAbsent(cpu.a[i], x -> new double[nbins][5])[b][0] += cpu.w[i] / 10_000.0 * 1000 / bin;
    }
    List<Map<String, Object>> threads = new ArrayList<>();
    for (var en : lanes.entrySet()) {
      double total = 0;
      Map<Integer, double[]> sparse = new LinkedHashMap<>();
      double[][] cells = en.getValue();
      for (int b = 0; b < nbins; b++) {
        double[] c = cells[b];
        if (c[0] > 0.005 || c[1] > 0 || c[2] > 0 || c[3] > 0 || c[4] > 0) {
          c[0] = Math.round(c[0] * 1000) / 1000.0;
          sparse.put(b, c);
        }
        total += c[0] + c[1] * 0.02;  // cores, or 20 ms per CPU sample when there's no CPU load event yet
      }
      if (sparse.isEmpty()) continue;
      Map<String, Object> m = new LinkedHashMap<>();
      m.put("tid", threadJavaIds.get(en.getKey()));
      m.put("name", threadNames.get(en.getKey()));
      m.put("busy", Math.round(total * 100) / 100.0);
      m.put("bins", sparse);
      threads.add(m);
    }
    threads.sort((x, y) -> Double.compare((double) y.get("busy"), (double) x.get("busy")));
    List<long[]> gc = new ArrayList<>();
    for (int i = gcs.lo; i < gcs.n; i++) if (gcs.t[i] >= since) gc.add(new long[]{gcs.t[i], gcs.w[i]});
    List<String> gcn = new ArrayList<>();
    for (int i = gcs.lo; i < gcs.n; i++) if (gcs.t[i] >= since) gcn.add(gcNames.get(i - gcs.lo));
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("since", since);
    out.put("bin", bin);
    out.put("bins", nbins);
    out.put("first", first == Long.MAX_VALUE ? null : first);
    out.put("last", last == 0 ? null : last);
    out.put("threads", threads);
    out.put("heat", heat);
    out.put("gc", gc);
    out.put("gc_names", gcn);
    return out;
  }

  /**
   * A flame graph for [t0, t1): nested [name, value, children] from the root, for one kind of sample, optionally only
   * some threads. Nodes under {@code minShare} of the total are folded away, which keeps the answer small.
   * {@code reverse}: from the leaves instead (where time is spent first, then who called it).
   */
  public synchronized Map<String, Object> flame(long t0, long t1, String kindName, List<Long> threadFilter, double minShare, boolean reverse) {
    int kind = KINDS.indexOf(kindName);
    if (kind < 0) throw new IllegalArgumentException("kind: one of " + KINDS);
    boolean[] want = null;
    if (threadFilter != null && !threadFilter.isEmpty()) {
      want = new boolean[threadNames.size()];
      for (Long id : threadFilter) {
        Integer i = threadIds.get(id);
        if (i != null) want[i] = true;
      }
    }
    Node root = new Node(-1);
    long total = 0, n = 0;
    for (int i = samples.lo; i < samples.n; i++) {
      if (samples.c[i] != kind || samples.t[i] < t0 || samples.t[i] >= t1) continue;
      int th = samples.a[i];
      if (want != null && (th < 0 || th >= want.length || !want[th])) continue;
      long w = samples.w[i];
      total += w;
      n++;
      root.value += w;
      int s = samples.b[i];
      if (s < 0) continue;
      Node cur = root;
      int[] st = stacks.get(s);
      for (int k = 0; k < st.length; k++) {
        cur = cur.child(st[reverse ? st.length - 1 - k : k]);
        cur.value += w;
      }
    }
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("kind", kindName);
    out.put("reverse", reverse);
    out.put("total", total);
    out.put("samples", n);
    out.put("root", root.toJson(frames, Math.max(1, (long) (total * minShare)), "all"));
    return out;
  }

  private Activities.Activity explain(int stack) {
    while (stackActivity.size() <= stack) stackActivity.add(null);
    Activities.Activity a = stackActivity.get(stack);
    if (a == null) {
      List<String> names = new ArrayList<>();
      for (int f : stacks.get(stack)) names.add(frames.get(f));
      stackActivity.set(stack, a = Activities.explain(names));
    }
    return a;
  }

  private String activity(int stack) {
    return stack < 0 ? "?" : explain(stack).label();
  }

  /** What the JVM's threads have been doing since {@code since}: CPU samples and distinct threads per activity, busiest first. */
  public synchronized List<Map<String, Object>> activities(long since) {
    Map<String, long[]> n = new HashMap<>();
    Map<String, java.util.Set<Integer>> threads = new HashMap<>();
    for (int i = samples.lo; i < samples.n; i++) {
      if (samples.t[i] < since || samples.c[i] != CPU) continue;
      String a = activity(samples.b[i]);
      n.computeIfAbsent(a, x -> new long[1])[0]++;
      threads.computeIfAbsent(a, x -> new java.util.HashSet<>()).add(samples.a[i]);
    }
    List<Map<String, Object>> out = new ArrayList<>();
    n.forEach((a, c) -> {
      Map<String, Object> m = new LinkedHashMap<>();
      m.put("activity", a);
      m.put("samples", c[0]);
      m.put("threads", threads.get(a).size());
      out.add(m);
    });
    out.sort((x, y) -> Long.compare((long) y.get("samples"), (long) x.get("samples")));
    return out;
  }

  /**
   * [t0, t1) for storage, exactly: weight per (kind, thread group, stack id). Stack ids are this profile's, stable for
   * its lifetime; {@link #stacks} defines the ones the caller hasn't seen yet.
   */
  public synchronized Map<String, Object> minute(long t0, long t1) {
    Map<String, Integer> groups = new LinkedHashMap<>();
    Map<List<Integer>, long[]> acc = new LinkedHashMap<>();
    for (int i = samples.lo; i < samples.n; i++) {
      long t = samples.t[i];
      if (t < t0 || t >= t1) continue;
      int th = samples.a[i];
      int g = groups.computeIfAbsent(Activities.threadGroup(th < 0 ? null : threadNames.get(th)), x -> groups.size());
      acc.computeIfAbsent(List.of((int) samples.c[i], g, samples.b[i]), x -> new long[1])[0] += samples.w[i];
    }
    List<Object> rows = new ArrayList<>();
    acc.forEach((k, w) -> rows.add(List.of(KINDS.get(k.get(0)), k.get(1), k.get(2), w[0])));
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("groups", new ArrayList<>(groups.keySet()));
    out.put("rows", rows);  // [kind, group index, stack id (-1: no stack), weight]
    return out;
  }

  /** Definitions of stack ids from {@link #minute}: frames (root first, as indexes into a frame list) and activity. */
  public synchronized Map<String, Object> stacks(List<Integer> ids) {
    Map<Integer, Integer> frameIndex = new LinkedHashMap<>();
    List<Object> defs = new ArrayList<>();
    for (int id : ids) {
      if (id < 0 || id >= stacks.size()) continue;
      List<Integer> path = new ArrayList<>();
      for (int f : stacks.get(id)) path.add(frameIndex.computeIfAbsent(f, x -> frameIndex.size()));
      defs.add(List.of(id, path, activity(id)));
    }
    List<String> names = new ArrayList<>();
    for (int f : frameIndex.keySet()) names.add(frames.get(f));
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("frames", names);
    out.put("stacks", defs);  // [stack id, [frame indexes, root first], activity]
    return out;
  }

  public synchronized Map<String, Object> stats() {
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("samples", samples.size());
    Map<String, Long> kinds = new LinkedHashMap<>();
    for (int k = 0; k < KINDS.size(); k++) if (kindTotals[k] > 0) kinds.put(KINDS.get(k), kindTotals[k]);
    m.put("kinds", kinds);
    m.put("stacks", stacks.size());
    m.put("frames", frames.size());
    m.put("threads", threadNames.size());
    m.put("first", first == Long.MAX_VALUE ? null : first);
    m.put("last", last == 0 ? null : last);
    return m;
  }

  /**
   * What each thread has been doing, for the Gradle-style live view: per thread, the dominant activity of its CPU and
   * native samples in each time bin over [since, now], and what it's doing right now (its latest sample within
   * {@code nowMs}: activity and top Java frame). Busiest threads first, at most {@code maxThreads}.
   */
  public synchronized Map<String, Object> threadActivity(long since, int maxBins, long nowMs, int maxThreads) {
    long now = Math.max(last, since);
    long span = Math.max(1000, now - since);
    long bin = Math.max(1000, (span / maxBins + 999) / 1000 * 1000);
    int nbins = (int) (span / bin) + 1;
    Map<String, Integer> actIndex = new LinkedHashMap<>();
    Map<Integer, Map<Long, int[]>> cells = new HashMap<>();  // thread -> (bin << 16 | activity) -> count
    Map<Integer, long[]> totals = new HashMap<>();  // thread -> [samples, samples in the "now" window]
    Map<Integer, Integer> latest = new HashMap<>();  // thread -> index of its latest sample
    for (int i = samples.lo; i < samples.n; i++) {
      int kind = samples.c[i];
      if ((kind != CPU && kind != NATIVE) || samples.t[i] < since) continue;
      int th = samples.a[i];
      if (th < 0) continue;
      int act = actIndex.computeIfAbsent(activity(samples.b[i]), x -> actIndex.size());
      long b = (samples.t[i] - since) / bin;
      cells.computeIfAbsent(th, x -> new HashMap<>()).computeIfAbsent(b << 16 | act, x -> new int[1])[0]++;
      long[] tot = totals.computeIfAbsent(th, x -> new long[2]);
      tot[0]++;
      if (samples.t[i] >= now - nowMs) {
        tot[1]++;
        latest.put(th, i);
      }
    }
    List<Integer> order = new ArrayList<>(totals.keySet());
    order.sort((x, y) -> Long.compare(totals.get(y)[1] * 1_000_000 + totals.get(y)[0], totals.get(x)[1] * 1_000_000 + totals.get(x)[0]));
    List<Object> threads = new ArrayList<>();
    for (int th : order.subList(0, Math.min(maxThreads, order.size()))) {
      Map<Long, int[]> c = cells.get(th);
      Map<Long, int[]> best = new HashMap<>();  // bin -> [activity, count]
      c.forEach((k, n) -> {
        long b = k >>> 16;
        int a = (int) (k & 0xffff);
        int[] cur = best.get(b);
        if (cur == null || n[0] > cur[1]) best.put(b, new int[]{a, n[0]});
      });
      Map<String, Object> bins = new LinkedHashMap<>();  // bin -> [activity index, samples]
      best.entrySet().stream().sorted(Map.Entry.comparingByKey()).forEach(e -> bins.put(e.getKey().toString(), List.of(e.getValue()[0], e.getValue()[1])));
      Map<String, Object> t = new LinkedHashMap<>();
      t.put("tid", threadJavaIds.get(th));
      t.put("name", threadNames.get(th));
      t.put("group", Activities.threadGroup(threadNames.get(th)));
      t.put("samples", totals.get(th)[0]);
      t.put("now_samples", totals.get(th)[1]);
      Integer li = latest.get(th);
      if (li != null) {
        t.put("now", activity(samples.b[li]));
        t.put("frame", topFrame(samples.b[li]));
        t.put("native", samples.c[li] == NATIVE);
      }
      t.put("bins", bins);
      threads.add(t);
    }
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("since", since);
    out.put("bin", bin);
    out.put("bins", nbins);
    out.put("activities", new ArrayList<>(actIndex.keySet()));
    out.put("threads", threads);
    return out;
  }

  /** The frame to show for "doing what": the one that earned the stack its activity (see {@link Activities#explain}). */
  private String topFrame(int stack) {
    if (stack < 0) return null;
    int i = explain(stack).frame();
    int[] st = stacks.get(stack);
    return i >= 0 && i < st.length ? frames.get(st[i]) : null;
  }

  /** Weights by stack (frame names, root first; reversed if asked), for one kind: what a diff compares. */
  public synchronized Map<List<String>, Long> collapsed(String kindName, boolean reverse) {
    int kind = KINDS.indexOf(kindName);
    Map<Integer, Long> byStack = new HashMap<>();
    for (int i = samples.lo; i < samples.n; i++) if (samples.c[i] == kind) byStack.merge(samples.b[i], samples.w[i], Long::sum);
    Map<List<String>, Long> out = new HashMap<>();
    byStack.forEach((s, w) -> {
      List<String> path = new ArrayList<>();
      if (s >= 0) for (int f : stacks.get(s)) path.add(frames.get(f));
      if (reverse) java.util.Collections.reverse(path);
      out.merge(path, w, Long::sum);
    });
    return out;
  }

  /**
   * A differential flame graph: the shape and values of {@code after}, each node also carrying its value in
   * {@code before}, as [name, value, children, 0, before]. Nodes only in {@code before} appear with value 0.
   */
  public static Map<String, Object> diff(Profile before, Profile after, String kind, boolean reverse, double minShare) {
    Map<List<String>, Long> a = before.collapsed(kind, reverse), b = after.collapsed(kind, reverse);
    long ta = a.values().stream().mapToLong(x -> x).sum(), tb = b.values().stream().mapToLong(x -> x).sum();
    DiffNode root = new DiffNode();
    a.forEach((path, w) -> root.add(path, 0, w, true));
    b.forEach((path, w) -> root.add(path, 0, w, false));
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("kind", kind);
    out.put("reverse", reverse);
    out.put("diff", true);
    out.put("total", tb);
    out.put("before_total", ta);
    out.put("root", root.toJson("all", Math.max(1, (long) (Math.max(ta, tb) * minShare))));
    return out;
  }

  private static final class DiffNode {
    long before, after;
    Map<String, DiffNode> kids;

    void add(List<String> path, int i, long w, boolean isBefore) {
      if (isBefore) before += w; else after += w;
      if (i == path.size()) return;
      if (kids == null) kids = new HashMap<>();
      kids.computeIfAbsent(path.get(i), x -> new DiffNode()).add(path, i + 1, w, isBefore);
    }

    List<Object> toJson(String name, long min) {
      List<Object> ks = new ArrayList<>();
      if (kids != null) kids.entrySet().stream().filter(e -> Math.max(e.getValue().after, e.getValue().before) >= min)
          .sorted((x, y) -> Long.compare(y.getValue().after, x.getValue().after)).forEach(e -> ks.add(e.getValue().toJson(e.getKey(), min)));
      return List.of(name, after, ks, 0, before);
    }
  }

  // ---------------------------------------------------------------- plumbing

  private static final class Node {
    final int frame;
    long value;
    Map<Integer, Node> kids;

    Node(int frame) { this.frame = frame; }

    Node child(int f) {
      if (kids == null) kids = new HashMap<>(4);
      return kids.computeIfAbsent(f, Node::new);
    }

    List<Object> toJson(List<String> frames, long min, String name) {
      List<Object> kidsOut = new ArrayList<>();
      if (kids != null) {
        List<Node> ks = new ArrayList<>(kids.values());
        ks.sort((a, b) -> Long.compare(b.value, a.value));
        for (Node k : ks) if (k.value >= min) kidsOut.add(k.toJson(frames, min, frames.get(k.frame)));
      }
      return List.of(name, value, kidsOut);
    }
  }

  private record IntArray(int[] a) {
    @Override public boolean equals(Object o) { return o instanceof IntArray x && Arrays.equals(a, x.a); }
    @Override public int hashCode() { return Arrays.hashCode(a); }
  }

  /** Parallel arrays with a moving start: append at the end, drop from the front. */
  private static final class Ring {
    long[] t = new long[1024], w = new long[1024];
    int[] a = new int[1024], b = new int[1024];
    byte[] c = new byte[1024];
    int lo, n;

    int size() { return n - lo; }

    void add(long time, int x, int y, int kind, long weight) {
      if (n == t.length) grow();
      t[n] = time;
      a[n] = x;
      b[n] = y;
      c[n] = (byte) kind;
      w[n] = weight;
      n++;
    }

    /** Drops entries older than {@code before}; returns how many. */
    int trim(long before) {
      int start = lo;
      while (lo < n && t[lo] < before) lo++;
      return lo - start;
    }

    private void grow() {
      int live = n - lo;
      int cap = live * 2 < t.length ? t.length : t.length * 2;  // reclaim the dropped front before growing
      t = copy(t, cap);
      w = copy(w, cap);
      a = copy(a, cap);
      b = copy(b, cap);
      c = copy(c, cap);
      n = live;
      lo = 0;
    }

    private long[] copy(long[] x, int cap) { long[] y = new long[cap]; System.arraycopy(x, lo, y, 0, n - lo); return y; }
    private int[] copy(int[] x, int cap) { int[] y = new int[cap]; System.arraycopy(x, lo, y, 0, n - lo); return y; }
    private byte[] copy(byte[] x, int cap) { byte[] y = new byte[cap]; System.arraycopy(x, lo, y, 0, n - lo); return y; }
  }
}
