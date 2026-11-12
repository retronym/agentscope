#!/usr/bin/env python3
"""GitHub activity since a date: PRs and issues you wrote, ones you only took part in, and the repos you own.

    python3 -m insights.github --since 2026-10-01
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import agentscope as A  # noqa: E402

OUT = os.path.join(A.CACHE, "insights")
ITEM = """__typename ... on PullRequest { number title url state isDraft createdAt updatedAt mergedAt closedAt headRefName baseRefName
    reviewDecision additions deletions author { login } repository { nameWithOwner } comments { totalCount } bodyText }
  ... on Issue { number title url state createdAt updatedAt closedAt author { login } repository { nameWithOwner }
    comments { totalCount } bodyText }"""


def gql(query, **vars):
    cmd = ["gh", "api", "graphql", "-f", f"query={query}"] + [x for k, v in vars.items() if v for x in ("-f", f"{k}={v}")]
    for attempt in range(4):  # GitHub's GraphQL search 502s intermittently
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
        if not r.returncode:
            return json.loads(r.stdout)["data"]
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"gh: {r.stderr.strip()[:300]}")


def search(q, pages=20):  # GitHub's search stops at 1000 results; split the range by month to go past that
    query = f"""query($q:String!,$after:String){{ search(query:$q, type:ISSUE, first:50, after:$after){{
      issueCount pageInfo {{ hasNextPage endCursor }} nodes {{ {ITEM} }} }} }}"""
    nodes, after = [], None
    for _ in range(pages):
        sr = gql(query, q=q, after=after)["search"]
        nodes += [n for n in sr["nodes"] if n]
        if not sr["pageInfo"]["hasNextPage"]:
            break
        after = sr["pageInfo"]["endCursor"]
    return nodes


REF = re.compile(r"(?:github\.com/)?([\w.-]+/[\w.-]+)?(?:#|/pull/|/issues/)(\d+)")


def refs(body, repo):
    """Every PR or issue a body points at, as owner/repo#n; a bare #n is in the body's own repo."""
    return sorted({f"{r or repo}#{n}" for r, n in REF.findall(body) if int(n) < 100000})


def flat(n, role):
    return dict(key=f"{n['repository']['nameWithOwner']}#{n['number']}", kind="pr" if n["__typename"] == "PullRequest" else "issue",
                role=role, repo=n["repository"]["nameWithOwner"], number=n["number"], title=n["title"], url=n["url"],
                state=n["state"], draft=n.get("isDraft"), author=(n.get("author") or {}).get("login"),
                created=A.iso_to_epoch(n["createdAt"]), updated=A.iso_to_epoch(n["updatedAt"]),
                merged=A.iso_to_epoch(n.get("mergedAt")), closed=A.iso_to_epoch(n.get("closedAt")),
                head=n.get("headRefName"), base=n.get("baseRefName"), review=n.get("reviewDecision"),
                adds=n.get("additions"), dels=n.get("deletions"), comments=n["comments"]["totalCount"],
                body=(n.get("bodyText") or "")[:1200], refs=refs(n.get("bodyText") or "", n["repository"]["nameWithOwner"]))


def repos(since):
    query = """query($after:String){ viewer { login repositories(first:100, after:$after, ownerAffiliations:OWNER,
      orderBy:{field:PUSHED_AT, direction:DESC}){ pageInfo { hasNextPage endCursor } nodes { nameWithOwner description isFork isPrivate
      createdAt pushedAt url parent { nameWithOwner } primaryLanguage { name } defaultBranchRef { name } } } } }"""
    out, after = [], None
    while True:
        v = gql(query, after=after)["viewer"]["repositories"]
        for n in v["nodes"]:
            if n["pushedAt"] and n["pushedAt"][:10] >= since:
                out.append(dict(repo=n["nameWithOwner"], desc=n["description"], fork=n["isFork"], private=n["isPrivate"],
                                parent=(n.get("parent") or {}).get("nameWithOwner"), created=A.iso_to_epoch(n["createdAt"]),
                                pushed=A.iso_to_epoch(n["pushedAt"]), url=n["url"], lang=(n.get("primaryLanguage") or {}).get("name")))
        if not v["pageInfo"]["hasNextPage"] or (v["nodes"] and (v["nodes"][-1]["pushedAt"] or "")[:10] < since):
            break
        after = v["pageInfo"]["endCursor"]
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--since", default="2026-10-01")
    ap.add_argument("--out", default=OUT)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    items = {}
    # created in the period, a month at a time, plus older ones still being updated
    y, m = int(a.since[:4]), int(a.since[5:7])
    spans, now = [f"created:<{a.since} updated:>={a.since}"], time.strftime("%Y-%m")
    while f"{y}-{m:02d}" <= now:
        ny, nm = (y, m + 1) if m < 12 else (y + 1, 1)
        spans.append(f"created:{max(a.since, f'{y}-{m:02d}-01')}..{ny}-{nm:02d}-01")
        y, m = ny, nm
    for role, q in (("author", "author:@me"), ("involved", "involves:@me -author:@me")):
        for kind in ("is:pr", "is:issue"):
            for span in spans:
                for n in search(f"{kind} {q} {span} sort:created-asc"):
                    f = flat(n, role)
                    items.setdefault(f["key"], f)
    rs = repos(a.since)
    json.dump(dict(since=a.since, fetched=time.time(), items=sorted(items.values(), key=lambda i: i["created"]), repos=rs),
              open(os.path.join(a.out, "github.json"), "w"), indent=1)
    by = {}
    for i in items.values():
        by[(i["role"], i["kind"], i["state"])] = by.get((i["role"], i["kind"], i["state"]), 0) + 1
    print(f"{len(items)} PRs/issues, {len(rs)} repos pushed since {a.since}")
    for k in sorted(by):
        print("  ", *k, by[k])


if __name__ == "__main__":
    main()
