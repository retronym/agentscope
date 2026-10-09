package agentscope.profiler;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/** A JVM with something to see in a thread dump: a deadlock, a spinning thread, an idle pool. Prints "ready". */
public final class Fixture {
  static volatile long sink;

  public static void main(String[] args) throws Exception {
    Object a = new Object(), b = new Object();
    CountDownLatch both = new CountDownLatch(2);
    deadlocker("deadlock-a", a, b, both).start();
    deadlocker("deadlock-b", b, a, both).start();
    // Busy with ordinary work: calls and allocation. (A bare counting loop is nearly invisible to JFR's sampler,
    // which mostly fails to walk a stack whose PC is inside a tight compiled loop.)
    Thread spinner = new Thread(() -> { while (true) sink += work(); }, "spinner");
    spinner.setDaemon(true);
    spinner.start();
    AtomicInteger n = new AtomicInteger();
    ExecutorService pool = Executors.newFixedThreadPool(3, r -> new Thread(r, "fixture-pool-" + n.incrementAndGet()));
    for (int i = 0; i < 3; i++) pool.submit(() -> sink++);
    both.await();
    Thread.sleep(200);  // let the deadlock close
    System.out.println("ready");
    System.out.flush();
    Thread.sleep(Long.parseLong(args.length > 0 ? args[0] : "60000"));
    System.exit(0);
  }

  static int work() {
    java.util.Map<String, Integer> m = new java.util.HashMap<>();
    for (int i = 0; i < 2000; i++) m.merge(Integer.toString(i % 97), i, Integer::sum);
    return m.size();
  }

  private static Thread deadlocker(String name, Object first, Object second, CountDownLatch both) {
    Thread t = new Thread(() -> {
      synchronized (first) {
        both.countDown();
        try { both.await(); } catch (InterruptedException e) { return; }
        synchronized (second) { sink++; }
      }
    }, name);
    t.setDaemon(true);
    return t;
  }
}
