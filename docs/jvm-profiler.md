# Design: a built-in JVM profiler

Status: all five phases are done. What remains is under Future work.

## Problem

The heaviest thing agentscope shows on most cards is a JVM: an sbt server, a forked test JVM, Bloop, a Gradle daemon, Metals. Today it can say *that* session X's sbt server has burned 40 CPU-minutes and holds 3 GB. It can't say *why*: compiling or testing, GC-thrashing near `-Xmx`, one thread spinning while the rest are parked, or stuck behind a lock. The agent driving that build can't see this either; it just waits on a slow command.

The goal is a JVM view that covers both scales:

- **All JVMs at once**, like `top`/`jtop`: one row per JVM, attributed to its session, with heap, GC, threads and CPU. Cheap enough to be always on.
- **One JVM in depth**: what each thread is doing over time (Gradle's live worker view, IntelliJ's thread timeline), and where CPU, wall time and allocation go (async-profiler flame graphs, its sub-second heatmap, continuous profiling à la Pyroscope/Parca).

It has to stay a well-behaved guest. These JVMs are running the agents' builds, so the profiler must never change their output, slow them noticeably, or attach to anything without a reason.

## Key decisions

### 1. Three tiers of intrusiveness, escalated explicitly

| Tier | Mechanism | Cost to the target | Scope |
|---|---|---|---|
| 0. **Observe** | Read `hsperfdata` (the mmap'd file `jps`/`jstat` use) | none: no attach, no safepoint | every JVM, always |
| 1. **Record** | Continuous JFR via `JFR.start` with our own low-overhead `.jfc`, ring-buffered to disk | ≲1% | only while **Record** is on (below) |
| 2. **Capture** | async-profiler for a bounded window (wall, alloc, lock, native, `--all`) | higher; loads a native agent that can't be unloaded | one JVM, on explicit click |

Plus on-demand **snapshots** (`Thread.print`, `GC.heap_info`, `VM.native_memory`), each one click, each labelled with what it costs (`GC.class_histogram` forces a full GC, so it says so).

Why JFR for the continuous tier rather than async-profiler: `JFR.start` via jcmd is a diagnostic command, not an agent, so it leaves nothing behind in the target, whereas async-profiler's agent can't be unloaded once attached. JEP 451 also says a dynamically loaded JVMTI agent prints a warning to the *target's* stderr on JDK 21+ (for an sbt server, into the build output the agent is reading); in practice async-profiler 4.5 attaching to JDK 21.0.12 printed nothing, but that's not something to rely on across versions. JFR's sampler is good enough for "where does the time go". async-profiler stays for the questions JFR answers poorly: wall-clock across all threads, native frames, precise allocation and lock profiling.

### 2. Tier 0 is a pure-Python hsperfdata reader

`$TMPDIR/hsperfdata_$USER/<pid>` holds every counter `jstat` shows: GC counts and times per collector, generation capacities and usage, safepoint time, live threads, classes loaded, JIT time, the command line and JVM version. A spike against the JVMs on this machine (JDK 21, 25 and 27: five sbt servers, IntelliJ, Bloop) parsed each file in **~0.3 ms** with `struct` and about 30 lines of code. So the existing 5-second `Sampler` can read every JVM each tick at no cost to anyone, and agentscope stays stdlib-only for this tier.

From deltas between samples: GC % of wall, allocation rate (eden turnover), safepoint %, class-loading and JIT activity, heap headroom against max. Counter names drift between JDKs (e.g. `sun.os.hrt.ticks` is absent on 25+); the reader treats every counter as optional. JVMs run with `-XX:-UsePerfData` don't appear in the directory; they're still visible in `ps`, and are marked "no perf data".

### 3. A Java helper owns attach and JFR; Python owns storage and UI

Parsing JFR in Python would mean reimplementing a self-describing binary format that changes across JDKs. Instead, a Java helper in `profiler/` (a Maven project with the Maven wrapper, Java 21, shaded into one jar, built by `mise run build-profiler`) does everything that touches a target JVM:

- **Attach**: `JFR.start`/`stop`/`configure`, `Thread.print` and friends go through the Attach API (`VirtualMachine.attach(pid)`, `--add-exports jdk.attach/sun.tools.attach` for `executeJCmd`), so a command costs a socket round trip, not a `jcmd` JVM startup.
- **Live tailing**: `EventStream.openRepository(path)` (`jdk.jfr.consumer`) follows a running recording's on-disk repository from another process, the same mechanism JMC uses. The repository path comes from `JFR.configure`.
- **Aggregation**: interns frames and stacks, and emits JSON lines to the Python server once a second per JVM: per-thread CPU (`jdk.ThreadCPULoad`), per-thread state and top stack from `jdk.ExecutionSample`/`NativeMethodSample`, sample counts per sub-second slot (for the heatmap), GC pauses, allocation and contention samples.
- **Range queries**: "collapsed stacks for pid P, t0..t1, these threads, this event" re-reads the repository directly, so selections within the retention window (default 30 min) are exact, not minute-snapped.

- **Deep-dive rendering**: chunks covering the selected range are concatenated into a `.jfr` file (chunks are self-contained, so that's a valid recording) and rendered in-process.

The protocol with Python is JSON lines over stdin/stdout. The helper is started when recording starts or a snapshot is requested, and exits when idle. It's a JVM itself, so it's attributed to an *agentscope* bucket and its own overhead is on the page. If the jar hasn't been built, tier 0 still works and **Record** says how to build it.

Libraries, each because it pulls its weight:

- (Planned, then dropped: `tools.profiler:jfr-converter` for async-profiler's HTML. Captures need async-profiler installed anyway, and it ships `jfrconv`, so the server runs that.)
- **`jackson-jr-objects`** (~100 KB): JSON both ways on the pipe, rather than hand-rolled escaping.

Tier 2 still needs async-profiler installed (`asprof` and its native library); without it the capture buttons are hidden.

### 4. Attribution comes for free

Each JVM is a process the existing `Sampler` already attributes to a session (ancestry, cwd, sticky, mentioned). The JVM view inherits that, so every flame graph can be rooted at session → JVM → thread group → frames. That gives the all-JVM view its shape: a machine-wide flame graph where the first two levels answer "which session, which build".

### 5. Recording is opt-in: a **Record** button in the header

Nothing is attached until you press **Record** in the page header. While recording, the button pulses (a slow red pulse, like a camera's tally light) and shows elapsed time; pressing it again stops. Its dropdown chooses the scope:

- **Agent JVMs** (default): JVMs attributed to a session.
- **All JVMs**: also IntelliJ, your own apps, anything else of yours with perf data.

While on, JVMs that start in scope are picked up once they've been up 5 s, so a long build is covered without re-pressing. A JVM panel also has its own record toggle for when you want exactly one JVM. Recordings are named `agentscope`, so they're recognisable in `JFR.check` and never touch the user's own; they're stopped on **Stop**, and when agentscope exits. Data recorded stays browsable after stopping (raw for as long as the JFR repository lives, aggregates per the retention below).

Short-lived forked test JVMs are the awkward case: they're often where the time goes, but they can finish before an attach is worthwhile. Future work: a `-XX:StartFlightRecording` snippet for a session to add to its forked JVMs, writing into a directory the helper watches.

### 6. A low-overhead recording configuration

Our `agentscope.jfc` starts from the JDK's `default.jfc` (designed for continuous production use, <1%) and trims further. Enabled:

| Event | Setting | Why |
|---|---|---|
| `jdk.ExecutionSample` | every 20 ms | CPU flame graphs, heatmap, thread lanes |
| `jdk.NativeMethodSample` | every 100 ms | threads in native code (I/O, zip) |
| `jdk.ThreadCPULoad` | every 1 s | per-thread CPU for the lanes and `top` |
| `jdk.GarbageCollection`, `jdk.GCPhasePause`, `jdk.GCHeapSummary` | on | GC pauses and heap over time |
| `jdk.ObjectAllocationSample` | throttled to 50/s | allocation flame graph, near-free |
| `jdk.JavaMonitorEnter`, `jdk.ThreadPark` | ≥ 20 ms | contention |

Everything else is off, notably `jdk.OldObjectSample`, TLAB allocation events, class loading, and socket/file I/O events. A settings file that lists only these leaves every other event off on any JDK (checked with `JFR.check verbose=true`), so one small file serves all versions. Recording options: `disk=true maxage=30m maxsize=250m`.

Measured, not assumed: `mise run bench-overhead` runs javac in a loop in a child JVM and alternates 30-second windows with and without the recording, followed live as the helper does. On this machine (shared with a dozen agent sessions), 10 pairs of 15-second windows gave a median of 182.7 ms of CPU per compile without the recording and 181.4 ms with it: no difference above the noise. Throughput per window swung by ±20% with the machine's other load, which is why the benchmark reports CPU per compile. The one visible cost is a one-off: the first window after JFR's very first start in a JVM used about twice the CPU per compile while JFR initialized itself.

### 7. Turning stacks into "what is it doing": an activity classifier

Gradle's console is useful because it says `> :core:compileScala` per worker rather than showing frames. We get most of the way there for any JVM with an ordered list of frame rules applied to each sample's stack, first match wins:

| frame pattern | activity |
|---|---|
| `scala.tools.nsc.typechecker.*` | scalac: typer |
| `scala.tools.nsc.backend.jvm.*` | scalac: backend |
| `dotty.tools.dotc.*` (by phase class) | scala 3: <phase> |
| `sbt.internal.inc.*` | zinc |
| `org.scalatest.*`, `munit.*`, `org.junit.*` | test |
| `coursier.*` | dependency resolution |
| `org.gradle.api.internal.tasks.compile.*` | javac |
| GC / JIT / VM threads | gc / jit / vm |

Rules are data (a table in the code to begin with), and unmatched stacks fall back to the top non-JDK frame. Each thread's activity over time drives the thread lanes; the dominant activities per JVM become a one-line summary on the session card ("scalac typer ×3, test ×1"), which is the Gradle-style live view.

### 8. Storage: raw in JFR, aggregates in SQLite

The JFR repository *is* the raw store for the recent window; we don't copy samples. SQLite gets what's needed beyond it, pruned like the existing tables:

- `jvm`: pid, start time, session, label, JDK version, collector, main class, options. Kept 30 days.
- `jvm_minute`: tier-0 counters per minute (CPU, RSS, heap used / committed / max, GC and safepoint %, alloc rate, threads, classes, young and full GCs). Kept 30 days like `proc_minute`: a year of per-minute rows for every idle IDE and daemon isn't worth the space.
- `frame`, `node`, `tgroup`: constant pools, as in JFR's own format. Frames are opaque strings, stored once. Stacks are a prefix tree of (parent, frame) nodes, so stacks share their common prefixes; a node that ends a sampled stack also records the stack's activity (a function of the stack, not of each sample).
- `sample_blob`: per JVM, minute and kind (cpu, native, alloc, lock, park), one zlib-compressed run of varints, (thread group, node delta, weight) sorted by node. Lossless: nothing is folded away. Kept 7 days, so flame graphs for older ranges are minute-resolution.

The sub-second heatmap is only for the live window (the helper's 30 minutes); it isn't stored.

Thread groups are thread names with numeric suffixes stripped (`scala-execution-context-global-17` → `scala-execution-context-global-*`), which keeps cardinality sane.

### 9. Rendering: our own canvas views, asprof's HTML for deep dives

Flame graph and heatmap are hand-written canvas components (in `static/jvm.js`, not `index.html`), because they need to be linked: brushing the heatmap or thread lanes re-queries the flame graph, the flame graph is rooted at sessions, and they share the page's theme. For a deep dive, a capture opens in async-profiler's own HTML flame graph (`jfrconv`), with its search and reverse views; differential flame graphs between captures are drawn by the page's renderer.

## What the user sees

- **Record button** in the header, beside the status chips: idle, or pulsing red with elapsed time and the number of JVMs being recorded. Dropdown for scope (agent JVMs / all JVMs).
- **Session cards** get a JVM line: label, heap bar against max, GC %, and the activity summary. Red when GC % or heap headroom says it's in trouble.
- **JVMs section (all JVMs).** A `top`-style table: pid, label, session, uptime, CPU, heap used / max, GC %, alloc rate, safepoint %, threads, recording state, with sparklines. Below it, the machine-wide flame graph rooted at sessions, for the selected time range.
- **JVM panel (one JVM).**
  - Time series: CPU, heap by generation with GC pauses as ticks, alloc rate.
  - Thread lanes: one row per thread (grouped), coloured by state (on-CPU, runnable, blocked, waiting/parked, native), labelled with activity. Sorted by CPU. This is the "live task view".
  - Heatmap: seconds across, sub-second down (as in async-profiler 4). Brushing it, or a span of thread lanes, selects a range.
  - Flame graph for the selection, switchable between CPU, wall (when captured), alloc and lock, filterable by thread group or activity.
  - Snapshots and captures: thread dump with deadlock detection, heap info, async-profiler captures listed with their duration and events, any two diffable.
- **Health flags** in Loose ends: JVMs with GC > 20% of wall, heap within 10% of max, a thread pinned at 100% for minutes, or a deadlock in the last dump.

## Phases

Each phase is usable on its own.

- **DONE 1. JVM top (tier 0).** `jvm.py`: hsperfdata reader, JVM tracker in the sampler, `jvm`/`jvm_minute`, `/api/jvm`. `static/jvm.{js,css}`: the JVMs section with expandable rows and a 3 h chart, the line on session cards, the drawer section, **JVMs in trouble** in Loose ends. JVMs are now always considered for cwd attribution, however small. The demo export anonymizes and inlines it all. Learned along the way:
  - The user dir must come from `getpwuid`, as HotSpot does; `$USER` can be unset (it was under the preview server).
  - Counter sets differ: JDK 25+ JBR lacks `sun.os.hrt.ticks`; ZGC has no eden; G1 and ZGC report the whole heap as each generation's max, so max heap is `-Xmx`, else one generation's max, else the sum.
  - Allocation is estimated from eden turnover, assuming eden is full at each GC; it's suppressed while GC takes over half the time, where that assumption breaks (a Serial-GC thrash test read 2.8 GB/s).
  - A deliberately thrashing test JVM (`-Xmx32m`, 25 MB live) tripped all three flags within a minute and was attributed to its session via the scratchpad.
- **DONE 2. Helper and snapshots.** `profiler/` (Maven wrapper, Java 21, shaded jar, `mise run build-profiler`): `Main` speaks JSON lines, `Jcmd` attaches via the Attach API, `ThreadDump` parses `Thread.print -l` into threads, frames, locks and deadlocks. `helper.py` starts the jar on first use and stops it after 5 idle minutes. The expanded JVM row gets **Threads**, **Heap**, **Class histogram** (asks first: it walks the heap at a safepoint) and **Native memory** buttons, behind `POST /api/jvm/snapshot`, which only accepts a JVM the tracker currently sees, only `application/json`, and refuses foreign `Origin`s. Threads are two dumps a second apart, so each thread carries its CPU over that second; the view groups threads by name with their numbering wildcarded, puts deadlocks and the busiest groups first, and hides idle threads unless asked. Tests: the parser against a captured JDK 21 dump, and the attach path against a child JVM with a deadlock, a spinning thread and an idle pool. Learned along the way:
  - `InputStream.readAllBytes()` on the attach socket stream returns only the first 8 KiB (JDK 21.0.12, macOS); reading into the start of a buffer in a loop, as `jcmd` does, gets everything. It silently truncated thread dumps past the first dozen threads.
  - jackson-jr leaves out null fields, so the page treats every optional thread field as possibly absent.
  - The helper is a JVM too, and shows up in the list as *agentscope helper*.
- **DONE 3. Continuous JFR (tier 1).** `agentscope.jfc` (embedded in the helper, written to a temp file for the target to read). The helper's `Recordings` starts or adopts an `agentscope` recording, finds its repository via `JFR.configure`, and follows it with `EventStream.openRepository` into a `Profile`: interned frames and stacks, samples in parallel primitive arrays, 30 minutes kept, and still browsable after Stop or after the JVM exits. Queries: `summary` (per-thread lanes, a 20-slot sub-second heatmap, GC pauses, at most 300 time bins) and `flame` (a tree for a range, by kind, optionally one thread, folding nodes under 0.2%). `recording.py`: the Record switch and scope, per-JVM overrides, picking up JVMs in scope once they've been up 5 s (JDK 14+), stopping everything on Stop and on exit (SIGTERM included), and stopping a crash's leftovers on the next start (pids kept beside the database). `static/profile.js`: the pulsing **Record** button with elapsed time and JVM count, a dot on recording rows, and in the full JVM view a heatmap, thread lanes and a flame graph, linked by brushing a range; click a lane's name to see only that thread, click a frame to zoom. Tests record a child JVM and read it back while it runs. Learned along the way:
  - JFR's sampler hardly sees a thread spinning in a tight loop: 5 execution samples in 5 seconds, where calls and allocation in the loop give the expected ~50/s. It mostly fails to walk a stack whose PC sits in compiled loop code without debug info. Real workloads sample fine, but it's a bias to know about, and one reason for async-profiler in phase 5.
  - `jdk.ThreadCPULoad`'s user and system are fractions of the whole machine, not of a core: multiply by the CPU count.
  - Global Record on this machine picked up 6 JVMs within one sampler tick, and after Stop none had an `agentscope` recording left.
  - Sizing the helper: started for snapshots with `-Xmx128m`, Serial GC and C1 only, it spent 98% of its time in GC once 8 JVMs were recording, worst right after a server restart, when every adopted recording replayed 30 minutes at once through ordered streams. Now: a 1 GB heap (`AGENTSCOPE_HELPER_HEAP`), default GC and JIT, unordered streams, and 5 minutes of replay on adoption; with the same 8 JVMs it sat at 150–390 MB and 0% GC.
  - `EventStream`'s threads aren't daemons, so a helper whose server had gone kept running, following recordings, after its stdin closed. It now exits on end of input.
- **DONE 4. Across JVMs.** The activity classifier (`activities.txt`: ordered regexes over frames, the first rule matching any frame wins, `$1` for a captured phase name; otherwise the top non-JDK Java package; stacks with no Java frames are "native"), cached per stack. Recorded JVMs show what they're doing (last 30 s: share of CPU samples and threads per activity) on their row, their session's card and their full view. Once a minute every recording's samples go to SQLite exactly (helper: `minute` gives weights per stack id, `stacks` defines the ones the server hasn't seen, so a failed store can't lose a definition). The JVMs section gets **Across JVMs**: a flame graph over every recorded JVM for the last 15 min to 7 days, session → JVM → activity → frames, top-down or reversed, with the label levels drawn apart from frames. Measured on a javac workload plus a busy fixture: CPU blobs about 430 bytes per JVM-minute, allocation about 3.9 KB; the stack pool grew to 57k nodes in the first 4 minutes (javac's deep, varied allocation stacks), then 1.1k in the 5th as paths repeat. Learned along the way:
  - The first cut folded stacks under 0.2% into their callers to bound storage. Unnecessary: stacks are very compressible (that's most of what the JFR format is about), so the store keeps everything and compresses instead.
  - Frames are opaque. async-profiler's frames won't look like JFR's (C++ and kernel frames, itable/vtable stubs, threads with no Java frames), so a non-Java frame keeps its producer's name plus its frame type (` [Native]`, ` [C++]`...), the classifier only reads package names from Java-shaped frames, and the page colours anything else as native.
  - Unexplained, noted for later: the javac workload, compiling the same unchanged and well-typed sources in a loop, failed once after about 11 minutes with an inference error ("inference variable M has incompatible bounds") in a JVM whose recording had been started and stopped several times.
- **DONE 5. Captures (tier 2).** In a JVM's full view: capture N seconds with async-profiler, after a confirmation that names the cost (its agent stays loaded). Three presets, because on macOS CPU and wall-clock sampling can't run together: *CPU, allocation, locks* (`-e cpu --alloc 512k --lock 10ms`), *wall clock* (`-e wall`), *everything* (`--all`: wall, allocation, live objects, native memory, native and Java locks; no CPU on macOS). One capture per JVM at a time. `captures.py` runs `asprof` into a JFR file beside the database (kept 30 days) and keeps a `capture` table. The helper reads capture files on demand (`Captures`, a small LRU) into the same `Profile`, which now knows async-profiler's events (`profiler.WallClockSample`, `jdk.ObjectAllocationInNewTLAB`, `profiler.LiveObject`, `profiler.Malloc`, `profiler.NativeLock`). Each capture lists the kinds it holds; each shows as a flame graph (top-down or reversed), as a diff against another capture (red grew, blue shrank, by share of all samples), in async-profiler's own HTML via `jfrconv`, or as the `.jfr` to download. Record now survives a server restart: the switch, scope and per-JVM choices are saved, and running recordings are adopted. Captures are standalone files rather than `--jfrsync` into the continuous recording: simpler, independent of Record, and diffable. Learned along the way:
  - async-profiler names a native or C++ frame's "class" after its library (`libjvm.dylib`, `libsystem_kernel.dylib`), so frames are named by their JFR frame type, never by parsing: Java types (`Interpreted`, `JIT compiled`, `Inlined`, `C1 compiled`) give `class.method`; others give the symbol and a type tag, `thread_native_entry [C++]`.
  - async-profiler's wall-clock samples include native threads with no Java name (`[tid=259]`).
  - No JEP 451 warning appeared in the target's output (async-profiler 4.5, JDK 21.0.12, several attaches).
  - Canvases sized from their container's `clientWidth` overflowed by its padding and never shrank; they now take 100% of the content box and redraw on resize.
- **DONE: flame graph controls** (after [retronym/async-profiler@flamegraph-controls](https://github.com/retronym/async-profiler/tree/flamegraph-controls)), as one component, `static/flame.js`, used by every flame graph. Semantic zoom (click; breadcrumb and full-width ancestor bars to zoom out; Backspace up a level) and visual zoom (Ctrl/⌘+scroll or pinch at the cursor, +/−, Shift+drag a range, Shift+scroll to pan, zoom % with 1:1). Search (regex and case toggles, "X% matched (Y% of all)", N/Shift+N step and zoom to matches, Enter commits a coloured highlight chip; non-matching frames dim). A stack of filters, each removable on its own and all re-applied to the original data: keep / hide stacks through a pattern, hide one stack (Ctrl/Alt+click), merge a function away (its callees move up and same-named siblings merge; good for lambda frames and recursion), focus on a function (a new root over every outermost call, merged), Restore all. Right-click any frame for these; `?` lists the keys; I flips icicle/flame; full or abbreviated names. State is keyed by frame names, so zoom, filters and highlights survive the 5-second refresh and the top-down/reversed toggle. Diffs keep their colouring through every filter, since nodes carry both weights. Detail on zoom: servers prune nodes under 0.2% of the total to keep payloads and drawing small, but along and below the zoom path the threshold is relative to the zoomed subtree, and every zoom refetches with its path; zooming into a frame worth 0.27% of samples went from 10 nodes below it to 74, for 2,140 nodes in all instead of 2,076. Drawing is one canvas and skips frames under half a pixel, so its cost follows what's visible. After a zoom the root is scrolled into view (the toolbar is no longer sticky: it fought the graph's own scroll box and covered its top rows).
- **DONE: the machine-wide Activity view** (decision 7's Gradle-style live view, which phases 3 and 4 had only delivered per JVM, and coloured by thread state rather than activity). At the top of the JVMs section, for every recorded JVM, grouped by session: each busy thread's activity right now and the frame that earned it, then one lane per thread over the last 5 or 30 minutes coloured by activity (a stable colour per activity, the catch-alls grey). Click a lane to open that JVM's profile filtered to the thread; drag across the lanes to set Across JVMs' range. The helper's `thread_activity` gives, per thread, the dominant activity per time bin and its latest sample; the server queries every recorded JVM in parallel and caches for 2 s. `Activities.explain` now returns the frame that earned the activity, the innermost frame matching the winning rule or, for a package-named activity, the innermost frame in that package: `Infer$BestLeafSolver.computeTreeToLeafs` for javac rather than `StringLatin1.lastIndexOf`. In `static/activity.js`.
- **DONE: stack depth.** JFR records 64 frames by default, which truncates a compiler's recursion (javac's attribution goes well past it). Recordings now ask for 512 (`JFR.configure stackdepth=…`), captures for 4096 (async-profiler's `-j`; its own default is 2048); both are settings, saved with Record's state. JFR only accepts a depth before it has initialized in the target, and *any* JFR command initializes it, `JFR.check` included, so the configure has to come first, and on a JVM where JFR was already running it's silently ignored. The recording reports the depth actually in effect, and the page says when it's lower than asked. Deep flame graphs scroll inside their panel instead of pushing everything below it off-screen. Measured again at depth 512 (`mise run bench-overhead`, on a quieter machine): median CPU per compile 108.9 ms without the recording, 109.6 ms with it (+0.6%); throughput unchanged at 8.2 compiles/s. Only the first window after JFR starts in a JVM pays visibly, as before.

Before phase 3: a spike that a JDK 21 consumer can tail repositories written by the oldest JVMs we expect (JDK 8u, 11, 17), and that `EventStream.openRepository` copes with chunk rotation and the target exiting mid-stream.

## Future work

- **Let agents ask.** A text endpoint (`/api/jvm/<pid>/summary`: activity breakdown, top frames, GC health for the last N minutes) that a session can `curl` to find out why its own build is slow, instead of guessing.
- **Forked JVMs** via a startup-recording snippet (see decision 5).
- **Build-tool progress** from the source: Gradle's Tooling API progress events, sbt's server/BSP, which name tasks directly rather than inferring them from stacks.
- **Linux**: `perf_events` and kernel stacks through async-profiler, and JFR's `jdk.CPUTimeSample` (JDK 25, Linux only).
- **Export** collapsed stacks or OTLP profiles (async-profiler 4 speaks OTLP) to Pyroscope or similar.

## Code layout

Small files, one concern each:

- `jvm.py`: hsperfdata reader, JVM discovery and tier-0 sampling, `jvm*` tables, snapshots. `helper.py`: the helper process. `captures.py`: async-profiler captures. All imported by `agentscope.py`.
- `static/flame.js`: the flame graph component.
- `static/captures.js`: the Captures section of a JVM's full view. `static/activity.js`: the machine-wide Activity view.
- `recording.py`: the Record switch, scope and per-JVM recordings; activities and per-minute storage. `profiles.py`: the stored profiles (pools, blobs, the machine-wide query).
- `static/jvm.js`: the JVMs section, full view and snapshots. `static/profile.js`: the Record button, heatmap, thread lanes and flame graph.
- `profiler/`: the Maven project (`pom.xml`, `mvnw`, `src/main/java/...`, `src/main/resources/agentscope.jfc`), building `profiler/target/agentscope-profiler.jar`.

## Resolved questions

1. **Recording policy**: opt-in only, via the header **Record** button (decision 5).
2. **Java helper**: yes, as a Maven project; libraries are fine when they pull their weight (decision 3).
3. **JVMs not owned by a session**: the user's choice, via the Record scope (decision 5).
4. **File layout**: `jvm.py` and friends, preferring smaller files (Code layout).
