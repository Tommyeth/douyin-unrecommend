import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "plugins/douyin-dots/skills/douyin-direct/scripts/state.py"
spec = importlib.util.spec_from_file_location("dots_state", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def observation(values, complete=True, owner="fixture.account"):
    return {"account": owner, "complete": complete, "end_reason": "end_marker",
            "videos": [{"id": str(i), "title": f"虚构作品 {i}", "url": f"https://www.douyin.com/video/{i}"} for i in values]}


class StateTests(unittest.TestCase):
    def setUp(self):
        self.now = 1000
        self.state, _ = module.transition(None, "init", {"account": "fixture.account", "mode": "notify"}, self.now)

    def call(self, operation, **data):
        self.state, result = module.transition(copy.deepcopy(self.state), operation, data, self.now)
        return result

    def begin(self):
        return self.call("begin", account="fixture.account")["run"]

    def observe(self, run, values, complete=True):
        return self.call("observe", run=run, snapshot=observation(values, complete))

    def test_notify_baseline_dedup_ack_and_rerecommend(self):
        run = self.begin()
        self.assertEqual(self.observe(run, [1])["notifications"], [])
        result = self.observe(run, [1, 2])
        self.assertEqual([p["video"]["id"] for p in result["notifications"]], ["2"])
        self.assertEqual(len(self.observe(run, [1, 2])["notifications"]), 1)
        self.call("ack", run=run, events=[1])
        self.observe(run, [1])
        self.assertEqual(self.observe(run, [1, 2])["notifications"][0]["event"], 2)

    def test_partial_scan_cannot_erase_presence_or_enable_cancel(self):
        run = self.begin()
        self.observe(run, [1, 2])
        self.observe(run, [3], False)
        self.assertEqual(set(self.state["present"]), {"1", "2", "3"})
        self.assertEqual(len(self.observe(run, [1, 2, 3])["notifications"]), 1)
        self.call("configure", mode="auto_cancel")
        run = self.begin()
        self.assertEqual(self.observe(run, [1], False)["candidates"], [])

    def test_partial_first_run_does_not_establish_baseline(self):
        run = self.begin()
        self.observe(run, [1], False)
        self.assertFalse(self.state["baseline"])
        self.assertEqual(self.observe(run, [1, 2])["notifications"], [])

    def test_cancel_limit_keep_and_verification(self):
        self.call("configure", mode="auto_cancel", keep=["2"])
        run = self.begin()
        result = self.observe(run, range(1, 9))
        self.assertEqual([v["id"] for v in result["candidates"]], ["1", "3", "4", "5", "6"])
        for ident in ["1", "2", "8"]:
            with self.assertRaises(ValueError):
                self.call("confirm", run=run, id=ident, control_state="unrecommended")
        self.observe(run, range(2, 9), False)
        with self.assertRaises(ValueError):
            self.call("confirm", run=run, id="1", control_state="unrecommended")
        self.observe(run, range(2, 9))
        with self.assertRaises(ValueError):
            self.call("confirm", run=run, id="1", control_state="unknown")
        self.assertEqual(self.call("confirm", run=run, id="1", control_state="unrecommended")["confirmed_cancelled"], ["1"])
        self.assertEqual(self.call("confirm", run=run, id="1", control_state="unrecommended")["confirmed_cancelled"], ["1"])
        self.assertEqual(len(self.call("plan", run=run)["candidates"]), 4)

    def test_account_mismatch_and_bad_evidence_do_not_write(self):
        with self.assertRaises(ValueError):
            self.call("begin", account="someone.else")
        run = self.begin()
        original = copy.deepcopy(self.state)
        samples = [observation([1], owner="someone.else"), observation([1, 1])]
        wrong_count = observation([1]) | {"end_reason": "count_matched", "total": 2}
        fake_empty = observation([1]) | {"end_reason": "empty"}
        bad_url = observation([1])
        bad_url["videos"][0]["url"] = "https://evil.example/video/1"
        for value in samples + [wrong_count, fake_empty, bad_url, observation([1]) | {"complete": 1}]:
            with self.assertRaises(ValueError):
                self.call("observe", run=run, snapshot=value)
            self.assertEqual(self.state, original)

    def test_concurrent_expired_and_paused_runs(self):
        run = self.begin()
        with self.assertRaises(ValueError):
            self.begin()
        self.now += 601
        with self.assertRaises(ValueError):
            self.call("plan", run=run)
        new = self.begin()
        with self.assertRaises(ValueError):
            self.call("finish", run=run)
        self.call("configure", paused=True)
        with self.assertRaises(ValueError):
            self.call("plan", run=new)
        with self.assertRaises(ValueError):
            self.begin()
        self.call("configure", paused=False)
        self.assertTrue(self.begin())

    def test_mode_change_invalidates_old_cancellation_plan(self):
        self.call("configure", mode="auto_cancel")
        run = self.begin()
        self.observe(run, [1])
        self.call("configure", mode="notify")
        with self.assertRaises(ValueError):
            self.call("confirm", run=run, id="1", control_state="unrecommended")

    def test_cli_atomic_state_private_permissions_and_lock(self):
        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp) / "private" / "state.json"

            def command(*args):
                return subprocess.run(["python3", str(SCRIPT), "--state", str(state), *args], capture_output=True, text=True)

            self.assertEqual(command("init", "--account", "fixture.account").returncode, 0)
            self.assertEqual(state.stat().st_mode & 0o777, 0o600)
            self.assertEqual(state.parent.stat().st_mode & 0o777, 0o700)
            before = state.read_bytes()
            self.assertNotEqual(command("init", "--account", "someone.else").returncode, 0)
            self.assertEqual(state.read_bytes(), before)
            lock = state.with_name("state.json.lock")
            lock.touch()
            self.assertNotEqual(command("begin", "--account", "fixture.account").returncode, 0)
            lock.unlink()
            started = command("begin", "--account", "fixture.account")
            self.assertEqual(started.returncode, 0)
            run = json.loads(started.stdout)["run"]
            observed = Path(temp) / "observed.json"
            observed.write_text(json.dumps(observation([]) | {"end_reason": "empty"}))
            self.assertEqual(command("observe", "--run", run, "--input", str(observed)).returncode, 0)
            self.assertEqual(command("finish", "--run", run).returncode, 0)
            self.assertEqual(json.loads(command("status").stdout)["last_run"]["observed_count"], 0)
            self.assertFalse(lock.exists())


if __name__ == "__main__":
    unittest.main()
