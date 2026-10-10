#!/usr/bin/env python3
"""Export a static, anonymized agentscope demo as one self-contained HTML file.

Takes a real snapshot (sessions, PRs, load and per-process history, threads) and keeps its *structure*: timings,
activity patterns, CPU/memory numbers, statuses, PR states, session families, process trees. Every piece of *text*
(titles, prompts, agent messages, branches, repo/owner names, PR titles, paths, command lines) is replaced by
generated stand-ins of the same shape: a paragraph becomes a paragraph of similar length, a table a table, a list a
list. Generation is deterministic (seeded by a hash of the original), so re-exports are stable.

The export aborts if any distinctive real string (GitHub login, home path, repo names, session/PR titles, branches)
survives into the output.

Usage: python3 demo/export.py [--out dist/index.html] [--days 7] [--items 100]
"""
import argparse, hashlib, json, os, random, re, secrets, sys, time, uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import agentscope as A  # noqa: E402

NS = uuid.UUID("8f9b3c1e-6a3d-4c55-9a8e-2f1d7c0b9e41")


def rng_for(*parts):
    return random.Random(int(hashlib.sha256("\x00".join(map(str, parts)).encode()).hexdigest()[:16], 16))


def new_id(x):
    return str(uuid.uuid5(NS, "agentscope-demo:" + str(x)))


# ---------------------------------------------------------------------------------------------
# Vocabulary: generic software-engineering stand-ins

LANES = ["atlas", "lumen", "corelang", "harbor", "quill", "orbit", "tiller", "beacon", "cinder", "drift", "ember", "fjord"]
ORGS = ["acme", "opencore", "toolsmiths", "northwind", "fabrikam", "initech", "umbrella-labs", "globex", "hooli", "vandelay",
        "stark-tools", "wonka-dev", "tyrell", "cyberdyne", "aperture", "soylent", "monarch", "oscorp"]
LIBS = ["kit", "protos", "schemas", "bench-tools", "core-utils", "fixtures", "docs-site", "cli", "codegen", "sdk", "infra", "ui-kit"]
LOGIN = "demo-dev"
PEOPLE = ["alex", "sam", "kai", "rin", "jo", "noa", "lee", "max"]
COMPONENTS = ["incremental cache", "dependency graph", "type checker", "parser recovery", "build pipeline", "CI matrix",
              "snapshot store", "query planner", "plugin loader", "classpath scanner", "test harness", "profiler hooks",
              "invalidation rules", "release tooling", "symbol index", "diff renderer", "config loader", "worker pool",
              "lock manager", "artifact cache", "schema migrator", "doc generator", "benchmark suite", "error reporter"]
VERBS = ["Fix", "Speed up", "Investigate", "Add", "Refactor", "Benchmark", "Document", "Prototype", "Harden", "Simplify",
         "Trace", "Stabilize", "Measure", "Review"]
SUFFIXES = ["", "", "", " for large projects", " on cold start", " under parallel builds", " across modules",
            " in the CLI", " after upgrades", " with stale inputs", " in CI"]
IDENTS = ["SnapshotStore", "invalidate()", "--incremental", "build.lock", "PlanCache", "resolveDeps", "WorkerPool",
          "stamp()", "--verify", "Indexer.run", "cache_key", "max_workers", "SymbolTable", "diffStats()", "LOG_LEVEL",
          "on_change", "BuildGraph", "retry_after", "ArtifactRef", "config.toml", "--profile", "TaskQueue", "hashInputs()"]
