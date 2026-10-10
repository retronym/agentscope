package agentscope.profiler;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

class ActivitiesTest {
  static String of(String... rootFirst) { return Activities.classify(List.of(rootFirst)); }

  @Test
  void compilerPhasesBeatTheToolsAroundThem() {
    assertEquals("scalac: typer", of("java.lang.Thread.run", "sbt.internal.inc.AnalyzingCompiler.compile", "scala.tools.nsc.Global$Run.compileUnits",
        "scala.tools.nsc.typechecker.Typers$Typer.typed", "java.util.HashMap.get"));
    assertEquals("scalac: erasure", of("scala.tools.nsc.Global$Run.compileUnits", "scala.tools.nsc.transform.Erasure$ErasureTransformer.transform"));
    assertEquals("scala 3: typer", of("dotty.tools.dotc.Run.compile", "dotty.tools.dotc.typer.Typer.typed"));
    assertEquals("zinc", of("sbt.internal.inc.IncrementalCompile.apply", "java.util.zip.ZipFile.getEntry"));
    assertEquals("test", of("sbt.ForkMain.main", "org.scalatest.Suite.run", "com.example.MySpec.test"));
  }

  @Test
  void explainsWithTheFrameThatEarnedIt() {
    List<String> st = List.of("java.lang.Thread.run", "sbt.internal.inc.AnalyzingCompiler.compile", "scala.tools.nsc.Global$Run.compileUnits",
        "scala.tools.nsc.typechecker.Typers$Typer.typedApply", "scala.tools.nsc.typechecker.Infer$Inferencer.isCompatible", "java.util.HashMap.get");
    Activities.Activity a = Activities.explain(st);
    assertEquals("scalac: typer", a.label());
    assertEquals("scala.tools.nsc.typechecker.Infer$Inferencer.isCompatible", st.get(a.frame()), "the innermost frame of the winning rule");
    List<String> app = List.of("java.lang.Thread.run", "com.example.app.Server.handle", "com.example.app.Codec.decode", "java.lang.String.indexOf");
    assertEquals("com.example.app.Codec.decode", app.get(Activities.explain(app).frame()));
  }

  @Test
  void fallsBackToThePackage() {
    assertEquals("com.example.app", of("java.lang.Thread.run", "com.example.app.Server.handle", "java.lang.String.indexOf"));
    // a class and its lambdas are one package
    assertEquals("agentscope.profiler", of("java.lang.Thread.run", "agentscope.profiler.Fixture$$Lambda.0x0000008001000c30.run"));
    assertEquals("agentscope.profiler", of("java.lang.Thread.run", "agentscope.profiler.Fixture.work"));
    assertEquals("JDK", of("java.lang.Thread.run", "java.util.concurrent.ForkJoinWorkerThread.run"));
  }

  @Test
  void nonJavaFramesAreOpaque() {
    // async-profiler style: C++ and kernel frames, stubs, mixed into Java stacks; none of them is a package
    assertEquals("com.example.app", of("thread_start", "JavaThread::run() [C++]", "com.example.app.Server.handle", "itable stub", "__psynch_cvwait [Kernel]"));
    assertEquals("native", of("thread_start", "GCTaskThread::run() [C++]", "G1ParEvacuateFollowersClosure::do_void() [C++]"));
    assertEquals("JDK", of("java.lang.Thread.run", "Unsafe_Park [Native]", "__psynch_cvwait [Kernel]"));
  }

  @Test
  void threadGroups() {
    assertEquals("pool-*-thread-*", Activities.threadGroup("pool-3-thread-12"));
    assertEquals("G1 Conc#*", Activities.threadGroup("G1 Conc#0"));
    assertEquals("C2 CompilerThread*", Activities.threadGroup("C2 CompilerThread0"));
  }
}
