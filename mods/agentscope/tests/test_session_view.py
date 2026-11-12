"""python3 -m unittest discover -s mods/agentscope/tests   (made-up sessions; no agentscope needed)"""
import json
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "bin", "session_view.py")
sys.path.insert(0, os.path.dirname(SCRIPT))
import session_view  # noqa: E402

ME, CHILD, NOISY, PARENT = "me000000-1", "child000-2", "noisy000-3", "parent00-4"
STATE = dict(
    now=1_800_000_000, ncpu=10, mem_total=32 << 30,
    sessions=[
        dict(sid=ME, title="widget refactor", spawned_from=PARENT, prs=["acme/widgets#7", "acme/gone#1"], live=dict(pid=1, status="busy", waiting=None),
             load=dict(cpu=150.0, rss=3 << 30, procs=[dict(pid=10, label="claude (agent)", cpu=20.0, rss=1 << 29, self=True),
                                                       dict(pid=11, label="sbt server", cpu=130.0, rss=2 << 30, self=False)])),
        dict(sid=CHILD, title="widget benchmarks", spawned_from=ME, prs=[], live=dict(pid=2, status="idle", waiting="permission"), load=None, last=5),
        dict(sid=NOISY, title="gadget partest", spawned_from=None, prs=[], live=dict(pid=3, status="busy", waiting=None),
             load=dict(cpu=420.0, rss=1 << 30, procs=[dict(pid=30, label="partest", cpu=400.0, rss=1 << 30, self=False)])),
        dict(sid=PARENT, title="widget planning", spawned_from=None, prs=[], live=None, archived=True, load=None),
        dict(sid="quiet000-5", title="idle one", spawned_from=None, prs=[], live=dict(pid=5, status="idle"), load=dict(cpu=2.0, rss=1, procs=[])),
    ],
    prs=[dict(key="acme/widgets#7", title="Faster widgets", url="https://example.invalid/7", state="OPEN", draft=True, ci="FAILURE", review=None)],
    jvms=[dict(label="sbt server", pid=11, cpu=130.0, rss=2 << 30, sid=ME), dict(label="IDE", pid=99, cpu=5.0, rss=1 << 30, sid=None)],
    machine={"agents": dict(cpu=570.0, rss=1), "other": dict(cpu=30.0, rss=1)},
)


class SessionView(unittest.TestCase):
    def test_the_session_its_children_and_the_noisy_neighbours(self):
        v = session_view.summarize(STATE, ME)
        self.assertTrue(v["ok"])
        self.assertEqual((v["cores"], v["status"]), (1.5, "busy"))
        self.assertEqual([p["label"] for p in v["procs"]], ["sbt server", "claude (agent)"])
        self.assertEqual([j["pid"] for j in v["jvms"]], [11])
        self.assertEqual([(p["key"], p["state"], p["ci"]) for p in v["prs"]], [("acme/widgets#7", "DRAFT", "FAILURE")])
        self.assertEqual(v["parent"]["status"], "archived")
        self.assertEqual([(s["title"], s["status"]) for s in v["spawned"]], [("widget benchmarks", "waiting: permission")])
        self.assertEqual([(s["title"], s["cores"], s["top"]) for s in v["others"]], [("gadget partest", 4.2, "partest")])
        self.assertEqual(v["others_cores"], 4.2)
        self.assertEqual(v["machine"]["agents"], 5.7)

    def test_a_session_agentscope_has_not_indexed(self):
        v = session_view.summarize(STATE, "unknown0-9")
        self.assertFalse(v["ok"])
        self.assertIn("does not know session unknown0", v["error"])

    def test_agentscope_not_running_is_said_not_thrown(self):
        ran = subprocess.run([sys.executable, SCRIPT, ME, "--url", "http://127.0.0.1:9"], capture_output=True, text=True)
        out = json.loads(ran.stdout)
        self.assertEqual(ran.returncode, 0)
        self.assertFalse(out["ok"])
        self.assertIn("agentscope is not answering at http://127.0.0.1:9", out["error"])


if __name__ == "__main__":
    unittest.main()
