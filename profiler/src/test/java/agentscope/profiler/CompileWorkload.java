package agentscope.profiler;

import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.SimpleJavaFileObject;
import javax.tools.ToolProvider;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/** A compiler-shaped workload for measuring profiling overhead: javac, in process, on generated sources, forever. */
public final class CompileWorkload {
  public static void main(String[] args) throws Exception {
    JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
    Path out = Files.createTempDirectory("workload");
    List<JavaFileObject> sources = new ArrayList<>();
    for (int i = 0; i < 8; i++) sources.add(source(i));
    while (true) {
      boolean ok = javac.getTask(null, null, null, List.of("-d", out.toString(), "-proc:none"), null, sources).call();
      if (!ok) throw new IllegalStateException("compile failed");
      // wall clock and this process's CPU time, so overhead can be judged per compile even on a busy machine
      System.out.println(System.nanoTime() + " " + ((com.sun.management.OperatingSystemMXBean) java.lang.management.ManagementFactory.getOperatingSystemMXBean()).getProcessCpuTime());
      System.out.flush();
    }
  }

  static JavaFileObject source(int i) {
    StringBuilder b = new StringBuilder("package gen; import java.util.*; import java.util.function.*; import java.util.stream.*;\n");
    b.append("public class C").append(i).append(" {\n");
    for (int m = 0; m < 12; m++) {
      b.append("  public <T extends Comparable<T>> Map<String, List<T>> m").append(m)
       .append("(List<T> xs, Function<T, String> f) { return xs.stream().filter(Objects::nonNull).sorted()")
       .append(".collect(Collectors.groupingBy(x -> f.apply(x) + \"").append(m).append("\", TreeMap::new, Collectors.toList())); }\n");
      b.append("  record R").append(m).append("(int a, String b, Optional<Double> c) { R").append(m)
       .append(" { if (a < 0) throw new IllegalArgumentException(); } }\n");
    }
    b.append("}\n");
    String code = b.toString();
    return new SimpleJavaFileObject(URI.create("string:///gen/C" + i + ".java"), JavaFileObject.Kind.SOURCE) {
      @Override public CharSequence getCharContent(boolean ignore) { return code; }
    };
  }
}
