# PLAN: captures without the trade-offs

## Why

Record (JFR) and Capture (async-profiler) each give you only part of the picture. Record is cheap and continuous, with thread lanes, a heatmap, GC pauses and Activity, but it sees Java frames only, can't do wall clock, and its sampler misses tight loops. Capture sees everything async-profiler can (native, wall clock, live objects, native memory, categories), but only as a flame graph, and only after the window ends. Choosing a mode shouldn't mean choosing between those.

The aim: what's left to trade off is only what async-profiler itself costs, a native agent that stays loaded and higher overhead, for a bounded window. Everything else a capture shows the way Record does, and while it runs.

## Key decisions

- **A capture is a Record with async-profiler's samples on top.** Starting a capture records the JVM with JFR (if it isn't already) for at least the capture's window. JFR supplies what async-profiler doesn't: per-thread CPU load, GC pauses, parks, and its own samples of any kind the capture lacks. Recording costs ≲1% and leaves nothing loaded in the target.
- **Not `--jfrsync`.** Tried with async-profiler 4.5 on JDK 21 / macOS. It writes nothing until the capture stops, so there's no live view. Its JFR settings also turn on JFR's own CPU sampler alongside async-profiler's, which duplicates samples. And the JDK's `jfr` tool can't see async-profiler's samples in the file it produces.
- **Chunked capture files, read as they grow.** `asprof --chunktime 5` appends a finished chunk to the file every 5 s; the helper's async-profiler parser picks up complete chunks as they land, so the view fills in during the run.
- **One rule for overlapping kinds.** A kind (CPU, allocation, locks) comes from async-profiler when the capture has it, else from JFR. Thread CPU load and GC pauses always come from JFR.
- **Self-contained afterwards.** At the end, JFR's data for the capture's window is dumped beside the capture file (`JFR.dump begin=…`). The capture then reads the same after the JVM exits or the server restarts, and that `.jfr` opens in JMC.
- **The capture view is the profile view.** Heatmap, thread lanes, GC ticks, a kind switch over the union of kinds, brushing a range, filtering to a thread, and the flame graph with all of a capture's extras (categories, allocated classes, line/bci).

## Steps

- [x] 1. Helper: read a growing capture file. Complete chunks only, and each query picks up any new ones first. Tested against a file still being written.
- [x] 2. Server: captures run with `--chunktime 5`; the file's path is known from the start, and capture queries work while it runs.
- [x] 3. Auto-record: a capture records its JVM if it isn't already, and puts it back afterwards unless you changed Record in the meantime; at the end, JFR's window is dumped beside the capture.
- [x] 4. Helper: capture queries combine the capture with JFR's profile of the same JVM and window (the live recording, else the dumped file): a summary (lanes, heatmap, GC), flame graphs by the rule above, and the union of kinds.
- [x] 5. Page: the capture view becomes the profile view, refreshing while the capture runs.
- [x] 6. Docs: docs/jvm-profiler.md and the README.

## Future work

- `--jfrsync` as an option, for one file holding both for JMC (and once it streams).
- Capture samples in Across JVMs.
