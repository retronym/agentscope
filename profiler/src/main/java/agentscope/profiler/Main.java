package agentscope.profiler;

import com.fasterxml.jackson.jr.ob.JSON;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The helper agentscope's server talks to: one JSON request per line on stdin, one JSON response per line on stdout,
 * matched by {@code id}. Requests run concurrently, so a slow attach doesn't hold up the rest. Exits when stdin closes.
 *
 * <pre>
 * {"id": 1, "op": "ping"}                                → {"id": 1, "version": "...", "java": "21..."}
 * {"id": 2, "op": "jcmd", "pid": 123, "cmd": "GC.heap_info"}    → {"id": 2, "out": "..."}
 * {"id": 3, "op": "threads", "pid": 123, "interval_ms": 1000}   → {"id": 3, "dump": {...}}
 * {"id": 4, "op": "record_start", "pid": 123}                     → {"id": 4, "recording": {...}}   (also record_stop, recordings)
 * {"id": 5, "op": "summary", "pid": 123, "since": ms, "bins": 300} → {"id": 5, "summary": {...}}   thread lanes, heatmap, GC
 * {"id": 6, "op": "flame", "pid": 123, "t0": ms, "t1": ms, "kind": "cpu", "threads": [ids], "group": "pool-*-thread-*"?, "reverse": false, "classes": false} → {"id": 6, "flame": {...}}
 * {"id": 7, "op": "activities", "pid": 123, "since": ms}    → {"id": 7, "activities": [{activity, samples, threads}]}
 * {"op": "thread_activity", "pid": 123, "since": ms, "bins": 150}  → {"threads": {...}}  per thread: activity per bin, and right now
 * {"id": 8, "op": "minute", "pid": 123, "t0": ms, "t1": ms}  → {"id": 8, "minute": {groups, rows}}   exact, for storage
 * {"id": 9, "op": "stacks", "pid": 123, "ids": [stack ids]}   → {"id": 9, "stacks": {frames, stacks}}  definitions
 * {"op": "dump", "pid": 123, "since": ms}  → {"dump": {frames, stacks, threads, samples, cpu, gc}}   raw, for the demo's fixture
 * {"op": "capture_stats", "path": "x.jfr"}  /  {"op": "capture_flame", "path": "x.jfr", "kind": "wall", "base": "y.jfr"?, "frames": "line"?, "classes": true?, "categories": true?}
 *     async-profiler captures; base: a diff; frames: Java frames with their line or bytecode index ("bci"); classes: the class allocated as the top frame; categories: jfrconv --classify's categories as the first level
 * {"op": "capture_summary", "path": "x.jfr", "t0": ms, "t1": ms, "bins": 300}  → {"summary": {...}}   as summary, for a capture
 *     capture_*: with "jfr": "x-jfr.jfr" (JFR's window, dumped beside the capture) or "pid": 123 (its live recording), JFR fills in
 *     what async-profiler doesn't have: thread CPU load, GC pauses, and any kind the capture lacks; t0, t1: the window
 * anything failing                                       → {"id": n, "error": "..."}
 * </pre>
 */
public final class Main {
  private static final JSON JSON_ = JSON.std;
  private static Recordings recordings;
  private static final Captures captures = new Captures();

  public static void main(String[] args) throws Exception {
    recordings = new Recordings();
    PrintStream out = new PrintStream(System.out, false, StandardCharsets.UTF_8);
    System.setOut(System.err);  // stdout is the protocol; anything else that prints goes to stderr
    try (ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
         BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
      String line;
      while ((line = in.readLine()) != null) {
        if (line.isBlank()) continue;
        String req = line;
        pool.submit(() -> {
          String resp = handle(req);
          synchronized (out) {
            out.println(resp);
            out.flush();
          }
        });
      }
    }
    // stdin closed: the server is gone. Exit even though JFR's event-stream threads (not daemons) are still running,
    // or every server restart while recording leaves a helper behind.
    System.exit(0);
  }

  static String handle(String line) {
    Object id = null;
    Map<String, Object> resp = new LinkedHashMap<>();
    try {
      Map<String, Object> req = JSON_.mapFrom(line);
      id = req.get("id");
      resp.put("id", id);
      String op = String.valueOf(req.get("op"));
      switch (op) {
        case "ping" -> {
          resp.put("version", Main.class.getPackage().getImplementationVersion());
          resp.put("java", System.getProperty("java.version"));
        }
        case "jcmd" -> resp.put("out", Jcmd.execute(pid(req), String.valueOf(req.get("cmd"))));
        case "threads" -> {
          long interval = req.get("interval_ms") instanceof Number n ? n.longValue() : 1000;
          resp.put("dump", Jcmd.threads(pid(req), interval));
        }
        case "record_start" -> resp.put("recording", recordings.start(pid(req), (int) num(req, "stack_depth", 0)));
        case "record_stop" -> resp.put("recording", recordings.stop(pid(req)));
        case "recordings" -> resp.put("recordings", recordings.list());
        case "activities" -> resp.put("activities", recordings.profile(pid(req)).activities(num(req, "since", 0)));
        case "thread_activity" -> resp.put("threads", recordings.profile(pid(req)).threadActivity(num(req, "since", 0), (int) num(req, "bins", 150),
            num(req, "now_ms", 5000), (int) num(req, "max_threads", 40)));
        case "minute" -> resp.put("minute", recordings.profile(pid(req)).minute(num(req, "t0", 0), num(req, "t1", Long.MAX_VALUE)));
        case "stacks" -> {
          List<Integer> ids = new ArrayList<>();
          if (req.get("ids") instanceof List<?> l) for (Object o : l) if (o instanceof Number n) ids.add(n.intValue());
          resp.put("stacks", recordings.profile(pid(req)).stacks(ids));
        }
        case "dump" -> resp.put("dump", recordings.profile(pid(req)).dump(num(req, "since", 0)));
        case "summary" -> resp.put("summary", recordings.profile(pid(req)).summary(num(req, "since", 0), (int) num(req, "bins", 300)));
        case "flame" -> {
          List<Long> threads = new ArrayList<>();
          if (req.get("threads") instanceof List<?> l) for (Object o : l) if (o instanceof Number n) threads.add(n.longValue());
          if (req.get("group") instanceof String g) threads.addAll(recordings.profile(pid(req)).threadsInGroup(g));
          resp.put("flame", recordings.profile(pid(req)).flame(num(req, "t0", 0), num(req, "t1", Long.MAX_VALUE),
              String.valueOf(req.getOrDefault("kind", "cpu")), threads, 0.002, Boolean.TRUE.equals(req.get("reverse")), names(req, "path"),
              Boolean.TRUE.equals(req.get("classes"))));
        }
        case "capture_stats" -> {
          // the capture's own kinds, and JFR's in its window (t0, t1) when there's a context: what the capture can show
          Map<String, Object> stats = captures.load(path(req, "path")).stats();
          Profile ctx = context(req);
          if (ctx != null) {
            @SuppressWarnings("unchecked") Map<String, Long> kinds = new LinkedHashMap<>((Map<String, Long>) stats.get("kinds"));
            ctx.kinds(num(req, "t0", 0), num(req, "t1", Long.MAX_VALUE)).forEach(kinds::putIfAbsent);
            stats.put("kinds", kinds);
          }
          resp.put("stats", stats);
        }
        case "capture_summary" -> resp.put("summary", Profile.summary(captures.load(path(req, "path")), context(req), num(req, "t0", 0),
            num(req, "t1", Long.MAX_VALUE), (int) num(req, "bins", 300)));
        case "capture_flame" -> {
          String kind = String.valueOf(req.getOrDefault("kind", "cpu"));
          boolean reverse = Boolean.TRUE.equals(req.get("reverse"));
          String detail = String.valueOf(req.getOrDefault("frames", ""));
          if (!List.of("", "line", "bci").contains(detail)) throw new IllegalArgumentException("frames: '', line or bci");
          long t0 = num(req, "t0", 0), t1 = num(req, "t1", Long.MAX_VALUE);
          Profile cap = captures.load(path(req, "path"), detail), ctx = context(req);
          int k = Profile.KINDS.indexOf(kind);
          // a kind async-profiler has, from the capture; any other, from JFR's recording of the same window
          Profile src = ctx == null || k >= 0 && cap.has(k, t0, t1) ? cap : ctx;
          List<Long> threads = new ArrayList<>();
          if (req.get("threads") instanceof List<?> l) for (Object o : l) if (o instanceof Number n) threads.add(n.longValue());
          if (req.get("group") instanceof String g) threads.addAll(src.threadsInGroup(g));
          resp.put("flame", req.get("base") != null
              ? Profile.diff(captures.load(path(req, "base"), detail), cap, kind, reverse, 0.002)
              : src.flame(t0, t1, kind, threads, 0.002, reverse, names(req, "zoom"),
                  Boolean.TRUE.equals(req.get("classes")), src == cap && Boolean.TRUE.equals(req.get("categories"))));
          if (src != cap) ((Map<String, Object>) resp.get("flame")).put("source", "jfr");
        }
        default -> throw new IllegalArgumentException("unknown op: " + op);
      }
      return JSON_.asString(resp);
    } catch (Throwable e) {
      Map<String, Object> err = new LinkedHashMap<>();
      err.put("id", id);
      err.put("error", e.getClass().getSimpleName() + ": " + e.getMessage());
      try {
        return JSON_.asString(err);
      } catch (Exception impossible) {
        return "{\"id\":null,\"error\":\"unserializable\"}";
      }
    }
  }

  /** JFR's recording of a capture's JVM and window: the file dumped beside it once it ended ("jfr"), else the live
   *  recording ("pid"), else none. */
  private static Profile context(Map<String, Object> req) throws Exception {
    if (req.get("jfr") instanceof String s && s.endsWith(".jfr") && java.nio.file.Files.exists(java.nio.file.Path.of(s))) return captures.loadJfr(java.nio.file.Path.of(s));
    if (req.get("pid") instanceof Number n) return recordings.profileOrNull(n.longValue());
    return null;
  }

  private static java.nio.file.Path path(Map<String, Object> req, String key) {
    if (req.get(key) instanceof String s && s.endsWith(".jfr")) return java.nio.file.Path.of(s);
    throw new IllegalArgumentException(key + ": a .jfr file required");
  }

  private static List<String> names(Map<String, Object> req, String key) {
    List<String> out = new ArrayList<>();
    if (req.get(key) instanceof List<?> l) for (Object o : l) out.add(String.valueOf(o));
    return out;
  }

  private static long num(Map<String, Object> req, String key, long dflt) {
    return req.get(key) instanceof Number n ? n.longValue() : dflt;
  }

  private static long pid(Map<String, Object> req) {
    if (req.get("pid") instanceof Number n) return n.longValue();
    throw new IllegalArgumentException("pid required");
  }
}
