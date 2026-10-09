"""Recorded profiles, kept beyond the helper's 30-minute window (phase 4 of docs/jvm-profiler.md).

Stored losslessly, the way JFR itself keeps them small: constant pools plus compact references.
  - frame: every frame name once.
  - node: stacks as a prefix tree, (parent, frame), so stacks share their common prefixes. A node that ends a sampled
    stack also records that stack's activity, which is a function of the stack, not of the sample.
  - tgroup: thread groups (names with their numbering wildcarded).
  - sample_blob: per JVM, minute and kind, one zlib-compressed run of varints: (thread group, node delta, weight)...
A machine-wide flame graph for any range is then a decode and a walk up the tree: session → JVM → activity → frames.
"""
import collections, threading, zlib

RETENTION_DAYS = 7

SCHEMA = """
CREATE TABLE IF NOT EXISTS frame (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS node (id INTEGER PRIMARY KEY, parent INTEGER NOT NULL, frame INTEGER NOT NULL, activity TEXT, UNIQUE (parent, frame));
CREATE TABLE IF NOT EXISTS tgroup (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS sample_blob (jvm_id INTEGER NOT NULL, t INTEGER NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL, data BLOB NOT NULL,
  PRIMARY KEY (jvm_id, t, kind)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS sample_blob_t ON sample_blob (t);
"""

_lock = threading.Lock()
_frames, _nodes, _groups = {}, {}, {}  # name -> id; (parent, frame) -> id; name -> id
_helper_stacks = {}  # (helper gen, pid, helper stack id) -> node id: what this process has already interned


def prune(c, now):
    c.execute("DELETE FROM sample_blob WHERE t < ?", (now - RETENTION_DAYS * 86400,))
    # the pools are shared and only grow with new code paths; they stay


# ---------------------------------------------------------------------------------------------- varints

def _put(out, v):
    while v >= 0x80:
        out.append(v & 0x7F | 0x80)
        v >>= 7
    out.append(v)


def _zig(v):
    return v << 1 if v >= 0 else (-v << 1) - 1


def _unzig(v):
    return v >> 1 if not v & 1 else -((v + 1) >> 1)


def encode(rows):
    """[(group id, node id, weight)] -> compressed bytes. Sorted by node, so deltas are small."""
    out = bytearray()
    prev = 0
    for g, node, w in sorted(rows, key=lambda r: (r[1], r[0])):
        _put(out, g)
        _put(out, _zig(node - prev))
        _put(out, w)
        prev = node
    return zlib.compress(bytes(out), 6)


def decode(data):
    b, i, prev, out = zlib.decompress(data), 0, 0, []
    vals = []
    while i < len(b):
        v = shift = 0
        while True:
            x = b[i]
            i += 1
            v |= (x & 0x7F) << shift
            shift += 7
            if x < 0x80:
                break
        vals.append(v)
        if len(vals) == 3:
            g, d, w = vals
            prev += _unzig(d)
            out.append((g, prev, w))
            vals = []
    return out


# ---------------------------------------------------------------------------------------------- interning

def _id(c, cache, table, name):
    i = cache.get(name)
    if i is None:
        c.execute(f"INSERT OR IGNORE INTO {table} (name) VALUES (?)", (name,))
        i = cache[name] = c.execute(f"SELECT id FROM {table} WHERE name = ?", (name,)).fetchone()[0]
    return i


def _node(c, parent, frame):
    k = (parent, frame)
    i = _nodes.get(k)
    if i is None:
        c.execute("INSERT OR IGNORE INTO node (parent, frame) VALUES (?, ?)", k)
        i = _nodes[k] = c.execute("SELECT id FROM node WHERE parent = ? AND frame = ?", k).fetchone()[0]
    return i


def store_minute(db, helper, gen, pid, jvm_id, t):
    """Fetch [t, t+60s) of one recording from the helper and store it. Returns (rows, compressed bytes)."""
    m = helper.call("minute", pid=pid, t0=t * 1000, t1=(t + 60) * 1000)["minute"]
    if not m["rows"]:
        return 0, 0
    unknown = sorted({sid for _, _, sid, _ in m["rows"] if sid >= 0 and (gen, pid, sid) not in _helper_stacks})
    defs = helper.call("stacks", pid=pid, ids=unknown)["stacks"] if unknown else dict(frames=[], stacks=[])
    with _lock:
        try:
            return _store(db, gen, pid, jvm_id, t, m, defs)
        except Exception:
            for cache in (_frames, _nodes, _groups, _helper_stacks):  # the transaction rolled back: so must the caches
                cache.clear()
            raise