SENTENCES = [
    "The {comp} now keys entries on the full input set, so switching profiles no longer reuses stale results.",
    "I traced the slowdown to `{ident}`, which was called once per file instead of once per module.",
    "Both runs agree on {n} of {m} cases; the remaining ones differ only in ordering.",
    "That matches the earlier hypothesis about the {comp}, but I want one more data point before changing it.",
    "Tests pass locally ({n} total); CI is still running on the slower runners.",
    "I kept the public API unchanged and moved the new logic behind `{ident}`.",
    "The benchmark shows a {p}% improvement on the large fixture and no change on the small one.",
    "There is one open question: whether `{ident}` should be computed eagerly or on first use.",
    "Rebased onto main and resolved the conflict in the {comp}.",
    "The failure only reproduces with a cold cache, which explains why it was intermittent.",
    "I added a regression test that fails before the fix and passes after it.",
    "Memory stays flat at about {g} GB across {n} iterations, so the leak is gone.",
    "The {comp} change is small, but it touches every caller of `{ident}`, so I split it into two commits.",
    "Next, I'll wire the {comp} into the CLI and update the docs.",
    "Profiling points at lock contention in the {comp} rather than at I/O.",
    "I reverted the experiment; it made the common case slower by {p}%.",
    "The draft PR is up with a summary of the trade-offs and the numbers above.",
    "Nothing in the logs suggests a configuration problem; the inputs are genuinely different.",
    "With `{ident}` set, the run completes in {n} seconds instead of {m}.",
    "I compared the outputs byte for byte and they are identical.",
    "The warning comes from the {comp}, not from the code under test.",
    "This is ready for review; the only behaviour change is in how `{ident}` handles empty input.",
]
USER_LINES = [
    "Can you look into why the {comp} is slow on large projects?", "Ship it.", "Let's add a test for that first.",
    "STOP. Don't change the public API.", "What's left before we can merge?", "Agree. Go ahead.",
    "Rebase on main and push.", "Why is CI red?", "Try it with `{ident}` turned off.", "Write up the findings in the PR description.",
    "Can we measure that before changing anything?", "Keep the commits small, one step each.",
    "Compare against the baseline run.", "Does this affect the {comp}?", "Let's park that as future work.",
    "Summarize where we are for a busy reader.", "Is the benchmark noise or a real regression?",
]
STATUS = ["pushed a fixup to #{n}; {m} tests pass", "benchmark finished: {p}% faster on the large fixture",
          "draft PR #{n} opened, CI running", "waiting on CI for #{n}", "rebased onto main, no conflicts",
          "regression test added; root cause in the {comp}", "measurements collected, write-up in progress",
          "merged #{n}; follow-up noted for the {comp}"]
NEEDS = ["Approve the {comp} migration plan?", "Which option should I take for the {comp}?", "OK to push to main?",
         "Merge #{n} now or wait for review?", "Should I split this into two PRs?"]
TOOL_DETAILS = ["Run the test suite", "Read the module source", "Rebuild and run benchmarks", "Check CI status",
                "Search for call sites", "Apply the patch", "Show the diff", "Start the dev server", "Inspect the logs",
                "Commit and push", "Compare outputs", "List changed files"]
KNOWN_TOOLS = {"Bash", "Read", "Edit", "Write", "Grep", "Glob", "Agent", "WebFetch", "WebSearch", "Monitor", "Skill",
               "ToolSearch", "TaskStop", "NotebookEdit"}
KEEP_PROC_LABELS = {"claude (agent)", "sbt", "sbt server (java)", "sbt forked test JVM", "bash", "zsh", "sh", "git", "gh",
                    "ps", "sleep", "java", "make", "cargo", "npm", "timeout", "tail", "cat"}
LANGS = ["python", "go", "rust", "bash", "ts"]


def fill(tpl, r):
    return tpl.format(comp=r.choice(COMPONENTS), ident=r.choice(IDENTS), n=r.randint(3, 400), m=r.randint(400, 900),
                      p=r.randint(3, 45), g=round(r.uniform(0.4, 6), 1))


def words_of(n, r, user=False):
    out, count = [], 0
    bank = list(USER_LINES if user else SENTENCES)
    r.shuffle(bank)  # draw without replacement so a paragraph never repeats itself
    while count < max(4, n):
        if not bank:
            bank = list(SENTENCES)
            r.shuffle(bank)
        sent = fill(bank.pop(), r)
        out.append(sent)
        count += len(sent.split())
        if user and r.random() < 0.6:
            break
    return " ".join(out)


