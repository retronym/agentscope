"""Recorded profiles, kept beyond the helper's 30-minute window (phase 4 of docs/jvm-profiler.md).

Stored losslessly, the way JFR itself keeps them small: constant pools plus compact references.
  - frame: every frame name once.
  - node: stacks as a prefix tree, (parent, frame), so stacks share their common prefixes. A node that ends a sampled
    stack also records that stack's activity, which is a function of the stack, not of the sample.
  - tgroup: thread groups (names with their numbering wildcarded).
  - sample_blob: per JVM, minute and kind, one zlib-compressed run of varints: (thread group, node delta, weight)...
A machine-wide flame graph for any range is then a decode and a walk up the tree: session → JVM → activity → frames.
Queries walk an in-memory copy of the pool's parent and frame links (two int arrays, 8 bytes a node), loaded once and
kept current by the writes; a SQL walk of the ancestors of every sampled stack took seconds per query.

Minutes older than RETENTION_DAYS are dropped hourly; once a day, gc() then drops the pool rows that no remaining minute
references (deep stacks make the prefix tree the bulk of the bytes, so it must not outlive the minutes that use it).
"""
import array, collections, sqlite3, threading, time, zlib

RETENTION_DAYS = 7
GC_EVERY = 86400  # seconds between pool sweeps; the first prune after a start sweeps too

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
_epoch = 0  # bumped whenever the caches are dropped, so a store_minute that looked at them before can tell
_pool = None  # Pool: the node and frame tables in memory, for queries; None until a query wants it
_gc_at = 0


def _forget():
    global _epoch, _pool
    for cache in (_frames, _nodes, _groups, _helper_stacks):
        cache.clear()
    _pool = None
    _epoch += 1


class Pool:
    """The stack pool for queries: parent[id] and frame[id] of every node, and frame names. Loaded under _lock, then
    kept current by _node and _store (which hold it too), and dropped by _forget (a sweep, or a rolled-back write)."""

    def __init__(self, c):
        top = c.execute("SELECT MAX(id) FROM node").fetchone()[0] or 0
        self.parent, self.frame = array.array("i", bytes(4 * (top + 1))), array.array("i", bytes(4 * (top + 1)))
        for i, p, f in c.execute("SELECT id, parent, frame FROM node"):
            self.parent[i], self.frame[i] = p, f
        self.names = dict(c.execute("SELECT id, name FROM frame"))

    def add(self, i, parent, frame):
        if i >= len(self.parent):
            grow = array.array("i", bytes(4 * (i + 1 - len(self.parent))))
            self.parent.extend(grow)
            self.frame.extend(grow)
        self.parent[i], self.frame[i] = parent, frame


def pool(db):
    global _pool
    p = _pool
    if p is None:
        with _lock:
            if _pool is None:
                with db() as c:
                    _pool = Pool(c)
            p = _pool
    return p


def prune(c, now):
    c.execute("DELETE FROM sample_blob WHERE t < ?", (now - RETENTION_DAYS * 86400,))


