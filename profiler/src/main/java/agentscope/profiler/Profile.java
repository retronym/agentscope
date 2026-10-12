package agentscope.profiler;

import jdk.jfr.consumer.RecordedClass;
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

  /** A thread using less than this (cores) is waiting, whatever its stack says. */
  static final double MIN_BUSY_CORES = 0.05;

  /** Sample kinds, also the {@code kind} names queries take. The last four come from async-profiler captures. */
  public static final int CPU = 0, NATIVE = 1, ALLOC = 2, LOCK = 3, PARK = 4, WALL = 5, LIVE = 6, NATIVEMEM = 7, NATIVELOCK = 8;
  static final List<String> KINDS = List.of("cpu", "native", "alloc", "lock", "park", "wall", "live", "nativemem", "nativelock");
  private final long[] kindTotals = new long[KINDS.size()], kindSamples = new long[KINDS.size()];

  // interning
  private final Map<String, Integer> frameIds = new HashMap<>();
  private final List<String> frames = new ArrayList<>();
  private final Map<StackKey, Integer> stackIds = new HashMap<>();
  private final List<int[]> stacks = new ArrayList<>();  // frame ids, root first
  // Each frame's type (FRAME_TYPES' index: interpreted, compiled, inlined...), parallel to its stack's ids, or -1 when
  // unknown. Part of a stack's identity: the same method is interpreted in one sample and inlined in the next, while
  // frame names (what everything else compares) don't say.
  private final List<byte[]> stackTypes = new ArrayList<>();
  // For allocation samples, the class allocated: a frame id ("byte[] [allocated]"), or -1. Part of a stack's identity,
  // so stacks that differ only in what they allocate are separate ids with the same frames; flame() can show it as the
  // top frame, and everything else (activities, minutes, diffs) ignores it.
  private final List<Integer> stackClass = new ArrayList<>();
  // In captures, the stack's category ("[gc]", "[jit]", "[c2_comp]"...) as a frame id, or -1; part of its identity too,
  // since it depends on frame types (interpreted or compiled) that frame names don't carry
  private final List<Integer> stackCategory = new ArrayList<>();
  private final java.util.Set<Integer> labelFrames = new java.util.HashSet<>();  // category frames: drawn as labels
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
  /** How Java frames are named: by method ("" ), or with their line ("line": name:42) or bytecode index ("bci": name@17). */
  private final String detail;
  /** An async-profiler capture: lock and park waits in µs rather than ms (--lock goes well under a millisecond), and
   *  each stack classified as async-profiler's jfrconv --classify would ({@link Classify}). */
  private final boolean capture;
  private long first = Long.MAX_VALUE, last, events;

  public Profile(int ncpu) {
    this(ncpu, "");
  }

  public Profile(int ncpu, String detail) {
    this(ncpu, detail, false);
  }

  public Profile(int ncpu, String detail, boolean capture) {
    this.ncpu = ncpu;
    this.detail = detail == null ? "" : detail;
    this.capture = capture;
  }

  private long waited(RecordedEvent e) {
    return capture ? e.getDuration().toNanos() / 1000 : e.getDuration().toMillis();
  }

  // ---------------------------------------------------------------- ingest

  public synchronized void accept(RecordedEvent e) {
    long t = e.getStartTime().toEpochMilli();
    first = Math.min(first, t);
    last = Math.max(last, t);
    switch (e.getEventType().getName()) {
      case "jdk.ExecutionSample" -> sample(t, e.getThread("sampledThread"), e.getStackTrace(), CPU, 1);
      case "jdk.NativeMethodSample" -> sample(t, e.getThread("sampledThread"), e.getStackTrace(), NATIVE, 1);
      case "jdk.ObjectAllocationSample" -> sample(t, e.getThread("eventThread"), e.getStackTrace(), ALLOC, e.getLong("weight"), allocated(e));
      case "jdk.JavaMonitorEnter" -> sample(t, e.getThread("eventThread"), e.getStackTrace(), LOCK, waited(e));
      case "jdk.ThreadPark" -> sample(t, e.getThread("eventThread"), e.getStackTrace(), PARK, waited(e));
      // async-profiler's events (in capture files); weights are what its own converter totals
      case "profiler.WallClockSample" -> sample(t, e.getThread("sampledThread"), e.getStackTrace(), WALL, e.hasField("samples") ? Math.max(1, e.getInt("samples")) : 1);
      case "jdk.ObjectAllocationInNewTLAB", "jdk.ObjectAllocationOutsideTLAB" -> sample(t, e.getThread("eventThread"), e.getStackTrace(), ALLOC,
          e.hasField("tlabSize") && e.getLong("tlabSize") > 0 ? e.getLong("tlabSize") : e.getLong("allocationSize"), allocated(e));
      case "profiler.LiveObject" -> sample(t, e.getThread("eventThread"), e.getStackTrace(), LIVE, e.getLong("allocationSize"), allocated(e));
      case "profiler.Malloc" -> sample(t, e.getThread("eventThread"), e.getStackTrace(), NATIVEMEM, e.getLong("size"));
      case "profiler.NativeLock" -> sample(t, e.getThread("eventThread"), e.getStackTrace(), NATIVELOCK, waited(e));
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
    sample(t, th, st, kind, weight, -1);
  }

  private void sample(long t, RecordedThread th, RecordedStackTrace st, int kind, long weight, int allocated) {
    if (th == null) return;
    addSample(t, thread(th), stack(st, allocated), kind, weight);
  }

  /** A sample with interned thread and stack ids: {@link CaptureFile}'s way in, as well as {@link #accept}'s. */
  void addSample(long t, int thread, int stack, int kind, long weight) {
    first = Math.min(first, t);
    last = Math.max(last, t);
    samples.add(t, thread, stack, kind, weight);
    kindTotals[kind] += weight;
    kindSamples[kind]++;
  }

  /** The allocated class of an allocation event, as a frame: "byte[] [allocated]", "java.lang.String [allocated]". */
  private int allocated(RecordedEvent e) {
    RecordedClass c = e.hasField("objectClass") ? e.getClass("objectClass") : null;
    return c == null || c.getName() == null ? -1 : frame(prettyClass(c.getName()) + " [allocated]");
  }

  /** [B -> byte[], [Ljava.lang.String; -> java.lang.String[], java/lang/String -> java.lang.String */
  static String prettyClass(String n) {
    int dims = 0;
    while (dims < n.length() && n.charAt(dims) == '[') dims++;
    String base = n.substring(dims);
    if (dims > 0) base = switch (base) {
      case "B" -> "byte"; case "C" -> "char"; case "D" -> "double"; case "F" -> "float"; case "I" -> "int"; case "J" -> "long";
      case "S" -> "short"; case "Z" -> "boolean";
      default -> base.startsWith("L") && base.endsWith(";") ? base.substring(1, base.length() - 1) : base;
    };
    return base.replace('/', '.') + "[]".repeat(dims);
  }

  private int thread(RecordedThread th) {
    if (th == null) return -1;
    return internThread(th.getJavaThreadId() > 0 ? th.getJavaThreadId() : -th.getOSThreadId(), th.getJavaName() != null ? th.getJavaName() : th.getOSName());
  }

  /** {@code id}: the Java thread id, or minus the OS thread id for a thread with none. */
  int internThread(long id, String name) {
    Integer i = threadIds.get(id);
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

  private int stack(RecordedStackTrace st, int allocated) {
    if (st == null) return -1;
    List<RecordedFrame> fs = st.getFrames();
    int[] ids = new int[fs.size() + (st.isTruncated() ? 1 : 0)];
    byte[] types = new byte[ids.length];
    int k = 0;
    if (st.isTruncated()) { types[k] = -1; ids[k++] = frame("…"); }
    for (int j = fs.size() - 1; j >= 0; j--) {  // JFR is leaf first; we keep root first
      types[k] = frameType(fs.get(j).getType());
      ids[k++] = frame(fs.get(j));
    }
    return internStack(ids, types, allocated, -1);
  }

  /**
   * Frame types, by the codes async-profiler uses in its recordings (so {@link CaptureFile}'s are used as they are):
   * HotSpot's own JFR says "JIT compiled" for C1 and C2 alike, async-profiler's means C2, with C1 apart.
   */
  static final List<String> FRAME_TYPES = List.of("Interpreted", "JIT compiled", "Inlined", "Native", "C++", "Kernel", "C1 compiled");

  /** A JFR frame type's code in {@link #FRAME_TYPES}, or -1. */
  static byte frameType(String type) {
    if ("C2 compiled".equals(type)) return 1;
    return (byte) FRAME_TYPES.indexOf(type);
  }

  /** {@code ids}: frame ids, root first, and {@code types}, theirs (both kept, not copied); {@code allocated}, {@code category}: frame ids, or -1. */
  int internStack(int[] ids, byte[] types, int allocated, int category) {
    StackKey key = new StackKey(ids, types, allocated, category);  // the frames themselves, not a copy: deep stacks are most of the memory
    Integer id = stackIds.get(key);
    if (id == null) {
      id = stacks.size();
      stackIds.put(key, id);
      stacks.add(ids);
      stackTypes.add(types);
      stackClass.add(allocated);
      stackCategory.add(category);
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
    return frame(frameName(m.getType() == null ? null : m.getType().getName(), m.getName(), f.getType(), f.getLineNumber(), f.getBytecodeIndex(), detail));
  }

  /** A frame's name from its parts, whoever read them (the JDK's parser here, async-profiler's in {@link CaptureFile}).
   *  {@code line}, {@code bci}: negative when unknown. */
  static String frameName(String owner, String method, String type, int line, int bci, String detail) {
    boolean java = type == null || JAVA_FRAME_TYPES.contains(type);
    boolean library = owner == null || owner.isEmpty() || !java && ("C++".equals(type) || "Kernel".equals(type) || LIBRARY.matcher(owner).find());
    // async-profiler's -F vtable puts the receiver of a megamorphic call above its vtable / itable stub as a Java frame
    // with the class and an empty method name ("Vector.()" to jfr print, plain "Vector" to jfrconv)
    if (java && !library && method.isEmpty()) return owner + " [receiver]";
    String name = library ? method : owner + "." + method;
    if (java && detail.equals("line") && line >= 0) name += ":" + line;
    else if (java && detail.equals("bci") && bci >= 0) name += "@" + bci;
    return java ? name : name + " [" + type + "]";
  }

  /** A category ({@link Classify}) as a frame, drawn as a label. */
  int category(String name) {
    int f = frame(name);
    labelFrames.add(f);
    return f;
  }

  String detail() {
    return detail;
  }

  int frame(String name) {
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
    return summary(this, this, since, Math.max(last, since) + 1, maxBins);
  }

  /**
   * As {@link #summary(long, int)}, for a capture: samples of each kind from {@code samples} when it has that kind in
   * [since, until), else from {@code context}, JFR's recording of the same JVM; per-thread CPU load and GC pauses from
   * {@code context}. Lanes are matched across the two by Java thread id. {@code context} may be null.
   */
  static Map<String, Object> summary(Profile samples, Profile context, long since, long until, int maxBins) {
    Profile ctx = context != null ? context : samples;
    synchronized (samples) {
      synchronized (ctx) {
        long span = Math.max(1000, until - since);
        long bin = Math.max(1000, (span / maxBins + 999) / 1000 * 1000);
        int nbins = (int) (span / bin) + 1;
        Map<Long, double[][]> lanes = new HashMap<>();
        Map<Long, String> names = new HashMap<>();
        int[][] heat = new int[nbins][20];
        for (int kind : new int[]{CPU, NATIVE, PARK, LOCK}) {
          Profile src = samples.has(kind, since, until) ? samples : ctx;
          double scale = (kind == PARK || kind == LOCK) && src.capture ? 1 / 1000.0 : 1;  // lanes say ms
          Ring r = src.samples;
          for (int i = r.lo; i < r.n; i++) {
            long t = r.t[i];
            if (r.c[i] != kind || t < since || t >= until || r.a[i] < 0) continue;
            int b = (int) ((t - since) / bin);
            if (b >= nbins) continue;
            long key = src.threadJavaIds.get(r.a[i]);
            names.putIfAbsent(key, src.threadNames.get(r.a[i]));
            double[] cell = lanes.computeIfAbsent(key, x -> new double[nbins][5])[b];
            switch (kind) {
              case CPU -> {
                cell[1]++;
                heat[b][(int) (t % 1000 / 50)]++;
              }
              case NATIVE -> cell[2]++;
              case PARK -> cell[3] += r.w[i] * scale;
              case LOCK -> cell[4] += r.w[i] * scale;
              default -> { }
            }
          }
        }
        Ring cpu = ctx.cpu;
        for (int i = cpu.lo; i < cpu.n; i++) {
          if (cpu.t[i] < since || cpu.t[i] >= until) continue;
          int b = (int) ((cpu.t[i] - since) / bin);
          if (b >= nbins) continue;
          long key = ctx.threadJavaIds.get(cpu.a[i]);
          names.putIfAbsent(key, ctx.threadNames.get(cpu.a[i]));
          lanes.computeIfAbsent(key, x -> new double[nbins][5])[b][0] += cpu.w[i] / 10_000.0 * 1000 / bin;
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
          m.put("tid", en.getKey());
          m.put("name", names.get(en.getKey()));
          m.put("busy", Math.round(total * 100) / 100.0);
          m.put("bins", sparse);
          threads.add(m);
        }
        threads.sort((x, y) -> Double.compare((double) y.get("busy"), (double) x.get("busy")));
        List<long[]> gc = new ArrayList<>();
        List<String> gcn = new ArrayList<>();
        for (int i = ctx.gcs.lo; i < ctx.gcs.n; i++) {
          if (ctx.gcs.t[i] < since || ctx.gcs.t[i] >= until) continue;
          gc.add(new long[]{ctx.gcs.t[i], ctx.gcs.w[i]});
          gcn.add(ctx.gcNames.get(i - ctx.gcs.lo));
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("since", since);
        out.put("bin", bin);
        out.put("bins", nbins);
        out.put("first", samples.first == Long.MAX_VALUE ? null : samples.first);
        out.put("last", samples.last == 0 ? null : samples.last);
        out.put("threads", threads);
        out.put("heat", heat);
        out.put("gc", gc);
        out.put("gc_names", gcn);
        return out;
      }
    }
  }

  /** Whether there are samples of a kind in [t0, t1). */
  synchronized boolean has(int kind, long t0, long t1) {
    for (int i = samples.lo; i < samples.n; i++) if (samples.c[i] == kind && samples.t[i] >= t0 && samples.t[i] < t1) return true;
    return false;
  }

  /** The kinds with samples in [t0, t1), and their weight. */
  synchronized Map<String, Long> kinds(long t0, long t1) {
    long[] w = new long[KINDS.size()];
    boolean[] any = new boolean[KINDS.size()];
    for (int i = samples.lo; i < samples.n; i++) {
      if (samples.t[i] < t0 || samples.t[i] >= t1) continue;
      w[samples.c[i]] += samples.w[i];
      any[samples.c[i]] = true;
    }
    Map<String, Long> out = new LinkedHashMap<>();
    for (int k = 0; k < w.length; k++) if (any[k]) out.put(KINDS.get(k), w[k]);
    return out;
  }

  /**
   * A flame graph for [t0, t1): nested [name, value, children] from the root, for one kind of sample, optionally only
   * some threads. Nodes under {@code minShare} of the total are folded away, which keeps the answer small.
   * {@code reverse}: from the leaves instead (where time is spent first, then who called it).
   */
  public synchronized Map<String, Object> flame(long t0, long t1, String kindName, List<Long> threadFilter, double minShare, boolean reverse) {
    return flame(t0, t1, kindName, threadFilter, minShare, reverse, List.of());
  }

  /** As {@link #flame}, with full detail (relative to it) below the zoom {@code path}. */
  public synchronized Map<String, Object> flame(long t0, long t1, String kindName, List<Long> threadFilter, double minShare, boolean reverse, List<String> path) {
    return flame(t0, t1, kindName, threadFilter, minShare, reverse, path, false);
  }

  public synchronized Map<String, Object> flame(long t0, long t1, String kindName, List<Long> threadFilter, double minShare, boolean reverse, List<String> path,
                                                boolean classes) {
    return flame(t0, t1, kindName, threadFilter, minShare, reverse, path, classes, false);
  }

  /** As {@link #flame}; {@code classes}: for allocation kinds, the class allocated as the top frame (the root when reversed);
   *  {@code categories}: in captures, the stack's category ({@link Classify}) as the first level, in either direction. */
  public synchronized Map<String, Object> flame(long t0, long t1, String kindName, List<Long> threadFilter, double minShare, boolean reverse, List<String> path,
                                                boolean classes, boolean categories) {
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
      byte[] ty = stackTypes.get(s);
      int cls = classes ? stackClass.get(s) : -1, cat = categories ? stackCategory.get(s) : -1;
      if (cat >= 0) (cur = cur.child(cat)).value += w;
      if (cls >= 0 && reverse) (cur = cur.child(cls)).value += w;
      for (int k = 0; k < st.length; k++) {
        int j = reverse ? st.length - 1 - k : k;
        cur = cur.child(st[j]);
        cur.value += w;
        cur.typed(ty[j], w);
      }
      if (cls >= 0 && !reverse) (cur = cur.child(cls)).value += w;
    }
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("kind", kindName);
    out.put("reverse", reverse);
    out.put("total", total);
    out.put("samples", n);
    if (capture) out.put("wait_us", true);
    // what each node's types (the fifth element) count, by code; async-profiler's "JIT compiled" is C2
    out.put("frame_types", capture ? FRAME_TYPES.stream().map(x -> x.equals("JIT compiled") ? "C2 compiled" : x).toList() : FRAME_TYPES);
    long min = Math.max(1, (long) (total * minShare)), at = path.isEmpty() ? -1 : root.valueAt(frames, path);
    out.put("root", root.toJson(frames, labelFrames, min, "all", path, 0, false, at > 0 ? Math.max(1, (long) (at * minShare)) : min));
    if (!path.isEmpty()) out.put("path", path);
    return out;
  }

  /** Java ids of the threads in a group ({@link Activities#threadGroup}); never empty, so it always filters. */
  public synchronized List<Long> threadsInGroup(String group) {
    List<Long> out = new ArrayList<>();
    for (int i = 0; i < threadNames.size(); i++) if (group.equals(Activities.threadGroup(threadNames.get(i)))) out.add(threadJavaIds.get(i));
    if (out.isEmpty()) out.add(Long.MIN_VALUE);
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

  /**
   * Everything recorded since {@code since}, raw: for building the static demo's fixture (demo/record_fixture.py).
   * Stacks are renumbered to the ones used, each with its frames (root first), activity and "doing what" frame.
   */
  public synchronized Map<String, Object> dump(long since) {
    Map<Integer, Integer> used = new LinkedHashMap<>();
    List<long[]> rows = new ArrayList<>();  // t, thread, stack, kind, weight
    for (int i = samples.lo; i < samples.n; i++) {
      if (samples.t[i] < since) continue;
      int s = samples.b[i] < 0 ? -1 : used.computeIfAbsent(samples.b[i], x -> used.size());
      rows.add(new long[]{samples.t[i], samples.a[i], s, samples.c[i], samples.w[i]});
    }
    List<Object> stackOut = new ArrayList<>();
    for (int s : used.keySet()) {
      List<Integer> fs = new ArrayList<>();
      for (int f : stacks.get(s)) fs.add(f);
      Activities.Activity a = explain(s);
      stackOut.add(List.of(fs, a.label(), a.frame()));
    }
    List<long[]> loads = new ArrayList<>();
    for (int i = cpu.lo; i < cpu.n; i++) if (cpu.t[i] >= since) loads.add(new long[]{cpu.t[i], cpu.a[i], cpu.w[i]});
    List<Object> gc = new ArrayList<>();
    for (int i = gcs.lo; i < gcs.n; i++) if (gcs.t[i] >= since) gc.add(List.of(gcs.t[i], gcs.w[i], gcNames.get(i - gcs.lo)));
    List<Object> threads = new ArrayList<>();
    for (int i = 0; i < threadNames.size(); i++) threads.add(java.util.Arrays.asList(threadJavaIds.get(i), threadNames.get(i)));
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("kinds", KINDS);
    out.put("frames", frames);
    out.put("stacks", stackOut);  // [[frame ids, root first], activity, index of the "doing what" frame]
    out.put("threads", threads);  // [java thread id, name]
    out.put("samples", rows);  // [t ms, thread, stack (-1: none), kind, weight]
    out.put("cpu", loads);  // [t ms, thread, load in 1/10000 of a core]
    out.put("gc", gc);  // [t ms, pause µs, collector]
    return out;
  }

  public synchronized Map<String, Object> stats() {
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("samples", samples.size());
    Map<String, Long> kinds = new LinkedHashMap<>();
    for (int k = 0; k < KINDS.size(); k++) if (kindSamples[k] > 0) kinds.put(KINDS.get(k), kindTotals[k]);  // a kind with samples, even if they weigh 0
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
    // A native sample only says a thread was in native code, busy or blocked (a file watcher's run loop, accept()).
    // It counts as activity only when the thread also used CPU in that bin (jdk.ThreadCPULoad).
    Map<Integer, double[]> cores = new HashMap<>();  // thread -> per bin: [sum of loads, n]
    Map<Integer, double[]> coresNow = new HashMap<>();
    for (int i = cpu.lo; i < cpu.n; i++) {
      if (cpu.t[i] < since) continue;
      int b = (int) ((cpu.t[i] - since) / bin);
      if (b >= nbins) continue;
      double load = cpu.w[i] / 10_000.0;
      double[] c = cores.computeIfAbsent(cpu.a[i], x -> new double[2 * nbins]);
      c[2 * b] += load;
      c[2 * b + 1]++;
      if (cpu.t[i] >= now - nowMs) coresNow.merge(cpu.a[i], new double[]{load}, (x, y) -> new double[]{Math.max(x[0], y[0])});
    }
    for (int i = samples.lo; i < samples.n; i++) {
      int kind = samples.c[i];
      if ((kind != CPU && kind != NATIVE) || samples.t[i] < since) continue;
      int th = samples.a[i];
      if (th < 0) continue;
      if (kind == NATIVE) {
        int b = (int) ((samples.t[i] - since) / bin);
        double[] c = cores.get(th);
        if (c == null || b >= nbins || c[2 * b + 1] == 0 || c[2 * b] / c[2 * b + 1] < MIN_BUSY_CORES) continue;
        if (samples.t[i] >= now - nowMs && coresNow.getOrDefault(th, new double[1])[0] < MIN_BUSY_CORES) continue;
      }
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
    if (after.capture) out.put("wait_us", true);
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
    long[] types;  // weight by frame type (FRAME_TYPES' codes), when known
    Map<Integer, Node> kids;

    Node(int frame) { this.frame = frame; }

    void typed(byte type, long w) {
      if (type < 0) return;
      if (types == null) types = new long[FRAME_TYPES.size()];
      types[type] += w;
    }

    Node child(int f) {
      if (kids == null) kids = new HashMap<>(4);
      return kids.computeIfAbsent(f, Node::new);
    }

    List<Object> toJson(List<String> frames, long min, String name) {
      return toJson(frames, java.util.Set.of(), min, name, List.of(), 0, false, min);
    }

    /**
     * Nodes under {@code min} are left out, except along and below {@code path} (the client's zoom), where the
     * threshold is {@code minPath}, relative to the zoomed subtree: detail appears as you zoom in, while the rest of
     * the tree stays as small as before.
     */
    List<Object> toJson(List<String> frames, java.util.Set<Integer> labels, long min, String name, List<String> path, int depth, boolean inside, long minPath) {
      List<Object> kidsOut = new ArrayList<>();
      if (kids != null) {
        List<Node> ks = new ArrayList<>(kids.values());
        ks.sort((a, b) -> Long.compare(b.value, a.value));
        for (Node k : ks) {
          String kn = frames.get(k.frame);
          boolean onPath = !inside && depth < path.size() && kn.equals(path.get(depth));
          boolean in = inside || onPath && depth + 1 == path.size();
          if (k.value >= (inside || onPath ? minPath : min)) kidsOut.add(k.toJson(frames, labels, min, kn, path, depth + 1, in, minPath));
        }
      }
      if (labels.contains(frame)) return List.of(name, value, kidsOut, 1);  // 1: a label, not a frame
      if (types == null) return List.of(name, value, kidsOut);
      int n = types.length;
      while (n > 0 && types[n - 1] == 0) n--;
      List<Long> ts = new ArrayList<>(n);
      for (int i = 0; i < n; i++) ts.add(types[i]);
      return List.of(name, value, kidsOut, 0, ts);  // [.., 0: a frame, weight by type]
    }

    /** The value of the node at a path of frame names below this one, or -1. */
    long valueAt(List<String> frames, List<String> path) {
      Node n = this;
      for (String p : path) {
        Node next = null;
        if (n.kids != null) for (Node k : n.kids.values()) if (frames.get(k.frame).equals(p)) { next = k; break; }
        if (next == null) return -1;
        n = next;
      }
      return n.value;
    }
  }

  private record StackKey(int[] a, byte[] types, int allocated, int category) {
    @Override public boolean equals(Object o) {
      return o instanceof StackKey x && allocated == x.allocated && category == x.category && Arrays.equals(a, x.a) && Arrays.equals(types, x.types);
    }
    @Override public int hashCode() { return ((Arrays.hashCode(a) * 31 + Arrays.hashCode(types)) * 31 + allocated) * 31 + category; }
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