# ---------------------------------------------------------------------------------------------
# Text synthesis: same block structure, same rough size, none of the words

def synth_text(orig, role="assistant", cap=1600):
    if not orig:
        return orig
    r = rng_for("text", orig)
    blocks, out = re.split(r"\n\s*\n", orig.strip()), []
    for b in blocks:
        lines = b.splitlines()
        first = lines[0].lstrip() if lines else ""
        if first.startswith("```"):
            body = [ln for ln in lines[1:] if not ln.startswith("```")]
            lang = r.choice(LANGS)
            code = [f"{r.choice(['let', 'val', 'def', 'fn', 'const'])} {r.choice(IDENTS).strip('()-.').lower()}_{i} = {r.randint(0, 99)}"
                    for i in range(min(max(1, len(body)), 8))]
            out.append(f"```{lang}\n" + "\n".join(code) + "\n```")
        elif sum(ln.lstrip().startswith("|") for ln in lines) >= 2:
            cols = max(2, min(4, lines[0].count("|") - 1))
            rows = min(max(1, len(lines) - 2), 6)
            head = "| " + " | ".join(r.choice(["Step", "Case", "Result", "Time", "Notes", "Owner", "Status"]) + ("" if i == 0 else f" {i}") for i in range(cols)) + " |"
            sep = "|" + "|".join(["---"] * cols) + "|"
            body = ["| " + " | ".join(fill(r.choice(["{comp}", "`{ident}`", "{n} ms", "{p}%", "ok", "pending"]), r) for _ in range(cols)) + " |" for _ in range(rows)]
            out.append("\n".join([head, sep] + body))
        elif all(re.match(r"\s*([-*+]|\d+\.)\s", ln) for ln in lines if ln.strip()) and lines:
            ordered = bool(re.match(r"\s*\d+\.", first))
            bold = "**" in b
            items = []
            for i, _ in enumerate(lines[:6]):
                lead = f"**{r.choice(VERBS)}:** " if bold else ""
                items.append(f"{i + 1 if ordered else '-'}{'.' if ordered else ''} {lead}{fill(r.choice(SENTENCES), r)}")
            out.append("\n".join(items))
        elif first.startswith("#"):
            level = len(first) - len(first.lstrip("#"))
            out.append("#" * min(level, 4) + " " + f"{r.choice(VERBS)} the {r.choice(COMPONENTS)}")
        elif first.startswith(">"):
            out.append("> " + fill(r.choice(SENTENCES), r))
        else:
            out.append(words_of(min(len(b.split()), 110), r, user=(role == "user")))
        if sum(map(len, out)) > cap:
            break
    return "\n\n".join(out)


def synth_line(orig, bank, salt):
    return fill(rng_for(salt, orig).choice(bank), rng_for(salt + "2", orig)) if orig else orig


def synth_title(orig):
    r = rng_for("title", orig)
    return f"{r.choice(VERBS)} {r.choice(COMPONENTS)}{r.choice(SUFFIXES)}"


def slug(t):
    return re.sub(r"[^a-z0-9]+", "-", t.lower()).strip("-")[:40]


# ---------------------------------------------------------------------------------------------
# Name maps (lanes, repos, PR numbers, branches, paths)

