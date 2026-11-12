# PLAN: insights

## Why

The main page shows now. Nothing showed what six weeks of sessions added up to: which lines of work they formed, what friction recurred, which ideas were said once and buried, what is one push from done, what exists only on this laptop. See README.md for the shape of the pipeline.

## Key decisions

- **Three passes, cheapest first.** Deterministic digests (2.7 GB to 4.5 MB), then one cheap reader agent per ~250 KB writing a card per session, then a few strong agents each synthesizing one part from a condensed view of all cards. Each pass can be redone without the one before.
- **Every claim carries a quote and a session id**, so the page can link back and a claim can be checked. A sample of synthesis claims was checked against GitHub: 6 of 7 held; one PR reported open was closed.
- **Derived data is never committed.** It quotes sessions and this repo is public. Code and the page are committed; data lives in `~/.cache/agentscope/insights/`, with a copy of the report and the standalone page in the ignored `insights/out/`.
- **The agents are driven by a Claude Code session, not by a script.** The briefs (CARD_PROMPT.md, SYNTH_PROMPT.md) sit beside the data.
- **Gap filling stays inside this repo and read-only elsewhere.** hygiene, upstream and wholoads only read; nothing here edits another repo, CLAUDE.md, settings or a scheduled task.

## Steps

- [x] 1. `extract.py`: digests and index from transcripts; `github.py`: PRs, issues, repos (paged by month: GitHub search stops at 1,000).
- [x] 2. Cards: 20 reader agents over 479 sessions.
- [x] 3. Synthesis: threads and lineage, patterns and friction, research ideas, lost ideas, last mile, loose ends, infra map and gaps.
- [x] 4. `build.py` and the page at `/insights`: timeline × mindmap, sections, infra map; a standalone HTML; `report.py` for markdown.
- [x] 5. Gaps filled: `hygiene.py` (work no remote has, scheduled tasks naming dead paths, disk), `upstream.py` (fork PR to upstream PR), `wholoads.py` (which session is loading the machine; exit status gates a timing run).
- [x] 6. Restart the launchd agentscope so `/insights` is served.

## Future work

- Loose-ends groups on the main page from hygiene.json: "Not on GitHub", "Scheduled runs failing".
- perflab's load gate calls `insights.wholoads --json` and names the session it is waiting for.
- `agentscope mine`: the caller's own processes, so cleanup never needs a pattern `pkill`.
- A disk-free sample in the machine strip, and the biggest growers over 24 h.
- upstream.py: match by patch-id, for fork PRs whose upstream twin was rewritten and renamed.
- Incremental runs: card only sessions newer than the last run, and re-synthesize.
- A script for passes 2 and 3 over the API, so a run does not need an interactive session.
