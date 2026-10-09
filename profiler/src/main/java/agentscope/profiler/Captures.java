package agentscope.profiler;

import jdk.jfr.consumer.RecordingFile;

import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

/** async-profiler capture files (JFR format), read into {@link Profile}s on demand and kept for a few queries. */
public final class Captures {
  private static final int KEEP = 6;
  private final Map<Path, Profile> cache = new LinkedHashMap<>(16, 0.75f, true) {
    @Override protected boolean removeEldestEntry(Map.Entry<Path, Profile> e) { return size() > KEEP; }
  };

  public synchronized Profile load(Path file) throws Exception {
    Profile p = cache.get(file);
    if (p == null) {
      p = new Profile(Runtime.getRuntime().availableProcessors());
      try (RecordingFile f = new RecordingFile(file)) {
        while (f.hasMoreEvents()) p.accept(f.readEvent());
      }
      cache.put(file, p);
    }
    return p;
  }
}