def _store(db, gen, pid, jvm_id, t, m, defs):
    with db() as c:
        fids = [_id(c, _frames, "frame", n) for n in defs["frames"]]
        for sid, path, activity in defs["stacks"]:
            node = 0
            for k in path:
                node = _node(c, node, fids[k])
            c.execute("UPDATE node SET activity = ? WHERE id = ? AND activity IS NULL", (activity, node))
            _helper_stacks[(gen, pid, sid)] = node
        gids = [_id(c, _groups, "tgroup", g) for g in m["groups"]]
        by_kind = collections.defaultdict(collections.Counter)
        for kind, g, sid, w in m["rows"]:
            by_kind[kind][(gids[g], _helper_stacks.get((gen, pid, sid), 0))] += w
        size = 0
        for kind, acc in by_kind.items():
            data = encode([(g, node, w) for (g, node), w in acc.items()])
            size += len(data)
            c.execute("INSERT OR REPLACE INTO sample_blob VALUES (?,?,?,?,?)", (jvm_id, int(t), kind, len(acc), data))
    return len(m["rows"]), size


# ---------------------------------------------------------------------------------------------- queries

def _paths(c, leaves):
    """node id -> ([frame names root first], activity), loading just the ancestors needed."""
    if not leaves:
        return {}
    c.execute("CREATE TEMP TABLE IF NOT EXISTS want (id INTEGER PRIMARY KEY)")
    c.execute("DELETE FROM want")
    c.executemany("INSERT OR IGNORE INTO want VALUES (?)", [(x,) for x in leaves])
    rows = c.execute("""WITH RECURSIVE anc(id) AS (SELECT id FROM want UNION SELECT n.parent FROM node n JOIN anc ON n.id = anc.id WHERE n.parent > 0)
                        SELECT n.id, n.parent, f.name, n.activity FROM node n JOIN anc ON n.id = anc.id JOIN frame f ON f.id = n.frame""").fetchall()
    nodes = {i: (p, name, act) for i, p, name, act in rows}
    memo = {0: []}

    def path(i):
        if i not in memo:
            p, name, _ = nodes[i]
            memo[i] = path(p) + [name]
        return memo[i]
    return {leaf: (path(leaf), nodes[leaf][2] if leaf in nodes else None) for leaf in leaves if leaf in nodes or leaf == 0}


def flame(db, t0, t1, kind="cpu", reverse=False, labels=None, min_share=0.002):
    """[name, value, children] over every recorded JVM in [t0, t1): session → JVM → activity → frames (or reversed).
    labels(jvm_id) -> (session label, JVM label)."""
    acc = collections.Counter()
    with db() as c:
        blobs = c.execute("SELECT jvm_id, data FROM sample_blob WHERE t >= ? AND t < ? AND kind = ?", (t0, t1, kind)).fetchall()
        span = c.execute("SELECT MIN(t), MAX(t), COUNT(*), SUM(LENGTH(data)) FROM sample_blob WHERE t >= ? AND t < ? AND kind = ?", (t0, t1, kind)).fetchone()
        for jvm_id, data in blobs:
            for _, node, w in decode(data):
                acc[(jvm_id, node)] += w
        paths = _paths(c, {node for _, node in acc})
    root = [None, 0, {}]
    total = 0
    for (jvm_id, node), w in acc.items():
        frames, activity = paths.get(node, ([], None))
        sess, jl = labels(jvm_id) if labels else ("?", str(jvm_id))
        # the first three levels are ours, not frames: marked, so the page can draw them as labels
        path = [(sess, 1), (jl, 1), (activity or "?", 1)] + [(f, 0) for f in frames]
        if reverse:
            path.reverse()
        total += w
        n = root
        n[1] += w
        for name, meta in path:
            n = n[2].setdefault((name, meta), [name, 0, {}, meta])
            n[1] += w

    def out(n, name):
        kids = sorted((k for k in n[2].values() if k[1] >= max(1, total * min_share)), key=lambda k: -k[1])
        return [name, n[1], [out(k, k[0]) for k in kids]] + ([1] if len(n) > 3 and n[3] else [])

    return dict(kind=kind, reverse=reverse, total=total, t0=t0, t1=t1, first=span[0], last=span[1], minutes=span[2], bytes=span[3] or 0, root=out(root, "all"))


def storage(db):
    with db() as c:
        return dict(frames=c.execute("SELECT COUNT(*) FROM frame").fetchone()[0], nodes=c.execute("SELECT COUNT(*) FROM node").fetchone()[0],
                    blobs=c.execute("SELECT COUNT(*), SUM(LENGTH(data)), SUM(n) FROM sample_blob").fetchone())
