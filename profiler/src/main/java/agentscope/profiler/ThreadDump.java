package agentscope.profiler;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A parsed {@code jcmd <pid> Thread.print -l}. The text format is stable enough across JDK 8 to 27 to parse: a header
 * line per thread (whose key=value fields vary by version), an optional {@code java.lang.Thread.State} line, frames,
 * lock lines under frames, then ownable synchronizers. Deadlock reports come last.
 */
public record ThreadDump(String time, String vm, List<Thread> threads, List<String> deadlocks) {

  public record Frame(String text, List<String> locks) {}

  /**
   * @param num      the Java thread number ({@code #12}), absent for VM-internal threads and before JDK 9
   * @param cpuMs    CPU time so far, JDK 11+
   * @param cpuDelta CPU milliseconds between two dumps, see {@link #withCpuDelta}
   */
  public record Thread(String name, Integer num, String nid, boolean daemon, Integer prio, Double cpuMs, Double elapsedS,
                       String status, String state, List<Frame> frames, List<String> synchronizers, boolean vm,
                       boolean deadlocked, Double cpuDelta) {

    String key() { return num != null ? "#" + num : name + "/" + nid; }

    Thread with(boolean deadlocked, Double cpuDelta) {
      return new Thread(name, num, nid, daemon, prio, cpuMs, elapsedS, status, state, frames, synchronizers, vm, deadlocked, cpuDelta);
    }
  }

  private static final Pattern HEADER = Pattern.compile(
      "^\"(?<name>.*)\"(?: #(?<num>\\d+))?(?: \\[\\d+\\])?(?<daemon> daemon)?(?<kv>(?: \\w+=\\S+)*)\\s*(?<status>.*?)\\s*(?:\\[0x[0-9a-f]+\\])?\\s*$");
  private static final Pattern KV = Pattern.compile("(\\w+)=(\\S+)");
  private static final Pattern DEADLOCKED_NAME = Pattern.compile("^\"(.*)\":$");

  public static ThreadDump parse(String text) {
    String[] lines = text.split("\\R");
    String time = null, vm = null;
    List<Builder> threads = new ArrayList<>();
    List<String> deadlocks = new ArrayList<>();
    Builder cur = null;
    boolean synchronizers = false;
    int i = 0;
    for (; i < lines.length; i++) {
      String line = lines[i];
      if (line.startsWith("Found one Java-level deadlock") || line.startsWith("JNI global ref")) break;
      if (vm == null && line.startsWith("Full thread dump ")) { vm = line.substring("Full thread dump ".length()).replaceAll(":$", ""); continue; }
      if (time == null && vm == null && line.matches("\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d")) { time = line; continue; }
      if (line.startsWith("\"")) {
        Matcher m = HEADER.matcher(line);
        if (!m.matches()) continue;
        cur = new Builder(m);
        threads.add(cur);
        synchronizers = false;
        continue;
      }
      if (cur == null) continue;
      String t = line.strip();
      if (t.startsWith("java.lang.Thread.State: ")) cur.state = t.substring("java.lang.Thread.State: ".length());
      else if (t.startsWith("at ")) cur.frames.add(new Frame(t.substring(3), new ArrayList<>()));
      else if (t.equals("Locked ownable synchronizers:")) synchronizers = true;
      else if (t.startsWith("- ") && !t.equals("- None")) {
        if (synchronizers) cur.synchronizers.add(t.substring(2));
        else if (!cur.frames.isEmpty()) cur.frames.getLast().locks().add(t.substring(2));
      }
    }
    // Deadlock reports: "Found one Java-level deadlock:" ... "Found N deadlock(s)."
    Set<String> deadlocked = new HashSet<>();
    StringBuilder block = null;
    boolean names = false;
    for (; i < lines.length; i++) {
      String line = lines[i];
      if (line.startsWith("Found one Java-level deadlock")) {
        if (block != null) deadlocks.add(block.toString().strip());
        block = new StringBuilder();
        names = true;
      }
      if (block == null) continue;
      if (line.startsWith("Java stack information")) names = false;
      if (names) {
        Matcher m = DEADLOCKED_NAME.matcher(line);
        if (m.matches()) deadlocked.add(m.group(1));
      }
      if (line.matches("Found \\d+ deadlocks?\\.")) { deadlocks.add(block.toString().strip()); block = null; continue; }
      block.append(line).append('\n');
    }
    if (block != null) deadlocks.add(block.toString().strip());
    List<Thread> out = new ArrayList<>();
    for (Builder b : threads) out.add(b.build(deadlocked.contains(b.name)));
    return new ThreadDump(time, vm, out, deadlocks);
  }

  /** This dump, with each thread's CPU time since {@code earlier} (threads that started in between count from zero). */
  public ThreadDump withCpuDelta(ThreadDump earlier) {
    Map<String, Double> before = new HashMap<>();
    for (Thread t : earlier.threads) if (t.cpuMs() != null) before.put(t.key(), t.cpuMs());
    List<Thread> out = new ArrayList<>();
    for (Thread t : threads) {
      Double d = t.cpuMs() == null ? null : Math.max(0, Math.round((t.cpuMs() - before.getOrDefault(t.key(), 0.0)) * 10) / 10.0);
      out.add(t.with(t.deadlocked(), d));
    }
    return new ThreadDump(time, vm, out, deadlocks);
  }

  private static final class Builder {
    final String name, nid, status;
    final Integer num, prio;
    final boolean daemon;
    final Double cpuMs, elapsedS;
    String state;
    final List<Frame> frames = new ArrayList<>();
    final List<String> synchronizers = new ArrayList<>();

    Builder(Matcher m) {
      name = m.group("name");
      num = m.group("num") == null ? null : Integer.valueOf(m.group("num"));
      daemon = m.group("daemon") != null;
      status = m.group("status");
      Map<String, String> kv = new HashMap<>();
      Matcher k = KV.matcher(m.group("kv"));
      while (k.find()) kv.put(k.group(1), k.group(2));
      prio = kv.containsKey("prio") ? Integer.valueOf(kv.get("prio")) : null;
      nid = kv.get("nid");
      cpuMs = number(kv.get("cpu"), "ms");
      elapsedS = number(kv.get("elapsed"), "s");
    }

    Thread build(boolean deadlocked) {
      // VM-internal threads (GC, JIT compiler, VM Thread) have no Java thread number on JDK 9+ and no Thread.State line
      boolean vm = state == null && frames.isEmpty() && (num == null || !status.contains("waiting"));
      return new Thread(name, num, nid, daemon, prio, cpuMs, elapsedS, status, state, List.copyOf(frames), List.copyOf(synchronizers), vm, deadlocked, null);
    }

    private static Double number(String s, String unit) {
      if (s == null || !s.endsWith(unit)) return null;
      try {
        return Double.valueOf(s.substring(0, s.length() - unit.length()));
      } catch (NumberFormatException e) {
        return null;
      }
    }
  }
}
