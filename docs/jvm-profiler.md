# Design: a built-in JVM profiler

Status: proposal, for review. Nothing implemented yet.

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
| 1. **Record** | Continuous JFR via `jcmd JFR.start` with our own `.jfc`, ring-buffered to disk | ~1% | JVMs chosen by policy (below) |
| 2. **Capture** | async-profiler for a bounded window (wall, alloc, lock, native, `--all`) | higher; loads a native agent that can't be unloaded | one JVM, on explicit click |

Plus on-demand **snapshots** (`Thread.print`, `GC.heap_info`, `VM.native_memory`), each one click, each labelled with what it costs (`GC.class_histogram` forces a full GC, so it says so).

Why JFR for the continuous tier rather than async-profiler: on JDK 21+, dynamically loading a JVMTI agent prints `WARNING: A JVM TI agent has been loaded dynamically` to the *target's* stderr (JEP 451). For an sbt server, that lands in the build output the agent is reading. `JFR.start` via jcmd is a diagnostic command, not an agent, and prints nothing. JFR's sampler is also off-safepoint on modern JDKs, which is good enough for "where does the time go". async-profiler stays for the questions JFR answers poorly: wall-clock across all threads, native frames, precise allocation and lock profiling. With `--jfrsync`, its events go into the same recording, so tier 2 needs no separate pipeline.

### 2. Tier 0 is a pure-Python hsperfdata reader

`$TMPDIR/hsperfdata_$USER/<pid>` holds every counter `jstat` shows: GC counts and times per collector, generation capacities and usage, safepoint time, live threads, classes loaded, JIT time, the command line and JVM version. A spike against the JVMs on this machine (JDK 21, 25 and 27: five sbt servers, IntelliJ, Bloop) parsed each file in **~0.3 ms** with `struct` and about 30 lines of code. So the existing 5-second `Sampler` can read every JVM each tick at no cost to anyone, and agentscope stays stdlib-only for this tier.

From deltas between samples: GC % of wall, allocation rate (eden turnover), safepoint %, class-loading and JIT activity, heap headroom against max. Counter names drift between JDKs (e.g. `sun.os.hrt.ticks` is absent on 25+); the reader treats every counter as optional. JVMs run with `-XX:-UsePerfData` don't appear in the directory; they're still visible in `ps`, and are marked "no perf data".

### 3. A small Java helper owns JFR; Python owns storage and UI

Parsing JFR in Python would mean reimplementing a self-describing binary format that changes across JDKs. Instead, a single-file Java program (`jvm/JfrTail.java`, run with `java JfrTail.java` from JDK 21, no build step) uses the supported `jdk.jfr.consumer` API:

- **Live tailing**: `EventStream.openRepository(path)` follows a running recording's on-disk repository from another process, the same mechanism JMC uses. Repository path comes from `jcmd <pid> JFR.configure`.
- **Aggregation**: interns frames and stacks, and emits JSON lines to the Python server once a second per JVM: per-thread CPU (`jdk.ThreadCPULoad`), per-thread state and top stack from `jdk.ExecutionSample`/`NativeMethodSample`, sample counts per sub-second slot (for the heatmap), GC pauses, allocation and contention samples.
- **Range queries**: "collapsed stacks for pid P, t0..t1, these threads, this event" re-reads the repository directly, so selections within the retention window (default 30 min) are exact, not minute-snapped.

The helper is started lazily when the first recording starts and exits when there is nothing to tail. It's a JVM itself, so it's attributed to an *agentscope* bucket and its own overhead is on the page.

Using a Java helper is a departure from "plain script, stdlib only". It's justified because it is only needed when there are JVMs to profile, so a JDK is guaranteed to be present.

### 4. Attribution comes for free

Each JVM is a process the existing `Sampler` already attributes to a session (ancestry, cwd, sticky, mentioned). The JVM view inherits that, so every flame graph can be rooted at session → JVM → thread group → frames. That gives the all-JVM view its shape: a machine-wide flame graph where the first two levels answer "which session, which build".

### 5. Recording policy: auto for agent build daemons, opt-in for the rest

Proposed default: start tier-1 recording automatically for JVMs that are (a) attributed to a session, (b) a recognised long-lived build tool (sbt server, Gradle daemon, Bloop, Metals, Maven daemon), and (c) up for more than 30 s. Everything else (IntelliJ, your own apps, forked test JVMs that live for seconds) is tier 0 only, with a "record" button. A global switch turns auto-recording off. Recordings are named `agentscope` so they're recognisable in `jcmd JFR.check` and never collide with the user's own, and are stopped when agentscope exits.

Short-lived forked test JVMs are the awkward case: they are often where the time goes, but they're gone before an attach is worth it. Future work: offer a `JAVA_TOOL_OPTIONS`/`-XX:StartFlightRecording` snippet for a session to put on its forked JVMs, writing into a directory the helper watches.

### 6. Turning stacks into "what is it doing": an activity classifier

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