class Names:
    def __init__(self, state):
        lanes = sorted({s["lane"] for s in state["sessions"]} | {p["lane"] for p in state["prs"]},
                       key=lambda l: -max([s["last"] or 0 for s in state["sessions"] if s["lane"] == l] or [0]))
        fake = iter(LANES)
        self.lane = {l: (l if l == "scratch" else next(fake, f"project-{i}")) for i, l in enumerate(lanes)}
        self.login = state.get("gh_login")
        self.owner, self.repo, self.prnum, self.branch = {}, {}, {}, {}
        orgs = iter(ORGS)
        owners = sorted({k.split("/")[0] for k in self._all_repos(state)})
        for o in owners:
            self.owner[o] = LOGIN if o == self.login else next(orgs, f"org{len(self.owner)}")

    @staticmethod
    def _all_repos(state):
        repos = {p["repo"] for p in state["prs"]}
        for s in state["sessions"]:
            for k in list(s.get("pr_mentions", {})) + list(s.get("issues", {})):
                repos.add(k.split("#")[0])
            if s.get("repo"):
                repos.add(s["repo"])
        return {r for r in repos if "/" in r}

    def map_lane(self, l):
        if l not in self.lane:
            self.lane[l] = LANES[len(self.lane) % len(LANES)] + f"-{len(self.lane)}"
        return self.lane[l]

    def map_repo(self, repo):
        if not repo or "/" not in repo:
            return None
        if repo not in self.repo:
            o, n = repo.split("/", 1)
            owner = self.owner.setdefault(o, ORGS[len(self.owner) % len(ORGS)] + str(len(self.owner)))
            self.repo[repo] = f"{owner}/{self.map_lane(n) if n in self.lane else rng_for('lib', repo).choice(LIBS)}"
        return self.repo[repo]

    def map_num(self, repo, n):
        key = (repo, int(n))
        if key not in self.prnum:
            r = rng_for("num", repo)
            base = r.randint(10, 300)
            self.prnum[key] = base + sum(1 for k in self.prnum if k[0] == repo) * r.randint(1, 4)
        return self.prnum[key]

    def map_key(self, key):
        repo, n = key.split("#")
        return f"{self.map_repo(repo)}#{self.map_num(repo, n)}"

    def map_branch(self, b):
        if not b:
            return b
        if b in ("main", "master", "develop", "HEAD") or re.fullmatch(r"\d+\.(x|\d+)(\.x)?", b):
            return b
        if b not in self.branch:
            self.branch[b] = rng_for("br", b).choice(["feature/", "fix/", "exp/", "claude/"]) + slug(synth_title(b))
        return self.branch[b]

    def map_path(self, p, lane=None):
        if not p:
            return p
        if "scratch-workspaces" in p:
            return "/home/demo/scratch/" + new_id(p)[:8]
        name = slug(synth_title(p)).split("-", 1)[-1]
        return f"/home/demo/code/{self.map_lane(lane) if lane else 'misc'}" + (f"/.worktrees/{name}" if ".worktrees" in p else "")


JVM_LABELS = {label for _, label in A.jvm.KNOWN} - {"JetBrains Toolbox", "Coursier"}  # tool and vendor names can be real repo or owner names


def map_jvm_label(label):
    return label if label in JVM_LABELS else rng_for("jvm", label).choice(["app server", "BenchRunner", "Indexer", "Worker"])


def map_proc_label(label):
    if label in KEEP_PROC_LABELS:
        return label
    r = rng_for("proc", label)
    if label.startswith("java"):
        return "java " + r.choice(["Main", "BenchRunner", "TestRunner", "Worker", "Indexer"])
    if label.startswith("node"):
        return "node server"
    if label.lower().startswith("python"):
        return "python worker"
    return r.choice(["worker", "indexer", "language-server", "compiler-daemon", "watcher"])


# ---------------------------------------------------------------------------------------------
# Snapshot -> anonymized data

