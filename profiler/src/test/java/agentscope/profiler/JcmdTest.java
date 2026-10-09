package agentscope.profiler;

import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/** Attaches to a real child JVM. */
class JcmdTest {
  @Test
  void threadsFindsTheDeadlockAndTheSpinner() throws Exception {
    try (FixtureProcess f = new FixtureProcess(Path.of(System.getProperty("java.home")))) {
      ThreadDump d = Jcmd.threads(f.pid(), 500);
      assertNotNull(d.vm());
      List<String> deadlocked = d.threads().stream().filter(ThreadDump.Thread::deadlocked).map(ThreadDump.Thread::name).sorted().toList();
      assertEquals(List.of("deadlock-a", "deadlock-b"), deadlocked, () -> Jcmd.class + " saw " + d.deadlocks() + " / " + d.threads().stream().map(t -> t.name() + ":" + t.state()).toList());
      assertEquals(1, d.deadlocks().size());
      ThreadDump.Thread a = byName(d, "deadlock-a");
      assertEquals("BLOCKED (on object monitor)", a.state());
      assertTrue(a.frames().getFirst().locks().stream().anyMatch(l -> l.startsWith("waiting to lock")), a.frames().toString());
      ThreadDump.Thread spinner = byName(d, "spinner");
      assertTrue(spinner.daemon());
      assertEquals("RUNNABLE", spinner.state());
      assertTrue(spinner.cpuDelta() > 250, "spinner used " + spinner.cpuDelta() + "ms of 500");
      assertTrue(byName(d, "fixture-pool-1").state().startsWith("WAITING"));
      assertTrue(d.threads().stream().anyMatch(ThreadDump.Thread::vm), "VM-internal threads (GC, compiler) are listed and marked");
    }
  }

  @Test
  void jcmdRunsDiagnosticCommands() throws Exception {
    try (FixtureProcess f = new FixtureProcess(Path.of(System.getProperty("java.home")))) {
      assertTrue(Jcmd.execute(f.pid(), "GC.heap_info").contains("total"));
    }
  }

  static ThreadDump.Thread byName(ThreadDump d, String name) {
    return d.threads().stream().filter(t -> t.name().equals(name)).findFirst().orElseThrow(() -> new AssertionError("no thread " + name));
  }
}
