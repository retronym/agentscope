package agentscope.profiler;

import com.sun.tools.attach.VirtualMachine;
import sun.tools.attach.HotSpotVirtualMachine;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/** Diagnostic commands through the Attach API: what {@code jcmd} does, without starting a JVM per command. */
public final class Jcmd {
  private Jcmd() {}

  public static String execute(long pid, String command) throws Exception {
    VirtualMachine vm = VirtualMachine.attach(Long.toString(pid));
    try (InputStream in = ((HotSpotVirtualMachine) vm).executeJCmd(command)) {
      // Not readAllBytes(): on the attach socket stream it stops after 8 KiB (JDK 21, macOS), truncating thread dumps.
      // Reading into the start of a buffer, as jcmd itself does, gets everything.
      ByteArrayOutputStream out = new ByteArrayOutputStream();
      byte[] buf = new byte[8192];
      for (int n; (n = in.read(buf, 0, buf.length)) != -1; ) out.write(buf, 0, n);
      return out.toString(StandardCharsets.UTF_8);
    } finally {
      try {
        vm.detach();
      } catch (IOException ignored) {
      }
    }
  }

  /** Two thread dumps {@code intervalMs} apart, the second annotated with each thread's CPU time in between. */
  public static ThreadDump threads(long pid, long intervalMs) throws Exception {
    ThreadDump first = ThreadDump.parse(execute(pid, "Thread.print -l"));
    if (intervalMs <= 0) return first;
    Thread.sleep(intervalMs);
    return ThreadDump.parse(execute(pid, "Thread.print -l")).withCpuDelta(first);
  }
}
