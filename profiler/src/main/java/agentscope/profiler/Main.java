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
 * anything failing                                       → {"id": n, "error": "..."}
 * </pre>
 */
public final class Main {
  private static final JSON JSON_ = JSON.std;
  private static Recordings recordings;

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
        case "record_start" -> resp.put("recording", recordings.start(pid(req)));
        case "record_stop" -> resp.put("recording", recordings.stop(pid(req)));
        case "recordings" -> resp.put("recordings", recordings.list());
        case "summary" -> resp.put("summary", recordings.profile(pid(req)).summary(num(req, "since", 0), (int) num(req, "bins", 300)));
        case "flame" -> {
          List<Long> threads = new ArrayList<>();
          if (req.get("threads") instanceof List<?> l) for (Object o : l) if (o instanceof Number n) threads.add(n.longValue());
          resp.put("flame", recordings.profile(pid(req)).flame(num(req, "t0", 0), num(req, "t1", Long.MAX_VALUE),
              String.valueOf(req.getOrDefault("kind", "cpu")), threads, 0.002, Boolean.TRUE.equals(req.get("reverse"))));
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

  private static long num(Map<String, Object> req, String key, long dflt) {
    return req.get(key) instanceof Number n ? n.longValue() : dflt;
  }

  private static long pid(Map<String, Object> req) {
    if (req.get("pid") instanceof Number n) return n.longValue();
    throw new IllegalArgumentException("pid required");
  }
}
