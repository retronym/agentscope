# Mods

Claude Code mods (plugins whose hooks module draws in the Claude app and hooks tool calls) that connect agentscope and `bgrun` to the sessions they watch.

agentscope shows what many parallel agent sessions are doing to one machine, but only on its own page; a session cannot see it, and neither can the person looking at that session. A review of six weeks of sessions found the same frictions again and again: benchmarks invalidated by sibling sessions loading the machine, long runs with no visible progress, and sessions started by other sessions overstepping (an upstream PR opened without sign-off, a branch rewritten under the session that owned it). Rules in `CLAUDE.md` state what to do; a mod can show the facts where the work happens and stand in the way of the known mistakes.

## agentscope

One mod, six parts. Each part has an option of its own (`/config`, or `pluginConfigs.agentscope.options` in `~/.claude/settings.json`), so one can be turned off without the others.

| Option | What it does | Why |
| --- | --- | --- |
| `jobsBand` | A band above the prompt lists this session's `bgrun` jobs: running ones with age, last line (or `--progress` line) and `silent 6m` when quiet for over two minutes; ended ones for 30 minutes; a job whose supervisor stopped writing as lost. A toast says once when a job ends. | A multi-hour build started by an agent is otherwise invisible: the only way to see it move is to ask. |
| `sessionPane` | `/agentscope` opens a pane beside the chat: the session's attributed cores and memory with its top processes, its JVMs, its `bgrun` jobs, its PRs with state and CI, who spawned it and what it spawned, and the other sessions using CPU now. A button per job shows the last 40 lines of its log. Asked every 10 s, only while the pane is shown. When agentscope is not reachable the pane says so and shows no numbers. Where no pane can be placed the command prints the same text. | The session's card in agentscope, without leaving the session. |
| `loadGate` | Before a Bash call that starts `perflab run`, `perflab ab` or JMH (`sbt …Jmh/run`, `java -jar …benchmarks.jar`), asks `python3 -m insights.wholoads --json --since 3` and refuses when other sessions used more than one core, naming them and their top process. `LOAD_GATE=off` on the command runs anyway; `LOAD_GATE=2.5` sets the limit in cores. If agentscope cannot be asked or has not sampled for three minutes, the command runs. | A timing run started while siblings compile measures them, not the change. perflab's own gate can only wait; it cannot say who to wait for. |
| `bgrunGuard` | Refuses `sbt partest`, `sbt scripted`, `sbt test` / `testAll` / `bootstrap` / `publishLocal`, `mvn verify` / `install` / `test` and anything matching `longCommands` (a regular expression) unless it runs under `bgrun`, and gives the wrapped command. `BGRUN=off` on the command runs it anyway. | `bgrun` is what gives a long run a state file; the band, the session card and `bgrun wait` all depend on it. |
| `spawnedGuard` | Only in a session another session started: refuses `gh pr create/comment/review/close/merge/edit/ready/reopen`, `gh issue create/comment/close/edit/reopen`, writing `gh api` calls and `git push` to a repository whose owner is not in `ownOwners`, and force-pushes (also deletes and `+refspec`) to a branch the session did not create. A `gh` write whose target cannot be determined is refused too. | Upstream is the user's call, and a worker does not rewrite what it did not create. |
| `handoffLine` | Only in a session another session started: at the end of a turn, appends `repo · branch · pushed? · PR · unverified: …` to `~/.claude/side-sessions/<date>-<branch>.md`, one line per change of state. | The coordinator and the user get the state of the branch from git and gh, not from the model's summary. "Unverified" lists only what those tools can see is unfinished: uncommitted files, unpushed commits, CI failing or running. |

### How the guards read a command

The guards judge the programs a command line starts, not its text. `hooks/shell.ts` splits the line into simple commands with quotes respected, then peels `VAR=value` words and wrappers (`time`, `nohup`, `env`, `timeout`, `bgrun … --`, `bash -c '…'`, and a `bgrun` whose one argument is a shell line). So `grep -rn "perflab run" docs/` and `echo sbt partest` trip nothing, and `bgrun --label ab 'cd bench && perflab run'` is still seen as a benchmark. It is not a shell: a command built by `eval`, a variable or a script file is not seen. The guards stand in the way of known mistakes; they are not a sandbox, and one that cannot judge (agentscope down, git failing) lets the command through.

### What "spawned" means

The desktop app keeps a record per session at `~/Library/Application Support/Claude/claude-code-sessions/<account>/<organization>/<local id>.json`, and a session started by another has `spawnedFrom` there. The mod finds the file through `CLAUDE_CODE_ACCOUNT_UUID`, `CLAUDE_CODE_ORGANIZATION_UUID` and `CLAUDE_CODE_HOST_SESSION_ID`. `CLAUDE_CODE_CHILD_SESSION` is set in every desktop session, so it is no signal. A session outside the desktop app has no record and is treated as started by the user.

A branch counts as created by the session when the app made it for the session's worktree (the record's `branch`, with a `worktreeName`), or when the oldest entry of the branch's reflog is not older than the session.

### Installing on another machine

Needs Claude Code 2.1.321 or later, this repository cloned, `bin/bgrun` on `PATH`, and for the pane and the load gate an agentscope running on port 8377.

1. Load the mod from the clone. Add to the `env` block of `~/.claude/settings.json`:

   ```json
   { "env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/code/agentscope/mods/agentscope" } }
   ```

   or, for one terminal session, `claude --plugin-dir ~/code/agentscope/mods/agentscope`.
2. Set your own GitHub owners, and any part you do not want, in the same file:

   ```json
   { "pluginConfigs": { "agentscope": { "options": { "ownOwners": "your-login, your-org", "loadGate": false } } } }
   ```

3. If the clone is not at `~/code/agentscope`, set `AGENTSCOPE_HOME` (the load gate runs `insights.wholoads` there). If agentscope listens elsewhere, set `AGENTSCOPE_URL`.

The band, the bgrun guard, the spawned-session guard and the handoff line need no agentscope server.

### Working on it

```bash
claude plugin validate mods/agentscope
```

```bash
claude plugin test mods/agentscope
```

```bash
python3 -m unittest discover -s mods/agentscope/tests
```

Once a session has loaded the mod, the engine lays its type declarations in `mods/agentscope/.claude-plugin/types/` (ignored by git) and `tsc -p mods/agentscope` type-checks it. Tests use made-up sessions and repositories only.

To check it against a live session, create `~/.cache/agentscope/mod-trace/`: the mod then writes what the band shows, each toast and the surfaces that drew it to `<session id>.json` there, and what the pane shows at load to `<session id>.pane.txt`.

Constraints the validator enforces, which shaped the layout: one hook per event and matcher in a module (hence the single `session.start` and the single Bash hook in `hooks/register.tsx`); a helper that takes `$` outside the entry file is a function declaration; a state atom is named in the file that reads it.
