package agentscope.profiler;

import one.jfr.ClassRef;
import one.jfr.JfrReader;
import one.jfr.MethodRef;
import one.jfr.StackTrace;
import one.jfr.event.AllocationSample;
import one.jfr.event.ContendedLock;
import one.jfr.event.Event;
import one.jfr.event.ExecutionSample;
import one.jfr.event.LiveObject;
import one.jfr.event.MallocEvent;
import one.jfr.event.NativeLockEvent;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.HashMap;
import java.util.Map;

/**
 * An async-profiler capture file, read into a {@link Profile} with async-profiler's own JFR parser (jfr-converter, what
 * jfrconv uses). The JDK's parser materializes a chunk's whole stack-trace pool as objects, a frame each: a 60-second
 * capture of a compiler (59k stacks, 11M frames) took over 2 GB of heap to read into a 65 MB profile. This one keeps
 * stacks as primitive arrays.
 *
 * <p>Captures run with {@code --chunktime}, so async-profiler appends a finished chunk every few seconds; {@link #poll}
 * reads whatever chunks have been finished since it last looked, so a capture can be shown while it runs.
 */
final class CaptureFile {
  private static final int MAGIC = 0x464c5200;  // "FLR\0"

  final Path file;
  final Profile profile;
  private long offset;  // where the next unread chunk starts

  CaptureFile(Path file, String detail) {
    this.file = file;
    this.profile = new Profile(Runtime.getRuntime().availableProcessors(), detail, true);
  }

  /** Reads the chunks finished since the last call. The one being written has a placeholder size (1 GB, from
   *  async-profiler) until it's done, so a chunk counts once the file holds all of its stated size. */
  synchronized Profile poll() throws IOException {
    try (FileChannel ch = FileChannel.open(file, StandardOpenOption.READ)) {
      long len = ch.size();
      ByteBuffer head = ByteBuffer.allocate(16);
      while (offset + 68 <= len) {
        head.clear();
        ch.read(head, offset);
        if (head.getInt(0) != MAGIC) throw new IOException("not a JFR chunk at " + offset + " in " + file);
        long size = head.getLong(8);
        if (size <= 0 || offset + size > len) break;
        ByteBuffer chunk = ch.map(FileChannel.MapMode.READ_ONLY, offset, size);
        synchronized (profile) {  // queries hold the profile's lock
          try (JfrReader jfr = new JfrReader(chunk)) {
            jfr.stopAtNewChunk = true;
            while (jfr.hasMoreChunks()) new Chunk(jfr, profile).read();  // ids (stacks, methods, threads) are per chunk
          }
        }
        offset += size;
      }
    }
    return profile;
  }

  private static final class Chunk {
    final JfrReader jfr;
    final Profile p;
    final Map<Integer, String> frameTypes, threadStates;
    final Map<Long, Integer> frames = new HashMap<>();  // (method, type, location) -> frame id
    final Map<Integer, Frames> stacks = new HashMap<>();  // stack trace id -> frames
    final Map<Long, Integer> interned = new HashMap<>();  // (stack trace id, allocated class frame) -> stack id
    final Map<Long, Integer> classes = new HashMap<>();  // class id -> "<class> [allocated]" frame id
    final Map<Integer, Integer> threads = new HashMap<>();  // tid -> thread

    Chunk(JfrReader jfr, Profile p) {
      this.jfr = jfr;
      this.p = p;
      frameTypes = jfr.enums.getOrDefault("jdk.types.FrameType", Map.of());
      threadStates = jfr.enums.getOrDefault("jdk.types.ThreadState", Map.of());
    }

