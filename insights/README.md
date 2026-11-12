# insights: a retrospective over weeks of sessions

agentscope's main page answers "what is happening now". This answers "what happened, and what fell on the floor": which lines of work the sessions formed, what recurring friction cost, which ideas were voiced once and buried by the next prompt, what is one push from shipping, and what is dangling.

Open `http://localhost:8377/insights` once the data is built.

## Why it's shaped this way

A transcript is mostly tool output. Six weeks of sessions here was 2.7 GB, far more than any model can read, and almost none of it says how a session went. What does is small: what you typed, what the agent said at the end of each turn, what it asked or proposed, and where it was stopped, corrected or denied. So the pipeline is three passes, each cheaper to redo than the one before:

1. **Extract** (deterministic, seconds). `extract.py` reduces each transcript to a digest of a few KB and an index row; `github.py` collects the PRs, issues and repos of the same period. 2.7 GB became 4.5 MB.
2. **Read** (cheap model, parallel). One agent per ~250 KB of digests reads every digest in full and writes a card per session: goal, outcome, status, ideas and whether they were pursued, friction with a verbatim quote, last mile, loose ends, infra touched. The brief is `CARD_PROMPT.md` in the data directory. Cards carry quotes so a claim can be traced.
3. **Synthesize** (strong model, few agents). Each gets one condensed view of all the cards (threads, ideas, friction, ends, infra) and writes one part: the themes and threads with their lineage, patterns and friction, research ideas, lost ideas, last mile, loose ends, the infra map and its gaps.

`build.py` joins all of it into `insights.json`, which the page reads, and a self-contained `insights-standalone.html`.

The reading and synthesis passes are run by a Claude Code session, not by these scripts: start one in this repo and ask it to redo the retrospective for a date range.

## The page

- **Timeline × mindmap.** Time runs left to right. Themes fan out into threads; a thread is a ribbon whose thickness is the agent-active time that day, so the effort reads as a flow. Dashed curves join a thread to the one it grew out of. Diamonds are PRs. Clicking a ribbon opens its sessions, PRs, ideas (unpursued first), last mile and loose ends, each session with a link back into the Claude app.
- **Patterns, Friction points, Research ideas, Lost ideas, Last mile needed, Loose ends.** Ranked cards, each with evidence quotes that link to the session they came from.
- **Dev infra map.** What was built or leaned on, by layer, with a gap analysis: dashed red is a hole, green one that has since been filled (`gaps_filled.json`).

## Data and privacy

Everything derived lives in `~/.cache/agentscope/insights/` and none of it is committed: digests, cards and the built JSON quote your sessions. Only `gh` queries leave the machine, apart from what the reading agents send to the model you run them on.

```
python3 -m insights.extract --since 2026-10-01     # digests/ and index.json
python3 -m insights.github  --since 2026-10-01     # github.json
python3 -m insights.build                          # insights.json, insights-standalone.html
```
