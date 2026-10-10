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
  private static final Pattern DEPTH = Pattern.compile("Stack depth: (\\d+)");

  private record Rec(long pid, Path repo, EventStream stream, Profile profile, long since, boolean[] live, int stackDepth) {}

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

  public synchronized Map<String, Object> start(long pid) throws Exception {
    return start(pid, 0);
  }

  /**
   * Starts (or, if one is already running from an earlier helper, adopts) the recording, and follows it.
   * {@code stackDepth} > 0 asks for deeper stacks than JFR's 64; JFR only accepts that before it has initialized in
   * the target, so the depth actually in effect is reported back.
   */
  public synchronized Map<String, Object> start(long pid, int stackDepth) throws Exception {
    Rec r = recs.get(pid);
    if (r != null && r.live()[0]) return describe(r);
    // before anything else: any JFR command (even JFR.check) initializes JFR, after which the depth can't change
    if (stackDepth > 0) Jcmd.execute(pid, "JFR.configure stackdepth=" + stackDepth);
    String check = Jcmd.execute(pid, "JFR.check name=" + NAME);
    boolean adopted = check.contains("name=" + NAME) || check.contains("\"" + NAME + "\"");
    if (!adopted) {
      String out = Jcmd.execute(pid, "JFR.start name=" + NAME + " settings=" + settings + " disk=true maxage=30m maxsize=250m");
      if (!out.contains("Started recording")) throw new IllegalStateException(out.strip());
    }
    String config = Jcmd.execute(pid, "JFR.configure");
    Matcher m = REPO.matcher(config);
    if (!m.find()) throw new IllegalStateException("no JFR repository for pid " + pid);
    Matcher dm = DEPTH.matcher(config);
    int depth = dm.find() ? Integer.parseInt(dm.group(1)) : 64;
    Path repo = Path.of(m.group(1).strip());
    Profile profile = r != null ? r.profile() : new Profile(Runtime.getRuntime().availableProcessors());
    EventStream es = EventStream.openRepository(repo);
    // Adopting (after a restart of ours) replays a little history, not the whole 30 minutes: with several JVMs
    // recording, replaying all of them at once swamped the helper.
    es.setStartTime(Instant.now().minusSeconds(adopted ? 300 : 5));
    // Unordered: samples land in time bins regardless of order, and ordering makes the stream buffer and sort each segment.
    es.setOrdered(false);
    es.onEvent(profile::accept);
    boolean[] live = {true};
    es.onClose(() -> live[0] = false);
    es.startAsync();
    Rec rec = new Rec(pid, repo, es, profile, System.currentTimeMillis(), live, depth);
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
    m.put("stack_depth", r.stackDepth());
    m.putAll(r.profile().stats());
    return m;
  }
}
