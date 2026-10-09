package agentscope.profiler;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

/**
 * How much does agentscope's recording slow a JVM down? Runs {@link CompileWorkload} in a child JVM, warms it up, then
 * alternates windows with and without the recording (started, and followed live, exactly as the helper does) and
 * compares compiles per second. Usage: OverheadBench [warmup seconds] [window seconds] [pairs]
 */
public final class OverheadBench {
  public static void main(String[] args) throws Exception {
    int warmup = args.length > 0 ? Integer.parseInt(args[0]) : 60, window = args.length > 1 ? Integer.parseInt(args[1]) : 15,
        pairs = args.length > 2 ? Integer.parseInt(args[2]) : 10;
    Process p = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(), "-Xmx1g",
        "-cp", System.getProperty("java.class.path"), CompileWorkload.class.getName()).redirectErrorStream(true).start();
    AtomicLong done = new AtomicLong(), cpu = new AtomicLong();
    Thread reader = new Thread(() -> {
      try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()))) {
        for (String l; (l = r.readLine()) != null; ) {
          String[] f = l.split(" ");
          if (f.length == 2 && !f[1].isEmpty() && Character.isDigit(f[1].charAt(0))) { cpu.set(Long.parseLong(f[1])); done.incrementAndGet(); }
        }
      } catch (Exception ignored) { }
    });
    reader.setDaemon(true);
    reader.start();
    try {
      System.out.printf("pid %d: warming up for %ds, then %d pairs of %ds windows%n", p.pid(), warmup, pairs, window);
      Thread.sleep(warmup * 1000L);
      Recordings recs = new Recordings();
      List<double[]> off = new ArrayList<>(), on = new ArrayList<>();
      for (int i = 0; i < pairs; i++) {
        off.add(measure(done, cpu, window));
        recs.start(p.pid());
        Thread.sleep(2000);  // JFR's own start-up (first recording in this JVM) is not steady state
        on.add(measure(done, cpu, window));
        recs.stop(p.pid());
        System.out.printf("pair %2d: off %5.1f compiles/s %6.1f ms CPU each   on %5.1f compiles/s %6.1f ms CPU each%n",
            i + 1, off.getLast()[0], off.getLast()[1], on.getLast()[0], on.getLast()[1]);
      }
      double r0 = median(off, 0), r1 = median(on, 0), c0 = median(off, 1), c1 = median(on, 1);
      System.out.printf("median compiles/s: %.1f without, %.1f with (%+.1f%%)%n", r0, r1, (r1 - r0) / r0 * 100);
      System.out.printf("median CPU per compile: %.1f ms without, %.1f ms with (%+.1f%%)%n", c0, c1, (c1 - c0) / c0 * 100);
    } finally {
      p.destroyForcibly();
    }
  }

  /** [compiles per second, CPU milliseconds per compile] over a window. */
  static double[] measure(AtomicLong done, AtomicLong cpu, int seconds) throws InterruptedException {
    long n0 = done.get(), c0 = cpu.get(), t0 = System.nanoTime();
    Thread.sleep(seconds * 1000L);
    long n = done.get() - n0;
    return new double[]{n / ((System.nanoTime() - t0) / 1e9), n == 0 ? 0 : (cpu.get() - c0) / 1e6 / n};
  }

  static double median(List<double[]> xs, int i) {
    double[] v = xs.stream().mapToDouble(x -> x[i]).sorted().toArray();
    return v.length % 2 == 1 ? v[v.length / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  }
}