### 7. Storage: raw in JFR, aggregates in SQLite

The JFR repository *is* the raw store for the recent window; we don't copy samples. SQLite gets what's needed beyond it, pruned like the existing tables:

- `jvm`: pid, start time, session, label, JDK version, main class, flags. Kept a year.
- `jvm_minute`: tier-0 counters per minute (heap per generation, GC time and count, safepoint time, threads, classes, alloc rate). Kept a year.
- `stack` / `frame`: interned stacks, frames as strings.
- `sample_minute`: (jvm, minute, thread group, activity, stack, event) → count. Kept 7 days, so flame graphs for older ranges are minute-resolution.
- `heat_second`: per JVM per second, a small blob of sub-second sample counts. Kept 24 h.

Thread groups are thread names with numeric suffixes stripped (`scala-execution-context-global-17` → `scala-execution-context-global-*`), which keeps cardinality sane.

### 8. Rendering: our own canvas views, asprof's HTML for deep dives

Flame graph and heatmap are hand-written canvas components in `index.html`, because they need to be linked: brushing the heatmap or thread lanes re-queries the flame graph, the flame graph is rooted at sessions, and they share the page's theme. For a deep dive, an "Open in async-profiler" button runs `jfrconv --html` (or `--diff` between two captures) on the selected range when async-profiler is installed, reusing its search, reverse and diff views rather than rebuilding them.

## What the user sees

- **Session cards** get a JVM line: label, heap bar against max, GC %, and the activity summary. Red when GC % or heap headroom says it's in trouble.
- **JVMs tab (all JVMs).** A `top`-style table: pid, label, session, uptime, CPU, heap used / max, GC %, alloc rate, safepoint %, threads, recording state, with sparklines. Below it, the machine-wide flame graph rooted at sessions, for the selected time range.
- **JVM panel (one JVM).**
  - Time series: CPU, heap by generation with GC pauses as ticks, alloc rate.
  - Thread lanes: one row per thread (grouped), coloured by state (on-CPU, runnable, blocked, waiting/parked, native), labelled with activity. Sorted by CPU. This is the "live task view".
  - Heatmap: seconds across, sub-second down (as in async-profiler 4). Brushing it, or a span of thread lanes, selects a range.
  - Flame graph for the selection, switchable between CPU, wall (when captured), alloc and lock, filterable by thread group or activity.
  - Snapshots and captures: thread dump with deadlock detection, heap info, async-profiler captures listed with their duration and events, any two diffable.
- **Health flags** in Loose ends: JVMs with GC > 20% of wall, heap within 10% of max, a thread pinned at 100% for minutes, or a deadlock in the last dump.

## Phases

Each phase is usable on its own.

- **TODO 1. JVM top (tier 0).** hsperfdata reader in the sampler; `jvm`, `jvm_minute`; JVMs tab table; JVM line on session cards; health flags. No attach.
- **TODO 2. Snapshots.** `jcmd` thread dump (rendered and grouped, deadlocks highlighted), heap info. On demand only.
- **TODO 3. Continuous JFR (tier 1).** Our `.jfc`; recording policy and controls; the Java helper tailing repositories; thread lanes and per-thread CPU; flame graph and heatmap for a range in the JVM panel.
- **TODO 4. All JVMs.** Aggregates into SQLite; session-rooted machine-wide flame graph; activity classifier and the card summary.
- **TODO 5. Captures (tier 2).** async-profiler start/stop with `--jfrsync`; capture list; open in asprof's HTML; diff.

Before phase 3: a spike that a JDK 21 consumer can tail repositories written by the oldest JVMs we expect (JDK 8u, 11, 17), and that `EventStream.openRepository` copes with chunk rotation and the target exiting mid-stream.

## Future work

- **Let agents ask.** A text endpoint (`/api/jvm/<pid>/summary`: activity breakdown, top frames, GC health for the last N minutes) that a session can `curl` to find out why its own build is slow, instead of guessing.
- **Forked JVMs** via a startup-recording snippet (see decision 5).
- **Build-tool progress** from the source: Gradle's Tooling API progress events, sbt's server/BSP, which name tasks directly rather than inferring them from stacks.
- **Linux**: `perf_events` and kernel stacks through async-profiler, and JFR's `jdk.CPUTimeSample` (JDK 25, Linux only).
- **Export** collapsed stacks or OTLP profiles (async-profiler 4 speaks OTLP) to Pyroscope or similar.

## Open questions

1. Is auto-recording build daemons (decision 5) the right default, or should every attach be opt-in?
2. Is a Java helper acceptable (decision 3), and is `java JfrTail.java` from source good enough, or should it be a prebuilt jar cached in `~/.cache/agentscope`?
3. Should JVMs not owned by any session (IntelliJ, your own apps) get tier 1 at all, or stay observe-only?
4. `agentscope.py` is a single 1,000-line file. The JVM work roughly doubles it; I'd put it in `jvm.py` alongside, imported by the server. OK?
