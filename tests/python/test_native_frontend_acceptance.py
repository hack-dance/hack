"""Controls for the native frontend acceptance driver, against a stand-in bundle."""
import argparse
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest import mock

source = Path(__file__).resolve().parents[2] / "scripts/accept-native-frontend.py"
spec = importlib.util.spec_from_file_location("accept_native_frontend", source)
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)

# One stand-in serves as both hack-native and hack-v5 (by file name) over a shared state file.
# `up` refuses unless a prepared base is required, then stays in the foreground until `down`.
FAKE = r'''#!PYTHON
import json, os, pathlib, secrets, sys, time
here = pathlib.Path(__file__).parent
name = pathlib.Path(__file__).name
path = here / "state.json"
fault = os.environ.get("FAKE_FAULT", "")


def load():
    return json.loads(path.read_text()) if path.exists() else {"calls": []}


def save(state):
    temporary = path.with_name(f"state-{os.getpid()}.tmp")
    temporary.write_text(json.dumps(state))
    os.replace(temporary, path)


def reply(body, code=0):
    print(json.dumps(body) if isinstance(body, dict) else body)
    sys.exit(code)


argv = sys.argv[1:]
state = load()
state["calls"].append([name, *argv])
save(state)
if name == "hack-native":
    argv = argv[2:]
    if argv[:2] == ["runtime", "status"]:
        alive = state.get("alive", False)
        share = state.get("share") if fault != "wrong-share" else "/elsewhere"
        reply({"phase": "running" if alive else "stopped", "process_alive": alive, "machine": "m-1",
               "project_share": {"project": share},
               "prepared_base": {"selection": {"source": "stock" if fault == "stock-fallback" else "prepared",
                                               "base_id": state.get("base")}, "activation": "consumed"}})
    if argv[:2] == ["runtime", "down"]:
        state["alive"] = fault == "still-alive"
        save(state)
        reply({"phase": "stopped"})
    action = argv[2] if argv[:2] == ["runtime", "prepared-base"] else None
    if action == "build":
        state["base"] = "development-fake"
        save(state)
        reply({"receipt": {"base_id": "development-fake"}, "work_removed": True, "recovered_work": []})
    if action == "verify":
        reply({"base_id": state.get("base"), "recovered_work": []})
    if action == "status":
        reply({"bases": [{"base_id": state["base"], "verified": True}] if state.get("base") else [],
               "abandoned_work": []})
    if action == "remove":
        state["base"] = None
        save(state)
        reply({})
    reply({})
option = lambda key: argv[argv.index(key) + 1]
if argv[0] == "up":
    if os.environ.get("HACK_NATIVE_PREPARED_BASE") != "require" or not os.environ.get("HACK_NATIVE_PREPARED_BASE_STORE"):
        reply("prepared base not requested", 2)
    token = secrets.token_hex(4)
    state = load()
    state.update(foreground=token, alive=True, share=option("--path"), container=state.get("container", 0) + 1,
                 up_env={k: v for k, v in os.environ.items() if k.startswith("HACK_NATIVE_")})
    state.setdefault("run", "r" + secrets.token_hex(8))
    save(state)
    deadline = time.time() + 30
    while time.time() < deadline:
        time.sleep(0.02)
        if load().get("foreground") != token:
            sys.exit(0)
    sys.exit(3)
if argv[0] == "ps":
    if fault == "ps-hang":
        time.sleep(10)
    if state.get("foreground"):
        reply({"status": "observed", "phase": "ready-observed", "backend": "native", "run": state["run"],
               "items": [{"container": f"c{state['container']}"}]})
    reply({"status": "stopped"})
if argv[0] == "exec":
    command = argv[argv.index("--") + 1:]
    if command[-1] == "/data/marker":
        reply("" if fault == "lose-marker" else state.get("marker", ""))
    state["marker"] = command[-1].split()[1]
    save(state)
    reply("")
if argv[0] == "down":
    state["foreground"] = None
    save(state)
    reply("")
reply("unknown", 9)
'''


