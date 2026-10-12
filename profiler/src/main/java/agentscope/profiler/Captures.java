package agentscope.profiler;

import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

/** async-profiler capture files (JFR format), read into {@link Profile}s on demand and kept for a few queries. Each
 *  load first reads any chunks finished since the last, so a capture being written grows as it's queried. */
public final class Captures {
  private static final int KEEP = 6;
  private final Map<String, CaptureFile> cache = new LinkedHashMap<>(16, 0.75f, true) {
    @Override protected boolean removeEldestEntry(Map.Entry<String, CaptureFile> e) { return size() > KEEP; }
  };

  private final Map<Path, Profile> jfrs = new LinkedHashMap<>(16, 0.75f, true) {
    @Override protected boolean removeEldestEntry(Map.Entry<Path, Profile> e) { return size() > KEEP; }
  };

  /** JFR's own recording of a capture's window, dumped beside it when the capture ended: read once with the JDK's
   *  parser (it's JFR's file, and small: JFR's sampler, a window of a minute or two). */
  public Profile loadJfr(Path file) throws Exception {
    synchronized (jfrs) {
      Profile p = jfrs.get(file);
      if (p == null) {
        p = new Profile(Runtime.getRuntime().availableProcessors());
        try (jdk.jfr.consumer.RecordingFile f = new jdk.jfr.consumer.RecordingFile(file)) {
          while (f.hasMoreEvents()) p.accept(f.readEvent());
        }
        jfrs.put(file, p);
      }
      return p;
    }
  }

  public Profile load(Path file) throws Exception {
    return load(file, "");
  }

  /** {@code detail}: how Java frames are named, see {@link Profile#Profile(int, String)}; each is read and cached separately. */
  public Profile load(Path file, String detail) throws Exception {
    CaptureFile f;
    synchronized (this) {
      f = cache.computeIfAbsent(file + "|" + detail, k -> new CaptureFile(file, detail));
    }
    return f.poll();
  }
}