    void read() throws IOException {
      for (Event e; (e = jfr.readEvent()) != null; ) {
        long t = jfr.eventTimeToNanos(e.time) / 1_000_000;
        switch (e) {
          // CPU samples have the default state; wall-clock ones say whether the thread was running or sleeping (as jfrconv --cpu / --wall)
          case ExecutionSample s -> add(t, s, "STATE_DEFAULT".equals(threadStates.get(s.threadState)) ? Profile.CPU : Profile.WALL, Math.max(1, s.samples), -1);
          case AllocationSample a -> add(t, a, Profile.ALLOC, a.tlabSize > 0 ? a.tlabSize : a.allocationSize, a.classId);
          case LiveObject l -> add(t, l, Profile.LIVE, l.allocationSize, l.classId);
          case MallocEvent m -> { if (m.size > 0) add(t, m, Profile.NATIVEMEM, m.size, -1); }  // size 0: a free
          // monitor and park contention alike, as jfrconv --lock: the parser doesn't say which
          case ContendedLock c -> add(t, c, Profile.LOCK, micros(c.duration), -1);
          case NativeLockEvent n -> add(t, n, Profile.NATIVELOCK, micros(n.duration), -1);
          default -> { }
        }
      }
    }

    long micros(long ticks) {
      return (long) (ticks * 1e6 / jfr.ticksPerSec);
    }

    void add(long t, Event e, int kind, long weight, long classId) {
      int allocated = classId < 0 ? -1 : classes.computeIfAbsent(classId, id -> p.frame(className(id) + " [allocated]"));
      p.addSample(t, thread(e.tid), stack(e.stackTraceId, allocated), kind, weight);
    }

    int thread(int tid) {
      return threads.computeIfAbsent(tid, x -> {
        Long javaId = jfr.javaThreads.get(tid);
        String name = jfr.threads.get(tid);
        return p.internThread(javaId != null && javaId > 0 ? javaId : -tid, name != null ? name : "[tid=" + tid + "]");
      });
    }

    int stack(int stackTraceId, int allocated) {
      return interned.computeIfAbsent((long) stackTraceId << 32 | (allocated & 0xffffffffL), k -> {
        Frames s = stacks.computeIfAbsent(stackTraceId, this::frames);
        if (s == null) return -1;
        return p.internStack(s.ids(), s.types(), allocated, s.category());
      });
    }

    /** Frame ids and types, root first, and the stack's category. */
    record Frames(int[] ids, byte[] types, int category) { }

    /** A stack's frames; null for a stack the file doesn't define. */
    Frames frames(int stackTraceId) {
      StackTrace st = jfr.stackTraces.get(stackTraceId);
      if (st == null) return null;
      int n = st.methods.length;
      int[] ids = new int[n];
      byte[] types = new byte[n];
      String[] names = new String[n];
      for (int i = 0; i < n; i++) {
        MethodRef m = jfr.methods.get(st.methods[i]);
        String owner = m == null ? "" : symbol(jfr.classes.get(m.cls) == null ? -1 : jfr.classes.get(m.cls).name).replace('/', '.');
        String method = m == null ? "unknown" : symbol(m.name);
        byte type = st.types[i];
        boolean java = type == Classify.INTERPRETED || type == Classify.JIT_COMPILED || type == Classify.INLINED || type == Classify.C1_COMPILED;
        names[i] = java && !owner.isEmpty() ? (method.isEmpty() ? owner : owner + "." + method) : method;
        int loc = st.locations == null ? 0 : st.locations[i];
        long key = st.methods[i] * 8 + type;
        types[n - 1 - i] = type >= 0 && type < Profile.FRAME_TYPES.size() ? type : -1;
        ids[n - 1 - i] = p.detail().isEmpty()
            ? frames.computeIfAbsent(key, x -> p.frame(Profile.frameName(owner, method, frameTypes.getOrDefault((int) type, "?"), -1, -1, "")))
            : p.frame(Profile.frameName(owner, method, frameTypes.getOrDefault((int) type, "?"), loc >>> 16, loc & 0xffff, p.detail()));
      }
      return new Frames(ids, types, p.category(Classify.category(names, st.types)));
    }

    String className(long classId) {
      ClassRef c = jfr.classes.get(classId);
      return c == null ? "?" : Profile.prettyClass(symbol(c.name));
    }

    String symbol(long id) {
      byte[] b = id < 0 ? null : jfr.symbols.get(id);
      return b == null ? "" : new String(b, StandardCharsets.UTF_8);
    }
  }
}