class Acceptance(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="hack-frontend-accept-")).resolve()
        self.bundle = Path(tempfile.mkdtemp(prefix="hack-frontend-bundle-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.addCleanup(shutil.rmtree, self.bundle, True)
        self.addCleanup(os.environ.pop, "FAKE_FAULT", None)
        for name in ("hack-native", "hack-v5"):
            (self.bundle / name).write_text(FAKE.replace("PYTHON", sys.executable, 1))
            (self.bundle / name).chmod(0o700)
        self.args = argparse.Namespace(
            bundle=str(self.bundle), root=str(self.root), provider_archive="/p", engine_archive="/e",
            network_tools="/n", image="example@sha256:" + "d" * 64, caddy="/caddy", caddy_sha256="c" * 64,
            https_port=41443, budget=60.0)

    def accept(self, fault="", stale=False):
        os.environ["FAKE_FAULT"] = fault
        acceptance = driver.Acceptance(self.args)
        first = []

        def fetch():
            # The stand-in serves the live worktree, or keeps serving the first content it saw.
            body = (acceptance.project / "index.txt").read_text()
            first.append(body)
            return first[0] if stale else body

        acceptance.fetch = fetch
        acceptance.https_wait = 1
        with contextlib.redirect_stdout(io.StringIO()):
            code = acceptance.run()
        # A failed run deliberately leaves live foregrounds for diagnosis; these are the test's
        # own stand-ins, so reap them.
        for _, process in acceptance.foregrounds:
            if process.poll() is None:
                process.kill()
            process.wait()
        return code, acceptance

    def calls(self):
        return json.loads((self.bundle / "state.json").read_text())["calls"]

    def failure(self):
        return json.loads((self.root / "evidence/failure.json").read_text())["failure"]

    def assert_preserved(self):
        self.assertEqual(sorted(p.name for p in self.root.iterdir()),
                         ["evidence", "home", "main", "store", "worktrees"])
        self.assertTrue((self.root / "worktrees/app/.git").is_file())

    def test_prepared_frontend_up_down_edit_up_is_accepted_and_disposed(self):
        code, acceptance = self.accept()
        self.assertEqual(code, 0, (self.root / "evidence").exists() and sorted(os.listdir(self.root / "evidence")))
        result = json.loads((self.root / "evidence/acceptance.json").read_text())
        self.assertEqual(result["containers"], ["c1", "c2"])
        self.assertEqual(result["base_id"], "development-fake")
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ["evidence"])
        ups = [c for c in self.calls() if c[:2] == ["hack-v5", "up"]]
        self.assertEqual(ups, [["hack-v5", "up", "--path", str(acceptance.project)]] * 2)
        downs = [c for c in self.calls() if c[:2] == ["hack-v5", "down"]]
        self.assertEqual(len(downs), 2)
        self.assertIn(["hack-native", "--candidate-root", str(acceptance.home), "runtime", "prepared-base", "remove",
                       "--base-id", "development-fake", "--store", str(acceptance.store), "--json"], self.calls())
        self.assertIn("PASS second HTTPS serves exactly the edited source", result["checks"])

    def test_a_stock_fallback_is_refused_and_state_kept(self):
        code, _ = self.accept(fault="stock-fallback")
        self.assertEqual(code, 1)
        self.assertIn("created the pool from the verified base", self.failure())
        self.assert_preserved()

    def test_a_share_other_than_the_worktree_is_refused(self):
        code, _ = self.accept(fault="wrong-share")
        self.assertEqual(code, 1)
        self.assertIn("shares exactly the worktree root", self.failure())

    def test_stale_source_after_the_edit_is_refused(self):
        code, _ = self.accept(stale=True)
        self.assertEqual(code, 1)
        self.assertIn("exactly the edited source", self.failure())
        self.assert_preserved()

    def test_a_lost_marker_is_refused(self):
        code, _ = self.accept(fault="lose-marker")
        self.assertEqual(code, 1)
        self.assertIn("marker is retained", self.failure())

    def test_a_pool_still_alive_after_down_keeps_everything(self):
        code, _ = self.accept(fault="still-alive")
        self.assertEqual(code, 1)
        self.assertIn("pool not confirmed stopped", self.failure())
        self.assert_preserved()

    def test_an_exhausted_budget_stops_without_cleanup(self):
        self.args.budget = 0.0
        code, _ = self.accept()
        self.assertEqual(code, 1)
        self.assertIn("live budget exhausted", self.failure())
        self.assertTrue((self.root / "main").exists())

    def test_only_declared_native_selections_reach_the_candidate(self):
        ambient = {"HACK_NATIVE_PREPARED_BASE": "off", "HACK_NATIVE_ALLOW_HOSTS": "example.invalid",
                   "HACK_NATIVE_HOME": "/elsewhere"}
        with mock.patch.dict(os.environ, ambient):
            code, acceptance = self.accept()
        self.assertEqual(code, 0)
        seen = json.loads((self.bundle / "state.json").read_text())["up_env"]
        self.assertEqual(seen, {k: v for k, v in acceptance.declared.items() if k.startswith("HACK_NATIVE_")})
        self.assertEqual((seen["HACK_NATIVE_PREPARED_BASE"], seen["HACK_NATIVE_HOME"]), ("require", str(acceptance.home)))

    def test_a_timed_out_command_fails_without_signalling_the_foreground(self):
        os.environ["FAKE_FAULT"] = "ps-hang"
        self.args.budget = 3.0
        acceptance = driver.Acceptance(self.args)
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(acceptance.run(), 1)
            self.assertIn("TimeoutExpired", self.failure())
            live = json.loads((self.root / "evidence/failure.json").read_text())["live_foregrounds"]
            (label, pid), = live
            self.assertEqual(label, "up-first")
            # Only the hung `ps` was killed; the foreground is still running, untouched.
            self.assertIsNone(acceptance.foregrounds[0][1].poll())
            self.assert_preserved()
        finally:
            for _, process in acceptance.foregrounds:
                if process.poll() is None:
                    process.kill()
                process.wait()

    def test_the_driver_naming_the_root_in_its_own_arguments_does_not_block_disposal(self):
        # As in a real run, the process running the driver names the root in its arguments.
        code = textwrap.dedent(f"""
            import argparse, importlib.util, sys
            spec = importlib.util.spec_from_file_location("driver", {str(source)!r})
            driver = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(driver)
            acceptance = driver.Acceptance(argparse.Namespace(**{vars(self.args)!r}))
            acceptance.fetch = lambda: (acceptance.project / "index.txt").read_text()
            acceptance.https_wait = 1
            sys.exit(acceptance.run())
        """)
        env = {k: v for k, v in os.environ.items() if k != "FAKE_FAULT"}
        result = subprocess.run([sys.executable, "-c", code, "--root", str(self.root)], env=env,
                                capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stdout[-800:])
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ["evidence"])

    def test_another_process_naming_the_root_blocks_disposal(self):
        bystander = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", str(self.root)])
        try:
            code, _ = self.accept()
            self.assertEqual(code, 1)
            self.assertIn("may still reference the acceptance root", self.failure())
            self.assert_preserved()
        finally:
            bystander.kill()
            bystander.wait()

    def test_the_preview_runs_nothing(self):
        argv = ["accept", "--bundle", str(self.bundle), "--root", str(self.root), "--provider-archive", "/p",
                "--engine-archive", "/e", "--network-tools", "/n", "--image", "example@sha256:" + "d" * 64,
                "--caddy", "/caddy", "--https-port", "41443"]
        with mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(driver.main(), 0)
        self.assertEqual(json.loads(out.getvalue())["preview"]["https_port"], 41443)
        self.assertFalse((self.bundle / "state.json").exists())
        self.assertEqual(list(self.root.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