def snapshot(days, n_items):
    A.db_init()
    A.refresh_index()
    sampler = A.Sampler()
    for r in A.load_history(time.time() - sampler.hist.maxlen * sampler.period):
        sampler.hist.append((r["t"], {k: v for k, v in r["s"].items() if not k.startswith("@")},
                             {k[1:]: v for k, v in r["s"].items() if k.startswith("@")}))
    for _ in range(2):  # the first sample only primes CPU deltas, the second primes the JVMs' counter deltas
        sampler.sample(A.meta_cached())
        time.sleep(3)
    sampler.sample(A.meta_cached())
    print("fetching PRs from GitHub…", file=sys.stderr)
    A._gh.update(t=time.time(), prs=A.fetch_prs(), login=A.run(["gh", "api", "user", "-q", ".login"]).strip() or None)
    state = A.build_state(sampler)
    since = state["now"] - days * 86400
    keep = [s for s in state["sessions"] if s["live"] or (s["last"] or 0) >= since]
    threads, procs = {}, {}
    for s in keep:
        th = A.read_thread(s["sid"], n_items)
        if th:
            threads[s["sid"]] = th["items"]
        procs[s["sid"]] = A.session_procs(s["sid"], since)
    state["sessions"] = keep
    state["jvm_hist"] = {j["id"]: A.jvm.history(A.db, j["id"], state["now"] - 3 * 3600) for j in state["jvms"]}
    return state, A.load_history(state["now"] - 30 * 86400), threads, procs


def anonymize(state, load, threads, procs):
    N = Names(state)
    sid_map = {s["sid"]: new_id(s["sid"]) for s in state["sessions"]}
    sid = lambda x: sid_map.get(x) or (new_id(x) if x else x)  # noqa: E731

    def tmap(text, role="assistant"):
        return synth_text(text, role)

    def map_procrow(p, lane):
        q = dict(p, label=map_proc_label(p["label"]), args=None, cwd=N.map_path(p.get("cwd"), lane) if p.get("cwd") else None)
        q["args"] = q["label"]
        return q

    acct = {a: f"claude-{['personal', 'work', 'oss', 'client'][i % 4]}" if i else "claude" for i, a in enumerate(state.get("claude_dirs") or [])}
    out_sessions = []
    for s in state["sessions"]:
        lane = s["lane"]
        t = dict(s)
        t.update(
            sid=sid(s["sid"]), local="local_" + new_id("local" + s["sid"]) if s.get("local") else None,
            title=synth_title(s["title"]), lane=N.map_lane(lane), account=acct.get(s.get("account")), repo=N.map_repo(s.get("repo")),
            cwd=N.map_path(s.get("cwd"), lane), branch=N.map_branch(s.get("branch")), branches=[N.map_branch(b) for b in s.get("branches") or []],
            first_prompt=tmap(s.get("first_prompt"), "user"), last_prompt=tmap(s.get("last_prompt"), "user"),
            last_text=tmap(s.get("last_text")), report=synth_line(s.get("report"), STATUS, "report"),
            summary=dict(s["summary"], status_detail=synth_line(s["summary"].get("status_detail"), STATUS, "status"),
                         needs_action=synth_line(s["summary"].get("needs_action"), NEEDS, "needs"), summarizes_uuid=None) if s.get("summary") else None,
            spawned_from=sid(s.get("spawned_from")) if s.get("spawned_from") else None,
            meta_prs=[], artifacts=[], prs=[N.map_key(k) for k in s.get("prs", [])],
            pr_mentions={N.map_key(k): v for k, v in (s.get("pr_mentions") or {}).items()},
            issues={N.map_key(k): v for k, v in (s.get("issues") or {}).items()},
            proposals=[dict(p, title=synth_title(p.get("title") or ""), prompt=tmap(p.get("prompt"), "user"),
                            task_id="task_" + new_id(p.get("task_id"))[:8] if p.get("task_id") else None) for p in s.get("proposals", [])],
            resolved={"task_" + new_id(k)[:8]: v for k, v in (s.get("resolved") or {}).items()},
            live=dict(s["live"], name=synth_title(s["title"])) if s.get("live") else None,
            load=dict(s["load"], procs=[map_procrow(p, lane) for p in s["load"]["procs"]]) if s.get("load") else None,
        )
        out_sessions.append(t)

    out_prs = []
    for p in state["prs"]:
        q = dict(p)
        repo = N.map_repo(p["repo"])
        q.update(key=N.map_key(p["key"]), repo=repo, lane=N.map_lane(p["lane"]), number=N.map_num(p["repo"], p["number"]),
                 title=synth_title(p.get("title") or p["key"]), url="#", head=N.map_branch(p.get("head")), base=N.map_branch(p.get("base")),
                 reviewers=[rng_for("who", x).choice(PEOPLE) for x in p.get("reviewers") or []],
                 sessions=[sid(x) for x in p.get("sessions") or []])
        out_prs.append(q)

    st = dict(state)
    st.update(
        sessions=out_sessions, prs=out_prs, gh_login=LOGIN, gh_err=None, ui=0, claude_dirs=list(acct.values()),
        proposals=[dict(p, sid=sid(p["sid"]), lane=N.map_lane(p["lane"]), title=synth_title(p.get("title") or ""),
                        prompt=tmap(p.get("prompt"), "user"), task_id="task_" + new_id(p.get("task_id"))[:8] if p.get("task_id") else None)
                   for p in state["proposals"]],
        orphans=[dict(o, label=map_proc_label(o["label"]), args=map_proc_label(o["label"]), cwd=None) for o in state["orphans"]],
        jvms=[dict(j, sid=sid(j["sid"]) if j.get("sid") else None, label=map_jvm_label(j["label"]), main=map_jvm_label(j["label"]), args="", vendor="")
              for j in state["jvms"] if j["label"] != "agentscope helper"],  # our own helper: its name is a real repo
        jvm_hist=None,
        machine_hist=[[t, b, [[sid(x), c] for x, c in top]] for t, b, top in state["machine_hist"]],
    )
    out_load = [dict(t=r["t"], s={(k if k.startswith("@") else sid(k)): v for k, v in r["s"].items()}) for r in load]
    lane_of = {s["sid"]: s["lane"] for s in state["sessions"]}
    out_threads = {}
    for k, items in threads.items():
        res = []
        for i, it in enumerate(items):
            it = dict(it, idx=i)
            if it["role"] == "tools":
                it["calls"] = [[c[0] if c[0] in KNOWN_TOOLS else "Tool", rng_for("tool", c[1]).choice(TOOL_DETAILS) if c[1] else ""] for c in it["calls"]]
            else:
                it["text"] = tmap(it["text"], it["role"])
            res.append(it)
        out_threads[sid(k)] = res
    out_procs = {sid(k): [map_procrow(p, lane_of.get(k)) for p in v] for k, v in procs.items()}
    return st, out_load, out_threads, out_procs, N


