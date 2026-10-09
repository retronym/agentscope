package agentscope.profiler;

import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/** Parses dumps captured from {@link Fixture} on different JDKs. */
class ThreadDumpTest {
  static ThreadDump load(String name) throws Exception {
    try (InputStream in = ThreadDumpTest.class.getResourceAsStream("/" + name)) {
      return ThreadDump.parse(new String(in.readAllBytes(), StandardCharsets.UTF_8));
    }
  }

  @Test
  void jdk21() throws Exception {
    ThreadDump d = load("jdk21.txt");
    assertTrue(d.vm().startsWith("OpenJDK 64-Bit Server VM (21"), d.vm());
    assertEquals(List.of("deadlock-a", "deadlock-b"), d.threads().stream().filter(ThreadDump.Thread::deadlocked).map(ThreadDump.Thread::name).sorted().toList());
    assertEquals(1, d.deadlocks().size());
    assertTrue(d.deadlocks().getFirst().contains("which is held by \"deadlock-b\""));
    ThreadDump.Thread a = JcmdTest.byName(d, "deadlock-a");
    assertEquals(28, a.num());
    assertTrue(a.daemon());
    assertEquals("waiting for monitor entry", a.status());
    assertNotNull(a.cpuMs());
    assertTrue(a.frames().getFirst().locks().getFirst().startsWith("waiting to lock <"));
    assertTrue(a.frames().getFirst().locks().get(1).startsWith("locked <"));
    ThreadDump.Thread main = JcmdTest.byName(d, "main");
    assertEquals("TIMED_WAITING (sleeping)", main.state());
    assertFalse(main.vm());
    assertTrue(JcmdTest.byName(d, "VM Thread").vm());
  }

  @Test
  void cpuDeltaMatchesThreadsByNumber() throws Exception {
    ThreadDump d = load("jdk21.txt");
    ThreadDump later = d.withCpuDelta(d);
    assertEquals(0.0, JcmdTest.byName(later, "spinner").cpuDelta());
  }
}