def gc(db, now=None, force=False):
    """Delete node, frame and tgroup rows no remaining sample_blob references. Returns counts, or None if not due.
    Mark: decode every blob for its leaves and groups, then walk up the parent links. A parent is always inserted
    before its children and SQLite gives a new row max(id)+1, so parent < child: one pass down the ids marks every
    ancestor. Runs under _lock, so no store_minute interleaves, and drops the caches, which may name swept rows."""
    global _gc_at
    now = time.time() if now is None else now
    if not force and now - _gc_at < GC_EVERY:
        return None
    _gc_at = now
    t = time.time()
    with _lock:
        with db() as c:
            c.execute("BEGIN IMMEDIATE")
            top = c.execute("SELECT MAX(id) FROM node").fetchone()[0] or 0
            live, groups = bytearray(top + 1), set()
            for (data,) in c.execute("SELECT data FROM sample_blob"):
                for g, node, _ in decode(data):
                    if 0 < node <= top:
                        live[node] = 1
                    groups.add(g)
            dead = []
            for i, parent in c.execute("SELECT id, parent FROM node ORDER BY id DESC"):
                if live[i]:
                    live[parent] = 1
                else:
                    dead.append((i,))
            c.executemany("DELETE FROM node WHERE id = ?", dead)
            frames = c.execute("DELETE FROM frame WHERE id NOT IN (SELECT frame FROM node)").rowcount
            c.execute("CREATE TEMP TABLE IF NOT EXISTS live_group (id INTEGER PRIMARY KEY)")
            c.execute("DELETE FROM live_group")
            c.executemany("INSERT INTO live_group VALUES (?)", [(g,) for g in groups])
            tgroups = c.execute("DELETE FROM tgroup WHERE id NOT IN (SELECT id FROM live_group)").rowcount
            _forget()
        # freed pages are reused by the pools' growth; give them back only when they are most of the file (say, the
        # first sweep of a database that grew before there was one, or after recording stopped for a while)
        with db() as c:
            free, pages = c.execute("PRAGMA freelist_count").fetchone()[0], c.execute("PRAGMA page_count").fetchone()[0]
        vacuumed = free > pages // 2
        if vacuumed:
            c = db()
            try:
                c.execute("VACUUM")
            except sqlite3.OperationalError:  # busy: the pages stay free for reuse, and the next sweep tries again
                vacuumed = False
            finally:
                c.close()
    return dict(nodes=len(dead), frames=frames, tgroups=tgroups, free_pages=free, pages=pages, vacuumed=vacuumed, secs=round(time.time() - t, 1))


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
        if _pool is not None:
            _pool.add(i, parent, frame)
    return i


def store_minute(db, helper, gen, pid, jvm_id, t):
    """Fetch [t, t+60s) of one recording from the helper and store it. Returns (rows, compressed bytes)."""
    m = helper.call("minute", pid=pid, t0=t * 1000, t1=(t + 60) * 1000)["minute"]
    if not m["rows"]:
        return 0, 0
    while True:
        epoch = _epoch
        unknown = sorted({sid for _, _, sid, _ in m["rows"] if sid >= 0 and (gen, pid, sid) not in _helper_stacks})
        defs = helper.call("stacks", pid=pid, ids=unknown)["stacks"] if unknown else dict(frames=[], stacks=[])
        with _lock:
            if epoch != _epoch:  # the caches were dropped since we asked which stacks are unknown: ask again
                continue
            try:
                return _store(db, gen, pid, jvm_id, t, m, defs)
            except Exception:
                _forget()  # the transaction rolled back: so must the caches
                raise


def _store(db, gen, pid, jvm_id, t, m, defs):
    with db() as c:
        fids = [_id(c, _frames, "frame", n) for n in defs["frames"]]
        if _pool is not None:
            _pool.names.update(zip(fids, defs["frames"]))
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

