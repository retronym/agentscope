# agentscope

One local page for keeping track of many concurrent Claude Code agent sessions, the PRs they produce, and the machine load they cause — when the app's own session list stops scaling.

## Why

With a dozen-plus sessions across several repos, three things get lost:

- **Right now:** which sessions are working, which are blocked on me, and which one is pinning 6 cores with a forked sbt.
- **Over time:** what happened in each repo this week, which session produced which PR, what spawned what.
- **Loose ends:** questions an agent asked that I never answered, follow-ups it proposed, PRs that went quiet when their session did.

## Views

- **Now** — live sessions (waiting/working first) with the agent's last status line, attributed CPU/RSS with sparkline, heavy child processes and PR chips (CI/review state). A machine strip splits total CPU into agents / Claude app / system / other.
- **Timeline** — one lane per repo (forks and upstream share a lane). Sessions are bars shaded by agent activity, dots mark your prompts, ◇/◆ mark PRs opened/merged on the owning session's row, dashed links show spawned-from, and a band shows the lane's CPU history.
- **Loose ends** — needs you; landable PRs; PRs in trouble; quiet sessions owning open PRs; proposals and offers never taken up; open PRs with no session; unarchived sessions idle for days.

Status chips (waiting for you · active · working · GitHub) filter all three views. Click any session for its last ask, the agent's last words, how it started, processes, family and a `claude --resume` command; **↗ Claude** opens it in the desktop app via `claude://code/continue?session=local_<id>` (unarchived desktop sessions only). Every PR and issue reference is a link.

## Load attribution

CPU is computed from cputime deltas between samples (every 5s), not `ps %cpu`. A process is credited to a session by, in order:

1. **ancestry** — it descends from the session's `claude` process (`~/.claude/sessions/<pid>.json` maps pid → session);
2. **cwd** — it runs in the session's worktree or scratchpad (scratchpad paths embed the session id);
3. **sticky** — it was credited earlier and has since daemonized (e.g. an sbt server reparented to launchd);
4. **mentioned** — it runs in an extra worktree that a session's own tool calls most recently referred to.

Per-minute history is kept in `~/.cache/agentscope/load-YYYYMMDD.jsonl`, so the timeline's load bands only cover time the server has been running.

## Data sources

All local and read-only, except GitHub:

- Desktop app session metadata (`~/Library/Application Support/Claude/claude-code-sessions`): titles, branches, archived flag, bound PRs, post-turn summaries, spawn links, proposal fates.
- `~/.claude/sessions/*.json`: live pid → session, busy/idle/waiting.
- `~/.claude/projects/**/*.jsonl` transcripts, incrementally indexed into `~/.cache/agentscope/`.
- `ps` / `lsof`.
- `gh api graphql`: your open PRs and those closed in the last 45 days.

## Run

macOS, Python 3.10+, an authenticated `gh`. No dependencies.

```
python3 agentscope.py            # http://localhost:8377
```

Site-specific system processes (antivirus, MDM agents) can be bucketed as "system / security" with `AGENTSCOPE_SYSTEM_HINTS="SomeAV:mdm-agent"` (colon-separated command-line substrings).

The data formats it reads are Claude Code internals, not a public API, and may change between releases.

## License

Apache 2.0
