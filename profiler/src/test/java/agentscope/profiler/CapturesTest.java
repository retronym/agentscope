package agentscope.profiler;

import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/** Runs async-profiler (when installed) against a child JVM and reads the capture. */
class CapturesTest {
  static String asprof() {
    for (String p : List.of("/opt/homebrew/bin/asprof", "/usr/local/bin/asprof", "/usr/bin/asprof")) if (Files.isExecutable(Path.of(p))) return p;
    return null;
  }

  @Test
  @SuppressWarnings("unchecked")
  void wallClockCaptureHasNativeFramesTaggedNotParsed() throws Exception {
    String asprof = asprof();
    Assumptions.assumeTrue(asprof != null, "async-profiler not installed");
    try (FixtureProcess f = new FixtureProcess(Path.of(System.getProperty("java.home")))) {
      Path out = Files.createTempFile("capture", ".jfr");
      Process p = new ProcessBuilder(asprof, "-e", "wall", "-d", "2", "-o", "jfr", "-f", out.toString(), Long.toString(f.pid())).inheritIO().start();
      assertEquals(0, p.waitFor());
      Profile prof = new Captures().load(out);
      Map<String, Long> kinds = (Map<String, Long>) prof.stats().get("kinds");
      assertTrue(kinds.getOrDefault("wall", 0L) > 0, kinds.toString());
      String flame = prof.flame(0, Long.MAX_VALUE, "wall", List.of(), 0.001, false).toString();
      assertFalse(flame.contains("libsystem_kernel.dylib.") || flame.contains("libjvm.dylib."), "library names aren't classes: " + flame);
      assertTrue(flame.contains(" [Native]") || flame.contains(" [C++]"), flame);
      assertTrue(flame.contains("agentscope.profiler.Fixture"), flame);
      // a capture diffed against itself: every node unchanged
      Map<String, Object> d = Profile.diff(prof, prof, "wall", false, 0.001);
      List<Object> root = (List<Object>) d.get("root");
      assertEquals(root.get(1), root.get(4));
    }
  }

  @Test
  @SuppressWarnings("unchecked")
  void allocationCaptureWithLinesAndAllocatedClasses() throws Exception {
    String asprof = asprof();
    Assumptions.assumeTrue(asprof != null, "async-profiler not installed");
    try (FixtureProcess f = new FixtureProcess(Path.of(System.getProperty("java.home")))) {
      Path out = Files.createTempFile("capture", ".jfr");
      Process p = new ProcessBuilder(asprof, "-e", "cpu", "--alloc", "16k", "-F", "vtable", "-d", "2", "-o", "jfr", "-f", out.toString(), Long.toString(f.pid())).inheritIO().start();
      assertEquals(0, p.waitFor());
      Captures caps = new Captures();
      String plain = caps.load(out).flame(0, Long.MAX_VALUE, "alloc", List.of(), 0.001, false).toString();
      assertFalse(plain.contains("[allocated]"), "classes only when asked: " + plain);
      String classes = caps.load(out).flame(0, Long.MAX_VALUE, "alloc", List.of(), 0.001, false, List.of(), true).toString();
      assertTrue(classes.contains(" [allocated]"), classes);
      String reversed = caps.load(out).flame(0, Long.MAX_VALUE, "alloc", List.of(), 0.001, true, List.of(), true).toString();
      List<Object> first = (List<Object>) ((List<Object>) ((List<Object>) caps.load(out).flame(0, Long.MAX_VALUE, "alloc", List.of(), 0.001, true, List.of(), true).get("root")).get(2)).get(0);
      assertTrue(String.valueOf(first.get(0)).endsWith(" [allocated]"), "reversed: the class is the root: " + reversed);
      String lines = caps.load(out, "line").flame(0, Long.MAX_VALUE, "cpu", List.of(), 0.001, false).toString();
      assertTrue(lines.matches("(?s).*agentscope\\.profiler\\.Fixture[\\w$.]*:\\d+.*"), lines);
      String bci = caps.load(out, "bci").flame(0, Long.MAX_VALUE, "cpu", List.of(), 0.001, false).toString();
      assertTrue(bci.matches("(?s).*agentscope\\.profiler\\.Fixture[\\w$.]*@\\d+.*"), bci);
    }
  }

  @Test
  void prettyClassNames() {
    assertEquals("byte[]", Profile.prettyClass("[B"));
    assertEquals("java.lang.String[][]", Profile.prettyClass("[[Ljava.lang.String;"));
    assertEquals("java.lang.String", Profile.prettyClass("java/lang/String"));
    assertEquals("java.lang.String[]", Profile.prettyClass("java.lang.String[]"));
  }
}
