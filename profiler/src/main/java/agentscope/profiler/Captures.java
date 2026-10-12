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
