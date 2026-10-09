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

  /** Sample kinds, also the {@code kind} names queries take. */
  public static final int CPU = 0, NATIVE = 1, ALLOC = 2, LOCK = 3, PARK = 4;
  static final List<String> KINDS = List.of("cpu", "native", "alloc", "lock", "park");

  // interning
  private final Map<String, Integer> frameIds = new HashMap<>();
  private final List<String> frames = new ArrayList<>();
  private final Map<IntArray, Integer> stackIds = new HashMap<>();
  private final List<int[]> stacks = new ArrayList<>();  // frame ids, root first
  private final List<String> stackActivity = new ArrayList<>();  // by stack id, classified lazily
  private final Map<Long, Integer> threadIds = new HashMap<>();
  private final List<String> threadNames = new ArrayList<>();
  private final List<Long> threadJavaIds = new ArrayList<>();

  // samples: time (ms), thread, stack, kind, weight (1 for cpu/native, bytes for alloc, ms for lock/park)
  private final Ring samples = new Ring();
  // per-thread CPU (jdk.ThreadCPULoad), stored like samples: time, thread, -, -, load in 1/10000 of a core
  private final Ring cpu = new Ring();
  // GC pauses: time, -, -, -, duration ms; names kept alongside
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
      case "jdk.ThreadCPULoad" -> {
        // user and system are fractions of the whole machine; scale to cores
        double load = (e.getFloat("user") + e.getFloat("system")) * ncpu;
        cpu.add(t, thread(e.getThread("eventThread")), 0, 0, Math.round(load * 10_000));
      }
      case "jdk.GarbageCollection" -> {
        gcs.add(t, 0, 0, 0, e.getDuration("sumOfPauses").toMillis());
        gcNames.add(e.getString("name"));
      }
      default -> { }
    }
    if (++events % 4096 == 0) trim(last - WINDOW_MS);
  }

  private void sample(long t, RecordedThread th, RecordedStackTrace st, int kind, long weight) {
    if (th == null) return;
    samples.add(t, thread(th), stack(st), kind, weight);
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

  private static final java.util.Set<String> JAVA_FRAME_TYPES = java.util.Set.of("Interpreted", "JIT compiled", "Inlined");

  /**
   * A frame is an opaque string from here on. Java frames are "class.method"; anything else keeps whatever its producer
   * called it, tagged with its frame type (" [Native]", and from async-profiler " [C++]", " [Kernel]", stubs...), so
   * nothing downstream has to parse frame names to tell them apart.
   */
  private int frame(RecordedFrame f) {
    RecordedMethod m = f.getMethod();
    String type = m == null ? null : m.getType() == null ? null : m.getType().getName();
    String name = m == null ? "?" : type == null || type.isEmpty() ? m.getName() : type + "." + m.getName();
    String ft = f.getType();
    if (ft != null && !JAVA_FRAME_TYPES.contains(ft)) name += " [" + ft + "]";
    return frame(name);
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

  private String activity(int stack) {
    if (stack < 0) return "?";
    while (stackActivity.size() <= stack) stackActivity.add(null);
    String a = stackActivity.get(stack);
    if (a == null) {
      List<String> names = new ArrayList<>();
      for (int f : stacks.get(stack)) names.add(frames.get(f));
      stackActivity.set(stack, a = Activities.classify(names));
    }
    return a;
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
    m.put("stacks", stacks.size());
    m.put("frames", frames.size());
    m.put("threads", threadNames.size());
    m.put("first", first == Long.MAX_VALUE ? null : first);
    m.put("last", last == 0 ? null : last);
    return m;
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
