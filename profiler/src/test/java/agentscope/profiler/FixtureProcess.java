package agentscope.profiler;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.file.Path;

/** Runs {@link Fixture} in a child JVM until closed. */
final class FixtureProcess implements AutoCloseable {
  final Process process;

  FixtureProcess(Path javaHome) throws Exception {
    process = new ProcessBuilder(javaHome.resolve("bin/java").toString(), "-cp", System.getProperty("java.class.path"),
        Fixture.class.getName(), "120000").redirectErrorStream(true).start();
    BufferedReader r = new BufferedReader(new InputStreamReader(process.getInputStream()));
    String line;
    while ((line = r.readLine()) != null && !line.equals("ready")) { }
    if (line == null) throw new IllegalStateException("fixture exited before it was ready");
  }

  long pid() { return process.pid(); }

  @Override public void close() { process.destroyForcibly(); }
}
