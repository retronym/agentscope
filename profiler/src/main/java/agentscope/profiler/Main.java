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
 * {"id": 6, "op": "flame", "pid": 123, "t0": ms, "t1": ms, "kind": "cpu", "threads": [ids], "reverse": false} → {"id": 6, "flame": {...}}
 * {"id": 7, "op": "activities", "pid": 123, "since": ms}    → {"id": 7, "activities": [{activity, samples, threads}]}
 * {"op": "thread_activity", "pid": 123, "since": ms, "bins": 150}  → {"threads": {...}}  per thread: activity per bin, and right now
 * {"id": 8, "op": "minute", "pid": 123, "t0": ms, "t1": ms}  → {"id": 8, "minute": {groups, rows}}   exact, for storage
 * {"id": 9, "op": "stacks", "pid": 123, "ids": [stack ids]}   → {"id": 9, "stacks": {frames, stacks}}  definitions
 * {"op": "capture_stats", "path": "x.jfr"}  /  {"op": "capture_flame", "path": "x.jfr", "kind": "wall", "base": "y.jfr"?}   async-profiler captures; base: a diff
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
        case "summary" -> resp.put("summary", recordings.profile(pid(req)).summary(num(req, "since", 0), (int) num(req, "bins", 300)));
        case "flame" -> {
          List<Long> threads = new ArrayList<>();
          if (req.get("threads") instanceof List<?> l) for (Object o : l) if (o instanceof Number n) threads.add(n.longValue());
          resp.put("flame", recordings.profile(pid(req)).flame(num(req, "t0", 0), num(req, "t1", Long.MAX_VALUE),
              String.valueOf(req.getOrDefault("kind", "cpu")), threads, 0.002, Boolean.TRUE.equals(req.get("reverse"))));
        }
        case "capture_stats" -> resp.put("stats", captures.load(path(req, "path")).stats());
        case "capture_flame" -> {
          List<Long> threads = new ArrayList<>();
          if (req.get("threads") instanceof List<?> l) for (Object o : l) if (o instanceof Number n) threads.add(n.longValue());
          String kind = String.valueOf(req.getOrDefault("kind", "cpu"));
          boolean reverse = Boolean.TRUE.equals(req.get("reverse"));
          resp.put("flame", req.get("base") != null
              ? Profile.diff(captures.load(path(req, "base")), captures.load(path(req, "path")), kind, reverse, 0.002)
              : captures.load(path(req, "path")).flame(0, Long.MAX_VALUE, kind, threads, 0.002, reverse));
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

  private static java.nio.file.Path path(Map<String, Object> req, String key) {
    if (req.get(key) instanceof String s && s.endsWith(".jfr")) return java.nio.file.Path.of(s);
    throw new IllegalArgumentException(key + ": a .jfr file required");
  }

  private static long num(Map<String, Object> req, String key, long dflt) {
    return req.get(key) instanceof Number n ? n.longValue() : dflt;
  }

  private static long pid(Map<String, Object> req) {
    if (req.get("pid") instanceof Number n) return n.longValue();
    throw new IllegalArgumentException("pid required");
  }
}