def flame(db, t0, t1, kind="cpu", reverse=False, labels=None, min_share=0.002, path=()):
    """[name, value, children] over every recorded JVM in [t0, t1): session → JVM → activity → frames (or reversed).
    labels(jvm_id) -> (session label, JVM label). Nodes under min_share of the total are left out, except along and
    below `path` (the page's zoom), where the share is of the zoomed subtree: detail appears as you zoom in.
    The tree is built lazily, so the cost follows what's kept, not every frame of every sampled stack: top-down sums
    weights up the prefix tree (a parent's id is below its children's, so one pass in descending ids), reversed walks
    cursors up from the sampled nodes, a level at a time, only below nodes that made the cut."""
    P = pool(db)
    acc = collections.Counter()
    with db() as c:
        c.execute("BEGIN")  # one snapshot for the blobs and the tree they reference, should a gc() commit in between
        blobs = c.execute("SELECT jvm_id, data FROM sample_blob WHERE t >= ? AND t < ? AND kind = ?", (t0, t1, kind)).fetchall()
        span = c.execute("SELECT MIN(t), MAX(t), COUNT(*), SUM(LENGTH(data)) FROM sample_blob WHERE t >= ? AND t < ? AND kind = ?", (t0, t1, kind)).fetchone()
        for jvm_id, data in blobs:
            for _, node, w in decode(data):
                acc[(jvm_id, node)] += w
        acts = _activities(c, {node for _, node in acc})
    n_nodes = len(P.parent)
    groups = collections.defaultdict(collections.Counter)  # (session, JVM, activity) -> {sampled node: weight}
    for (jvm_id, node), w in acc.items():
        sess, jl = labels(jvm_id) if labels else ("?", str(jvm_id))
        groups[(sess, jl, acts.get(node) or "?")][node if 0 <= node < n_nodes else 0] += w
    total = sum(acc.values())
    name = lambda n: P.names.get(P.frame[n], "?")

    if reverse:
        def kids(h):  # h: [(group, node, stage, weight)]; stage 0 walks frames, then activity, JVM, session
            by = {}
            for g, n, st, w in h:
                if st == 0 and n:
                    key, nxt = (name(n), 0), (g, P.parent[n], 0)
                elif st < 3:
                    key, nxt = (g[2 - st], 1), (g, 0, st + 1)
                else:
                    continue
                v = by.setdefault(key, [0, {}])
                v[0] += w
                v[1][nxt] = v[1].get(nxt, 0) + w
            return [(k[0], k[1], v, [(*x, w) for x, w in m.items()]) for k, (v, m) in by.items()]
        root = [(g, n, 0, w) for g, ws in groups.items() for n, w in ws.items()]
    else:
        tots, frame_kids = {}, {}  # group -> {node: subtree weight}; group -> {node: [child nodes]}, built on demand

        def subtree(g):
            if g not in tots:
                tot, par = collections.Counter(groups[g]), P.parent
                seen = set()
                for n in groups[g]:
                    while n and n not in seen:
                        seen.add(n)
                        n = par[n]
                for n in sorted(seen, reverse=True):
                    if par[n]:
                        tot[par[n]] += tot[n]
                ks = collections.defaultdict(list)
                for n in seen:
                    ks[par[n]].append(n)
                tots[g], frame_kids[g] = tot, ks
            return tots[g], frame_kids[g]

        def kids(h):  # h: ('label', depth, prefix) for the first three levels, ('frame', group, node) below
            if h[0] == "frame":
                tot, ks = subtree(h[1])
                return [(name(n), 0, tot[n], ("frame", h[1], n)) for n in ks.get(h[2], ())]
            _, d, prefix = h
            if d == 3:
                return kids(("frame", prefix, 0))
            by = collections.Counter()
            for g, ws in groups.items():
                if g[:d] == prefix:
                    by[g[d]] += sum(ws.values())
            return [(k, 1, v, ("label", d + 1, prefix + (k,))) for k, v in by.items()]
        root = ("label", 0, ())

    # the zoom root's weight, for the threshold along and below it
    at, h = total, root
    for p in path:
        k = next((k for k in kids(h) if k[0] == p), None)
        if k is None:
            at = total
            break
        at, h = k[2], k[3]
    lo, lo_path = max(1, total * min_share), max(1, at * min_share)

    def out(h, nm, value, meta, depth=0, inside=not path):
        children = []
        for k in sorted(kids(h), key=lambda k: -k[2]):
            on = not inside and depth < len(path) and k[0] == path[depth]
            if k[2] >= (lo_path if inside or on else lo):
                children.append(out(k[3], k[0], k[2], k[1], depth + 1, inside or (on and depth + 1 == len(path))))
        return [nm, value, children] + ([1] if meta else [])

    return dict(kind=kind, reverse=reverse, total=total, t0=t0, t1=t1, first=span[0], last=span[1], minutes=span[2], bytes=span[3] or 0,
                root=out(root, "all", total, 0))


def _activities(c, nodes):
    """node id -> activity, for the sampled nodes (a node that ends a stack carries its activity)."""
    c.execute("CREATE TEMP TABLE IF NOT EXISTS want (id INTEGER PRIMARY KEY)")
    c.execute("DELETE FROM want")
    c.executemany("INSERT OR IGNORE INTO want VALUES (?)", [(x,) for x in nodes])
    return dict(c.execute("SELECT n.id, n.activity FROM node n JOIN want USING (id) WHERE n.activity IS NOT NULL"))


def storage(db):
    with db() as c:
        return dict(frames=c.execute("SELECT COUNT(*) FROM frame").fetchone()[0], nodes=c.execute("SELECT COUNT(*) FROM node").fetchone()[0],
                    blobs=c.execute("SELECT COUNT(*), SUM(LENGTH(data)), SUM(n) FROM sample_blob").fetchone())
