#!/usr/bin/env python3
"""Reduce Claude Code transcripts to digests small enough to read in bulk.

A transcript is mostly tool output. What says how a session went is much smaller: what the human typed, what the
agent said at the end of each turn, what it asked and proposed, and where it was stopped, corrected or denied.
This keeps those, with counts for the rest, and writes one markdown digest per session plus an index.

    python3 -m insights.extract --since 2026-10-01
"""
import argparse
import collections
import glob
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import agentscope as A  # noqa: E402

OUT = os.path.join(A.CACHE, "insights")
PROMPT_CAP, REPLY_CAP, DIGEST_CAP = 2500, 1400, 22000
CORRECTION = re.compile(r"^\s*(stop\b|no[,.! ]|nope|don'?t\b|wrong|that'?s not|why did you|i said|i told you|i had to stop|"
                        r"never\b|wait[,. ]|revert|undo\b|not what i)", re.I)
INTERRUPT = "[Request interrupted"
DENIED = ("The user doesn't want to proceed", "user denied", "Permission to use", "was rejected")


def clip(s, n):
    s = s.strip()
    return s if len(s) <= n else s[: n * 2 // 3] + f"\n[… {len(s) - n} chars cut …]\n" + s[-n // 3:]


def digest(path, since, meta):
    sid = os.path.splitext(os.path.basename(path))[0]
    d = dict(sid=sid, path=path, cwd=None, title=None, first=None, last=None, prompts=0, turns=0, interrupts=0, corrections=0,
             denials=0, tool_errors=0, compactions=0, api_errors=0, out_tokens=0, cost=None, models=collections.Counter(),
             tools=collections.Counter(), branches=collections.Counter(), prs=collections.Counter(), issues=collections.Counter(),
             buckets=set(), spawned=[], skills=collections.Counter())
    events = []       # (t, kind, text)
    reply = None      # the agent's last text since the last human prompt
    for line in open(path, errors="replace"):
        try:
            r = json.loads(line)
        except ValueError:
            continue
        typ = r.get("type")
        if typ == "custom-title":
            d["title"] = r.get("customTitle")
        elif typ == "agent-name" and not d["title"]:
            d["title"] = r.get("agentName")
        elif typ == "cost-state":
            d["cost"] = r.get("totalCostUSD")
        elif typ == "pr-link" and r.get("prUrl"):
            for repo, n in A.PR_URL.findall(r["prUrl"]):
                d["prs"][f"{repo}#{n}"] += 5
        if r.get("cwd") and not d["cwd"]:
            d["cwd"] = r["cwd"]
        if r.get("gitBranch") and r["gitBranch"] != "HEAD":
            d["branches"][r["gitBranch"]] += 1
        t = A.iso_to_epoch(r.get("timestamp"))
        if t is None or typ not in ("user", "assistant", "system") or r.get("isSidechain"):
            continue
        if typ == "system":
            if r.get("subtype") == "compact_boundary":
                d["compactions"] += 1
            continue
        d["first"] = t if d["first"] is None else min(d["first"], t)
        d["last"] = t if d["last"] is None else max(d["last"], t)
        d["buckets"].add(int(t // A.BUCKET))
        msg = r.get("message") or {}
        content = msg.get("content")
        if typ == "assistant":
            if r.get("isApiErrorMessage"):
                d["api_errors"] += 1
                continue
            if msg.get("model"):
                d["models"][msg["model"]] += 1
            d["out_tokens"] += (msg.get("usage") or {}).get("output_tokens") or 0
            for blk in content or []:
                if not isinstance(blk, dict):
                    continue
                if blk.get("type") == "text" and blk.get("text", "").strip():
                    reply = (t, blk["text"])
                    for repo, n in A.PR_URL.findall(blk["text"]):
                        d["prs"][f"{repo}#{n}"] += 1
                    for repo, n in A.ISSUE_URL.findall(blk["text"]):
                        d["issues"][f"{repo}#{n}"] += 1
                elif blk.get("type") == "tool_use":
                    name, inp = blk.get("name", "?"), blk.get("input") or {}
                    short = name.replace("mcp__", "").split("__")[-1]
                    d["tools"][short] += 1
                    if short == "wrap_up":
                        events.append((t, "recap", (inp.get("recap") or "") + (f"\nASK: {inp['ask']}" if inp.get("ask") else "")))
                    elif short == "AskUserQuestion":
                        qs = "; ".join(q.get("question", "") for q in inp.get("questions") or [])
                        events.append((t, "agent-question", qs))
                    elif short == "start_session":
                        d["spawned"].append(inp.get("title"))
                        events.append((t, "session-proposal", f"[{inp.get('initiation')}] {inp.get('title')}: {clip(inp.get('prompt') or '', 500)}"))
                    elif short == "Skill":
                        d["skills"][inp.get("skill", "?")] += 1
                    elif short in ("Agent", "Task"):
                        events.append((t, "subagent", f"{inp.get('subagent_type') or 'agent'}/{inp.get('model') or '-'}: {inp.get('description')}"))
                    elif short == "ExitPlanMode":
                        events.append((t, "plan", clip(inp.get("plan") or "", 1800)))
            continue
        # user records
        text = A._text_of(content).strip()
        if isinstance(content, list):
            for blk in content:
                if isinstance(blk, dict) and blk.get("type") == "tool_result":
                    body = json.dumps(blk.get("content"))[:600]
                    if any(k in body for k in DENIED):
                        d["denials"] += 1
                    elif blk.get("is_error"):
                        d["tool_errors"] += 1
        if text.startswith(INTERRUPT):
            d["interrupts"] += 1
            events.append((t, "interrupt", "user interrupted the agent"))
            continue
        if "session is being continued from a previous conversation" in text[:200]:
            d["compactions"] += 1
            continue
        hp = A._is_human_prompt(r)
        if not hp:
            continue
        if reply:
            events.append((reply[0], "agent", clip(reply[1], REPLY_CAP)))
            reply = None
            d["turns"] += 1
        d["prompts"] += 1
        kind = "human"
        if CORRECTION.search(hp):
            d["corrections"] += 1
            kind = "human-correction"
        for repo, n in A.PR_URL.findall(hp):
            d["prs"][f"{repo}#{n}"] += 1
        events.append((t, kind, clip(hp, PROMPT_CAP)))
    if reply:
        events.append((reply[0], "agent-final", clip(reply[1], REPLY_CAP * 2)))
    if d["last"] is None or d["last"] < since or not d["prompts"]:
        return None, None
    events = [e for e in sorted(events, key=lambda e: e[0])]
    m = meta.get(sid) or {}
    d["title"] = m.get("title") or d["title"]
    d["lane"] = A.lane_of(d["cwd"], m.get("originCwd"))
    d["active_min"] = len(d["buckets"]) * A.BUCKET // 60
    d["subagents"] = len(glob.glob(os.path.join(os.path.dirname(path), sid, "subagents", "*.jsonl")))
    for p in m.get("prs") or []:
        u = p.get("url") if isinstance(p, dict) else p
        for repo, n in A.PR_URL.findall(u or ""):
            d["prs"][f"{repo}#{n}"] += 5
    day = lambda t: time.strftime("%m-%d %H:%M", time.localtime(t))
    head = [f"# {d['title'] or '(untitled)'}",
            f"sid: {sid}", f"lane: {d['lane']}   cwd: {d['cwd']}",
            f"when: {day(d['first'])} → {day(d['last'])}   active≈{d['active_min']}min   prompts={d['prompts']}",
            f"branches: {', '.join(b for b, _ in d['branches'].most_common(3)) or '-'}",
            f"prs: {', '.join(k for k, _ in d['prs'].most_common(8)) or '-'}   issues: {', '.join(k for k, _ in d['issues'].most_common(5)) or '-'}",
            f"friction: interrupts={d['interrupts']} corrections={d['corrections']} denials={d['denials']} tool_errors={d['tool_errors']} "
            f"compactions={d['compactions']} api_errors={d['api_errors']}",
            f"tools: {', '.join(f'{k}×{v}' for k, v in d['tools'].most_common(10))}   subagents={d['subagents']}   "
            f"skills: {', '.join(d['skills']) or '-'}",
            f"models: {', '.join(d['models'])}   out_tokens={d['out_tokens']}   cost=${d['cost'] or 0:.0f}",
            f"spawned_from: {m.get('spawnedFrom') or m.get('forkedFromSessionId') or '-'}   archived={m.get('isArchived')}"]
    if m.get("postTurnSummary"):
        head.append(f"app_summary: {clip(json.dumps(m['postTurnSummary']), 700)}")
    body = [f"\n## [{day(t)}] {kind}\n{text}" for t, kind, text in events]
    # Over budget: keep the opening and the end whole, thin the middle to what the human typed.
    total = sum(len(b) for b in body)
    if total > DIGEST_CAP:
        keep_head, keep_tail, used = [], [], 0
        for b in body:
            if used > DIGEST_CAP * 0.3:
                break
            keep_head.append(b); used += len(b)
        used = 0
        for b in reversed(body[len(keep_head):]):
            if used > DIGEST_CAP * 0.35:
                break
            keep_tail.insert(0, b); used += len(b)
        mid = body[len(keep_head): len(body) - len(keep_tail)]
        budget = DIGEST_CAP * 0.35
        per = max(160, int(budget / max(1, len(mid))))
        mid = [b[:per] + (" […]" if len(b) > per else "") for b in mid if "] agent\n" not in b[:40] or per > 600]
        body = keep_head + [f"\n[… middle of session thinned: {len(mid)} events, each cut to {per} chars …]"] + mid + keep_tail
    idx = {k: d[k] for k in ("sid", "path", "cwd", "title", "lane", "first", "last", "prompts", "turns", "interrupts", "corrections",
                             "denials", "tool_errors", "compactions", "api_errors", "out_tokens", "cost", "active_min", "subagents", "spawned")}
    days = collections.Counter(time.strftime("%Y-%m-%d", time.localtime(b * A.BUCKET)) for b in d["buckets"])
    idx.update(days={k: v * A.BUCKET // 60 for k, v in sorted(days.items())},
               prs=[k for k, _ in d["prs"].most_common(8)], issues=[k for k, _ in d["issues"].most_common(5)],
               branches=[b for b, _ in d["branches"].most_common(3)], tools=dict(d["tools"].most_common(15)),
               models=list(d["models"]), skills=list(d["skills"]), spawned_from=m.get("spawnedFrom") or m.get("forkedFromSessionId"),
               desktop_id=m.get("sessionId"), archived=m.get("isArchived"),
               first_prompt=next((x for _, k, x in events if k.startswith("human")), "")[:400])
    return "\n".join(head) + "\n" + "".join(body) + "\n", idx


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--since", default="2026-10-01")
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--index-only", action="store_true", help="rewrite index.json, leave the digests alone")
    a = ap.parse_args()
    since = time.mktime(time.strptime(a.since, "%Y-%m-%d"))
    os.makedirs(os.path.join(a.out, "digests"), exist_ok=True)
    meta = A.read_desktop_meta()
    index = []
    for cd in A.CLAUDE_DIRS:
        for path in glob.glob(os.path.join(cd, "projects", "*", "*.jsonl")):
            if os.path.getmtime(path) < since:
                continue
            text, idx = digest(path, since, meta)
            if not text:
                continue
            idx["chars"] = len(text)
            if not a.index_only:
                open(os.path.join(a.out, "digests", idx["sid"] + ".md"), "w").write(text)
            index.append(idx)
    index.sort(key=lambda i: i["first"])
    json.dump(index, open(os.path.join(a.out, "index.json"), "w"), indent=1)
    lanes = collections.Counter(i["lane"] for i in index)
    print(f"{len(index)} sessions, {sum(i['chars'] for i in index) // 1000} KB of digests -> {a.out}")
    print("lanes:", ", ".join(f"{k}×{v}" for k, v in lanes.most_common(40)))


if __name__ == "__main__":
    main()