# ---------------------------------------------------------------------------------------------
# Time shift: hide when the work happened, keep durations, gaps and ordering

TIME_KEYS = {"now", "gh_t", "start", "first", "last", "last_prompt_t", "t", "t1", "created", "updated", "merged", "closed", "last_commit"}


def random_shift():
    """Back by 20-60 days and 3-20 hours, a multiple of the 5-minute activity bucket; drawn per export, never stored."""
    days = 20 + secrets.randbelow(41)
    minutes = 180 + secrets.randbelow(1021)
    return -(days * 86400 + minutes // 5 * 300)


def shift_times(x, off, key=None):
    if isinstance(x, dict):
        out = {}
        for k, v in x.items():
            if k == "act" and isinstance(v, dict):  # activity buckets keyed by epoch // 300
                out[k] = {str(int(b) + off // 300): c for b, c in v.items()}
            elif k in ("spark", "series", "machine_hist") and isinstance(v, list):  # [[t, ...], ...]
                out[k] = [[r[0] + off] + [shift_times(y, off) for y in r[1:]] for r in v]
            elif k in TIME_KEYS and isinstance(v, (int, float)) and v > 1e9:
                out[k] = v + off
            else:
                out[k] = shift_times(v, off, k)
        return out
    if isinstance(x, list):
        return [shift_times(v, off) for v in x]
    return x


def check_shifted(obj, real_now):
    """No epoch-looking number within a day of the real snapshot time may remain."""
    bad = []

    def walk(x, path):
        if isinstance(x, dict):
            for k, v in x.items():
                walk(v, path + [k])
        elif isinstance(x, list):
            for v in x:
                walk(v, path)
        elif isinstance(x, (int, float)) and not isinstance(x, bool) and abs(x - real_now) < 86400:
            bad.append("/".join(map(str, path[-3:])))
    walk(obj, [])
    return bad


# ---------------------------------------------------------------------------------------------
# Leak check

def denylist(state, threads, N):
    home = os.path.expanduser("~")
    deny = {home, os.path.basename(home)}
    if N.login:
        deny.add(N.login)
    generic = {"scratch", "talks", "code", "main", "develop", "master"}
    for l in N.lane:
        if l not in generic and len(l) >= 4:
            deny.add(l)
    for repo in N.repo:
        o, n = repo.split("/", 1)
        deny |= {repo}
        if len(o) >= 4 and o not in generic:
            deny.add(o)
        if len(n) >= 4 and n not in generic:
            deny.add(n)
    for s in state["sessions"]:
        if len(s["title"]) >= 12:
            deny.add(s["title"])
        for b in s.get("branches") or []:
            if len(b) >= 8 and b not in generic:
                deny.add(b)
    for p in state["prs"]:
        if len(p.get("title") or "") >= 12:
            deny.add(p["title"])
    return {d for d in deny if d}


def strings(x):
    """Every string value in a JSON-able structure (keys are ours, not user data)."""
    if isinstance(x, str):
        yield x
    elif isinstance(x, dict):
        for v in x.values():
            yield from strings(v)
    elif isinstance(x, (list, tuple)):
        for v in x:
            yield from strings(v)


def check(obj, deny):
    low = "\n".join(strings(obj)).lower()
    hits = sorted(d for d in deny if re.search(r"(?<![a-z0-9])" + re.escape(d.lower()) + r"(?![a-z0-9])", low))
    return hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "dist", "index.html"))
    ap.add_argument("--days", type=int, default=7, help="sessions active within this many days")
    ap.add_argument("--items", type=int, default=100, help="thread items per session")
    a = ap.parse_args()
    state, load, threads, procs = snapshot(a.days, a.items)
    st, ld, th, pr, N = anonymize(state, load, threads, procs)
    jh = {str(k): {"series": v} for k, v in state["jvm_hist"].items()}
    obj = shift_times(dict(state=st, load=ld, threads=th, procs=pr, jvm_hist=jh), random_shift())
    unshifted = check_shifted(obj, state["now"])
    if unshifted:
        sys.exit(f"refusing to write: {len(unshifted)} timestamps were not shifted, e.g. {sorted(set(unshifted))[:8]}")
    data = json.dumps(obj, separators=(",", ":"))
    leaks = check(obj, denylist(state, threads, N))
    if leaks:
        sys.exit(f"refusing to write: {len(leaks)} real strings survived anonymization, e.g. {leaks[:8]}")
    page = open(os.path.join(ROOT, "index.html")).read()
    for f in A.STATIC:  # one self-contained file: inline the page's own scripts and styles
        src = open(os.path.join(ROOT, f)).read()
        tag = f'<script src="{f}"></script>' if f.endswith(".js") else f'<link rel="stylesheet" href="{f}">'
        assert tag in page, tag
        page = page.replace(tag, f"<script>\n{src}</script>" if f.endswith(".js") else f"<style>\n{src}</style>")
    inject = "<script>window.STATIC_DATA = " + data.replace("</", "<\\/") + ";</script>\n"
    page = page.replace("<title>agentscope</title>", "<title>agentscope demo</title>").replace("</head>", inject + "</head>", 1)
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    open(a.out, "w").write(page)
    print(f"wrote {a.out}: {len(st['sessions'])} sessions, {len(st['prs'])} PRs, {sum(map(len, th.values()))} thread items, "
          f"{len(page) / 1e6:.1f} MB; leak check passed, timestamps shifted", file=sys.stderr)


if __name__ == "__main__":
    main()
