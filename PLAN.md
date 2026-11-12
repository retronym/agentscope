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

# PLAN: a disk that doesn't fill unnoticed

## Why

Agents fill the disk: worktrees, build and benchmark output, profiler traces, dependency caches, scratchpads. At ENOSPC no session on the machine can run a shell command, and by then finding what to delete is manual. Nothing watched free space or said what grew.

## Key decisions

- **Free space is cheap, so sample it like everything else:** one `statvfs` a minute into `disk_minute`. The page shows it in the machine strip with a week's trend and the day's change, amber then red as it gets low.
- **What grew is a difference of two `du` samples of a fixed set of directories**, not a walk of the disk: worktrees, perflab output directories, dependency caches, session scratchpads. Those are where an agent's bytes go, and each has an owner to name.
- **`du` never runs for a request.** One pass every 45 minutes in its own thread, a directory at a time, under `nice` and macOS's background band (`taskpolicy -b`), so it doesn't show up in a benchmark. A pass is stored in one transaction; the page reads the last complete one.
- **A row per change, not per pass.** Most worktrees don't change between passes, so `disk_du` only gets a row when a size differs. A directory created inside the window counts in full.
- **Growers appear only when it matters:** below the threshold (40 GB) Loose ends gets a group, each directory with the session that last touched it (its cwd, its worktree, or the last to name the path; a scratchpad's is in its path).
- **In its own module** (`disk.py`, `static/disk.js`), like the JVM table.

## Steps

- [x] 1. Free space per minute, kept 30 days.
- [x] 2. Machine strip: free space, trend, colour.
- [x] 3. Background `du` passes, growth over 24 h, sessions attributed.
- [x] 4. Loose ends group below the threshold; `/api/state`; the demo export carries no disk data and the page draws nothing without it.
- [x] 5. README.

## Future work

- An archive tier: move a finished session's worktree or a campaign's output off the disk and restore it on demand.
- Deleting from the page: remove a worktree whose session is archived and whose branch is merged or pushed.
- Sizes that know about APFS clones: `du` counts a `cp -c` copy in full, so a cloned workspace looks bigger than what deleting it frees.
- Other growers seen here but not measured: xctrace/ktrace traces and collapsed-stack files written outside a worktree or scratchpad.
- A notification before the page is open: a desktop alert when free space crosses the threshold.
