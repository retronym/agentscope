package agentscope.profiler;

import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/** Records a real child JVM and reads it back while it runs. */
class RecordingsTest {
  @Test
  @SuppressWarnings("unchecked")
  void recordsTheSpinner() throws Exception {
    try (FixtureProcess f = new FixtureProcess(Path.of(System.getProperty("java.home")))) {
      Recordings recs = new Recordings();
      long t0 = System.currentTimeMillis();
      Map<String, Object> started = recs.start(f.pid());
      assertEquals(false, started.get("adopted"));
      Thread.sleep(5000);  // JFR flushes the repository about once a second; give it a few

      Profile p = recs.profile(f.pid());
      Map<String, Object> s = p.summary(t0, 300);
      List<Map<String, Object>> threads = (List<Map<String, Object>>) s.get("threads");
      Map<String, Object> top = threads.getFirst();
      assertEquals("spinner", top.get("name"), threads.toString());
      // jdk.ThreadCPULoad is a fraction of the machine; scaled to cores, a spinning thread is about one
      Map<Integer, double[]> bins = (Map<Integer, double[]>) top.get("bins");
      double peak = bins.values().stream().mapToDouble(c -> c[0]).max().orElse(0);
      assertTrue(peak > 0.7 && peak < 1.3, "spinner peak " + peak + " cores");

      Map<String, Object> flame = p.flame(t0, Long.MAX_VALUE, "cpu", List.of((Long) top.get("tid")), 0.002, false);
      assertTrue((long) flame.get("samples") > 50, flame.toString());
      assertTrue(flame.toString().contains("agentscope.profiler.Fixture.lambda$main$"), flame.toString());
      // reversed, the root's children are leaves (where time is spent), and Thread.run is deep down, not at the top
      List<Object> rev = (List<Object>) p.flame(t0, Long.MAX_VALUE, "cpu", List.of((Long) top.get("tid")), 0.002, true).get("root");
      List<List<Object>> leaves = (List<List<Object>>) rev.get(2);
      assertFalse(leaves.stream().anyMatch(k -> k.get(0).equals("java.lang.Thread.run")), leaves.toString());
      assertEquals(rev.get(1), ((List<Object>) flame.get("root")).get(1), "same total either way");

      // the fixture's busy thread is in agentscope.profiler code: no rule names it, so it's named after its package
      List<Map<String, Object>> acts = p.activities(t0);
      assertEquals("agentscope.profiler", acts.getFirst().get("activity"), acts.toString());

      // for storage: exact weights per stack, and stack definitions on request
      Map<String, Object> minute = p.minute(t0, Long.MAX_VALUE);
      List<List<Object>> rows = (List<List<Object>>) minute.get("rows");
      long cpuTotal = rows.stream().filter(r -> r.get(0).equals("cpu")).mapToLong(r -> ((Number) r.get(3)).longValue()).sum();
      assertEquals((long) p.flame(t0, Long.MAX_VALUE, "cpu", List.of(), 0.002, false).get("total"), cpuTotal);
      List<Integer> ids = rows.stream().map(r -> (Integer) r.get(2)).filter(i -> i >= 0).distinct().toList();
      Map<String, Object> defs = p.stacks(ids);
      assertEquals(ids.size(), ((List<?>) defs.get("stacks")).size());


      // a second start adopts the running recording rather than starting another
      Recordings again = new Recordings();
      assertEquals(true, again.start(f.pid()).get("adopted"));
      assertTrue(String.valueOf(recs.stop(f.pid()).get("result")).contains("Stopped recording"));
      again.stop(f.pid());
    }
  }
}
