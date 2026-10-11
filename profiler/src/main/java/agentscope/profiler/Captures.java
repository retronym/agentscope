package agentscope.profiler;

import jdk.jfr.consumer.RecordingFile;

import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

/** async-profiler capture files (JFR format), read into {@link Profile}s on demand and kept for a few queries. */
public final class Captures {
  private static final int KEEP = 6;
  private final Map<String, Profile> cache = new LinkedHashMap<>(16, 0.75f, true) {
    @Override protected boolean removeEldestEntry(Map.Entry<String, Profile> e) { return size() > KEEP; }
  };

  public Profile load(Path file) throws Exception {
    return load(file, "");
  }

  /** {@code detail}: how Java frames are named, see {@link Profile#Profile(int, String)}; each is read and cached separately. */
  public synchronized Profile load(Path file, String detail) throws Exception {
    String key = file + "|" + detail;
    Profile p = cache.get(key);
    if (p == null) {
      p = new Profile(Runtime.getRuntime().availableProcessors(), detail, true);
      try (RecordingFile f = new RecordingFile(file)) {
        while (f.hasMoreEvents()) p.accept(f.readEvent());
      }
      cache.put(key, p);
    }
    return p;
  }
}
