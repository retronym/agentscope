"""python3 -m unittest discover -s tests   (a made-up jobs directory; no server, no real sessions)"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import agentscope as A  # noqa: E402


class JobLog(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.jobs, A.JOBS = A.JOBS, os.path.join(self.tmp.name, "jobs")
        os.makedirs(os.path.join(A.JOBS, "sess-1"))
        self.log = os.path.join(A.JOBS, "sess-1", "0101-120000-build.log")
        with open(self.log, "w") as f:
            f.write("".join(f"line {i}\n" for i in range(1000)))
        with open(os.path.join(self.tmp.name, "secret.log"), "w") as f:
            f.write("not a job log\n")

    def tearDown(self):
        A.JOBS = self.jobs
        self.tmp.cleanup()

    def test_tail_then_follow(self):
        r = A.job_log("sess-1", "0101-120000-build", first=100)
        self.assertTrue(r["text"].startswith("line "))  # begins on a whole line
        self.assertTrue(r["text"].endswith("line 999\n"))
        self.assertLessEqual(len(r["text"]), 100)
        self.assertEqual(r["size"], r["total"])
        with open(self.log, "a") as f:
            f.write("line 1000\n")
        more = A.job_log("sess-1", "0101-120000-build", start=r["size"])
        self.assertEqual(more["text"], "line 1000\n")
        self.assertEqual(A.job_log("sess-1", "0101-120000-build", start=more["size"])["text"], "")

    def test_a_long_log_comes_in_chunks(self):
        with open(self.log, "w") as f:
            f.write("x" * (A.LOG_CHUNK + 10))
        r = A.job_log("sess-1", "0101-120000-build", start=0)
        self.assertEqual((r["size"], r["total"]), (A.LOG_CHUNK, A.LOG_CHUNK + 10))

    def test_a_missing_log_is_none(self):
        self.assertIsNone(A.job_log("sess-1", "0101-120000-other"))

    def test_only_files_in_the_jobs_directory(self):
        os.symlink(os.path.join(self.tmp.name, "secret.log"), os.path.join(A.JOBS, "sess-1", "link.log"))
        for sid, jid in [("..", "secret"), ("sess-1", "../../secret"), ("sess-1/..", "x"), ("", "x"), ("sess-1", ""), (".", "sess-1/0101-120000-build"),
                         ("sess-1", "link"), ("/etc", "hosts"), ("sess-1", "a\x00b"), (None, None)]:
            with self.assertRaises(ValueError, msg=f"{sid!r} {jid!r}"):
                A.job_log(sid, jid)


if __name__ == "__main__":
    unittest.main()
