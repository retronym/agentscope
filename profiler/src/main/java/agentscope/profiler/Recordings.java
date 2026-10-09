package agentscope.profiler;

import jdk.jfr.consumer.EventStream;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * agentscope's JFR recordings, one per JVM, named {@value #NAME} so they never touch anyone else's. Each is followed
 * live from its on-disk repository ({@link EventStream#openRepository}) into a {@link Profile}, which outlives the
 * recording so the data stays browsable after Stop or after the JVM exits.
 */
public final class Recordings {
  static final String NAME = "agentscope";
  private static final Pattern REPO = Pattern.compile("Repository path: (.+)");

  private record Rec(long pid, Path repo, EventStream stream, Profile profile, long since, boolean[] live) {}

  private final Map<Long, Rec> recs = new ConcurrentHashMap<>();
  private final Path settings;

  public Recordings() throws IOException {
    // the target JVM reads the settings file itself, so it has to be a real file
    settings = Files.createTempFile("agentscope-", ".jfc");
    settings.toFile().deleteOnExit();
    try (InputStream in = Recordings.class.getResourceAsStream("/agentscope.jfc")) {
      Files.write(settings, in.readAllBytes());
    }
  }

  /** Starts (or, if one is already running from an earlier helper, adopts) the recording, and follows it. */
  public synchronized Map<String, Object> start(long pid) throws Exception {
    Rec r = recs.get(pid);
    if (r != null && r.live()[0]) return describe(r);
    String check = Jcmd.execute(pid, "JFR.check name=" + NAME);
    boolean adopted = check.contains("name=" + NAME) || check.contains("\"" + NAME + "\"");
    if (!adopted) {
      String out = Jcmd.execute(pid, "JFR.start name=" + NAME + " settings=" + settings + " disk=true maxage=30m maxsize=250m");
      if (!out.contains("Started recording")) throw new IllegalStateException(out.strip());
    }
    Matcher m = REPO.matcher(Jcmd.execute(pid, "JFR.configure"));
    if (!m.find()) throw new IllegalStateException("no JFR repository for pid " + pid);
    Path repo = Path.of(m.group(1).strip());
    Profile profile = r != null ? r.profile() : new Profile(Runtime.getRuntime().availableProcessors());
    EventStream es = EventStream.openRepository(repo);
    es.setStartTime(Instant.now().minusSeconds(adopted ? 1800 : 5));
    es.onEvent(profile::accept);
    boolean[] live = {true};
    es.onClose(() -> live[0] = false);
    es.startAsync();
    Rec rec = new Rec(pid, repo, es, profile, System.currentTimeMillis(), live);
    recs.put(pid, rec);
    Map<String, Object> d = describe(rec);
    d.put("adopted", adopted);
    return d;
  }

  /** Stops the recording (if the JVM is still there) and the stream; keeps the profile. */
  public synchronized Map<String, Object> stop(long pid) {
    Rec r = recs.get(pid);
    String result;
    try {
      result = Jcmd.execute(pid, "JFR.stop name=" + NAME).strip();
    } catch (Exception e) {
      result = "JVM gone: " + e.getMessage();
    }
    if (r != null) {
      r.stream().close();
      r.live()[0] = false;
    }
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("pid", pid);
    m.put("result", result);
    return m;
  }

  public Profile profile(long pid) {
    Rec r = recs.get(pid);
    if (r == null) throw new IllegalArgumentException("no recording for pid " + pid);
    return r.profile();
  }

  public Map<String, Object> list() {
    Map<String, Object> m = new LinkedHashMap<>();
    recs.forEach((pid, r) -> m.put(pid.toString(), describe(r)));
    return m;
  }

  private static Map<String, Object> describe(Rec r) {
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("pid", r.pid());
    m.put("repo", r.repo().toString());
    m.put("since", r.since());
    m.put("live", r.live()[0]);
    m.putAll(r.profile().stats());
    return m;
  }
}
