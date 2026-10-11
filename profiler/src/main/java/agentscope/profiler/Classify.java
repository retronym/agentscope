package agentscope.profiler;

import java.util.List;

/**
 * What kind of work a native-aware stack (an async-profiler capture's) is: GC, JIT, VM, class loading, interpreter,
 * compiled Java... The same rules as async-profiler's own {@code jfrconv --classify} (one.convert.Classifier, Apache-2.0),
 * from the same frame types, read by the same parser ({@link CaptureFile}), so the flame graph shows the categories it would.
 */
final class Classify {
  /** The category names, as async-profiler titles them. */
  static final String GC = "[gc]", JIT = "[jit]", VM = "[vm]", VTABLE_STUBS = "[vtable_stubs]", NATIVE = "[native]", INTERPRETER = "[Interpreter]",
      C1_COMP = "[c1_comp]", C2_COMP = "[c2_comp]", ADAPTER = "[c2i_adapter]", CLASS_INIT = "[class_init]", CLASS_LOAD = "[class_load]",
      CLASS_RESOLVE = "[class_resolve]", CLASS_VERIFY = "[class_verify]", LAMBDA_INIT = "[lambda_init]";
  static final List<String> ALL = List.of(GC, JIT, VM, VTABLE_STUBS, NATIVE, INTERPRETER, C1_COMP, C2_COMP, ADAPTER, CLASS_INIT, CLASS_LOAD,
      CLASS_RESOLVE, CLASS_VERIFY, LAMBDA_INIT);

  static final byte INTERPRETED = 0, JIT_COMPILED = 1, INLINED = 2, NATIVE_T = 3, CPP = 4, KERNEL = 5, C1_COMPILED = 6;

  private Classify() { }

  /** {@code names} and {@code types} (async-profiler's frame types, 0-6): leaf first, as JFR stores them. Java frames
   *  are named "class.method", others by their symbol. */
  static String category(String[] names, byte[] types) {
    String c = gcJit(names, types);
    if (c == null) c = classLoading(names, types);
    return c != null ? c : other(names, types);
  }

  private static String gcJit(String[] names, byte[] types) {
    boolean vmThread = false;
    for (int i = types.length; --i >= 0; ) {
      if (types[i] == CPP) {
        switch (names[i]) {
          case "CompileBroker::compiler_thread_loop": return JIT;
          case "GCTaskThread::run", "WorkerThread::run": return GC;
          case "java_start", "thread_native_entry": vmThread = true; break;
          default: break;
        }
      } else if (types[i] != NATIVE_T) {
        break;
      }
    }
    return vmThread ? VM : null;
  }

  private static String classLoading(String[] names, byte[] types) {
    for (int i = 0; i < names.length; i++) {
      String m = names[i];
      if (m.equals("Verifier::verify")) return CLASS_VERIFY;
      if (m.startsWith("InstanceKlass::initialize")) return CLASS_INIT;
      if (m.startsWith("LinkResolver::") || m.startsWith("InterpreterRuntime::resolve") || m.startsWith("SystemDictionary::resolve")) return CLASS_RESOLVE;
      if (m.endsWith("ClassLoader.loadClass")) return CLASS_LOAD;
      if (m.endsWith("LambdaMetafactory.metafactory") || m.endsWith("LambdaMetafactory.altMetafactory")) return LAMBDA_INIT;
      if (m.endsWith("table stub")) return VTABLE_STUBS;
      if (m.equals("Interpreter")) return INTERPRETER;
      if (m.startsWith("I2C/C2I")) return i + 1 < types.length && types[i + 1] == INTERPRETED ? INTERPRETER : ADAPTER;
    }
    return null;
  }

  private static String other(String[] names, byte[] types) {
    boolean inJava = true;
    for (int i = 0; i < types.length; i++) {
      switch (types[i]) {
        case INTERPRETED: return inJava ? INTERPRETER : NATIVE;
        case JIT_COMPILED: return inJava ? C2_COMP : NATIVE;
        case INLINED: inJava = true; break;
        case NATIVE_T: {
          String m = names[i];
          if (m.startsWith("JVM_") || m.startsWith("Unsafe_") || m.startsWith("MHN_") || m.startsWith("jni_")) return VM;
          switch (m) {
            case "call_stub", "deoptimization", "unknown_Java", "not_walkable_Java", "InlineCacheBuffer": return VM;
            default: break;
          }
          if (m.endsWith("_arraycopy") || m.contains("pthread_cond")) break;
          inJava = false;
          break;
        }
        case CPP:
          if (names[i].startsWith("Runtime1::")) return C1_COMP;
          break;
        case C1_COMPILED: return inJava ? C1_COMP : NATIVE;
        default: break;
      }
    }
    return NATIVE;
  }
}
