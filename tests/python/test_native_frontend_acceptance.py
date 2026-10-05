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
import fcntl, json, os, pathlib, secrets, subprocess, sys, time
here = pathlib.Path(__file__).parent
name = pathlib.Path(__file__).name
path = here / "state.json"
fault = os.environ.get("FAKE_FAULT", "")
# Invocations run concurrently (a foreground `up` while the driver polls `ps`). Each holds this
# exclusive lock across its read-modify-write of the shared state, so no invocation saves a stale
# copy over another's update; it is released only before a long wait.
lock = open(here / "state.lock", "a")
fcntl.flock(lock, fcntl.LOCK_EX)


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
    if argv[:2] == ["graph", "inspect"]:
        volume = "wrong" if fault == "replace-volume" and state["container"] > 2 else "data-volume"
        reply({"receipt": {"run": state["run"], "owner": "owner", "plan_id": "plan", "phase": "ready-observed",
               "resources": {"volume:data": {"kind": "volume", "name": volume},
                             "container:web": {"kind": "container", "routing": {"hostnames": state["routes"]}}}}})
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
if argv[0] in ("up", "restart"):
    if os.environ.get("HACK_NATIVE_PREPARED_BASE") != "require" or not os.environ.get("HACK_NATIVE_PREPARED_BASE_STORE"):
        reply("prepared base not requested", 2)
    token = secrets.token_hex(4)
    state = load()
    project = pathlib.Path(option("--path"))
    branch = subprocess.check_output(["git", "-C", str(project), "branch", "--show-current"], text=True).strip()
    compose = (project / ".hack/docker-compose.yml").read_text()
    hosts = next(line.strip()[7:] for line in compose.splitlines() if line.strip().startswith("caddy: ")).split(", ")
    routes = [host.replace("frontend-accept.", branch + ".frontend-accept.") for host in hosts]
    if fault == "missing-alias" and state.get("container", 0) >= 2:
        routes = [host for host in routes if not host.endswith("hack.gy")]
    state.update(foreground=token, alive=True, share=option("--path"), container=state.get("container", 0) + 1,
                 routes=routes,
                 up_env={k: v for k, v in os.environ.items() if k.startswith("HACK_NATIVE_")})
    state.setdefault("run", secrets.token_hex(16))
    save(state)
    fcntl.flock(lock, fcntl.LOCK_UN)
    deadline = time.time() + 30
    while time.time() < deadline:
        time.sleep(0.02)
        if load().get("foreground") != token:
            sys.exit(0)
    sys.exit(3)
if argv[0] == "doctor":
    project = pathlib.Path.cwd()
    config = project / ".hack/hack.config.json"
    compose = project / ".hack/docker-compose.yml"
    action = option("--domain-migration")
    if action == "preview":
        reply({"status": "preview"})
    if action == "apply":
        state["original"] = [config.read_text(), compose.read_text()]
        value = json.loads(config.read_text())
        value["dev_host"] = "frontend-accept.hack.local"
        config.write_text(json.dumps(value))
        contents = compose.read_text().replace("      caddy: ", "      caddy: frontend-accept.hack.local, api.frontend-accept.hack.local, ")
        compose.write_text(contents)
        state["migrated"] = [config.read_text(), compose.read_text()]
        save(state)
        reply({"status": "applied", "toHost": "frontend-accept.hack.local"})
    if action == "rollback":
        if [config.read_text(), compose.read_text()] != state["migrated"] and fault != "overwrite-drift":
            reply("Project domain migration refused: independent drift", 1)
        config.write_text(state["original"][0])
        compose.write_text(state["original"][1] + ("\n# wrong rollback\n" if fault == "wrong-rollback" else ""))
        reply({"status": "restored"})
if argv[0] == "ps":
    if fault == "ps-hang":
        fcntl.flock(lock, fcntl.LOCK_UN)
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
            if acceptance.domain_migration:
                state = json.loads((self.bundle / "state.json").read_text())
                if acceptance.host not in state["routes"]:
                    return None
            body = (acceptance.project / "index.txt").read_text()
            first.append(body)
            return first[0] if stale else body

        acceptance.fetch = fetch
        acceptance.removed_route = lambda host: host not in json.loads((self.bundle / "state.json").read_text())["routes"]
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

    def test_domain_alias_migration_and_rollback_use_inferred_branch_and_preserve_data(self):
        self.args.domain_migration = True
        code, acceptance = self.accept()
        self.assertEqual(code, 0, self.failure() if code else "")
        proof = json.loads((self.root / "evidence/domain-roundtrip.json").read_text())
        self.assertTrue(proof["original_files_restored"])
        self.assertTrue(proof["primary_unchanged"])
        self.assertFalse(proof["browser_verified"])
        self.assertFalse(proof["dns_verified"])
        self.assertEqual(proof["removed_routes"],
                         sorted([f"api.{acceptance.branch}.frontend-accept.hack.local",
                                 f"{acceptance.branch}.frontend-accept.hack.local"]))
        restarts = [c for c in self.calls() if c[:2] == ["hack-v5", "restart"]]
        self.assertEqual(restarts, [["hack-v5", "restart", "--path", str(acceptance.project)]] * 2)
        result = json.loads((self.root / "evidence/acceptance.json").read_text())
        self.assertEqual(result["containers"], ["c1", "c4"])

    def test_domain_mode_refuses_a_replaced_volume_even_with_the_marker(self):
        self.args.domain_migration = True
        code, _ = self.accept(fault="replace-volume")
        self.assertEqual(code, 1)
        self.assertIn("retains run, ownership and exact volume bindings", self.failure())
        self.assert_preserved()

    def test_domain_mode_refuses_lost_oauth_aliases(self):
        self.args.domain_migration = True
        code, _ = self.accept(fault="missing-alias")
        self.assertEqual(code, 1)
        self.assertIn("publishes exactly the expected branch routes", self.failure())

    def test_domain_mode_does_not_accept_rollback_that_overwrites_user_edits(self):
        self.args.domain_migration = True
        code, _ = self.accept(fault="overwrite-drift")
        self.assertEqual(code, 1)
        self.assertIn("rollback refuses independent file drift", self.failure())

    def test_domain_mode_requires_exact_original_file_restoration(self):
        self.args.domain_migration = True
        code, _ = self.accept(fault="wrong-rollback")
        self.assertEqual(code, 1)
        self.assertIn("restores exact original bytes and modes", self.failure())

    def test_removed_route_requires_route_rejection_not_transport_failure(self):
        acceptance = driver.Acceptance(self.args)
        root = acceptance.home / "native-https/root.crt"
        root.parent.mkdir(parents=True)
        root.write_text("test root")
        acceptance.deadline = driver.time.monotonic() + 60
        for code, status, expected in [(35, "000", True), (0, "404", True), (0, "421", True),
                                       (0, "200", False), (7, "000", False), (28, "000", False),
                                       (60, "000", False)]:
            with self.subTest(code=code, status=status), mock.patch.object(driver.subprocess, "run") as run:
                run.return_value = subprocess.CompletedProcess([], code, ("body\n" + status).encode(), b"")
                self.assertEqual(acceptance.removed_route("removed.example"), expected)

    def observation(self):
        acceptance = driver.Acceptance(self.args)
        acceptance.evidence.mkdir()
        acceptance.deadline = driver.time.monotonic() + 5
        acceptance.observation_wait = 0.25
        return acceptance

    def test_provider_busy_observation_retries_once_and_preserves_both_attempts(self):
        acceptance = self.observation()
        busy = subprocess.CompletedProcess([], 2, b"", b'{"code":"provider_busy","message":"held"}')
        ready = subprocess.CompletedProcess([], 0, b'{"phase":"ready-observed"}', b"")
        with mock.patch.object(driver.subprocess, "run", side_effect=[busy, ready]) as run:
            result = acceptance.observe("inspect", "graph", "inspect", "--run-id", "a" * 32, "--json")
        self.assertEqual(result, {"phase": "ready-observed"})
        self.assertEqual(run.call_count, 2)
        self.assertEqual((acceptance.evidence / "inspect.attempt-1.stderr").read_bytes(), busy.stderr)
        self.assertEqual((acceptance.evidence / "inspect.attempt-2.stdout").read_bytes(), ready.stdout)
        self.assertEqual((acceptance.evidence / "inspect.attempt-1.json").read_text(), '{"exit_code": 2}')
        self.assertEqual((acceptance.evidence / "inspect.stdout").read_bytes(), ready.stdout)

    def test_observation_does_not_retry_unstructured_other_or_malformed_errors(self):
        acceptance = self.observation()
        failures = [
            subprocess.CompletedProcess([], 2, b"", b'{"code":"engine_protocol","message":"failed"}'),
            subprocess.CompletedProcess([], 2, b"", b'provider_busy'),
            subprocess.CompletedProcess([], 2, b"", b'{"code":"provider_busy"}'),
            subprocess.CompletedProcess([], 2, b"", b'{"code":"provider_busy","message":7}'),
            subprocess.CompletedProcess([], 2, b"", b'{"code":"engine_protocol","code":"provider_busy","message":"held"}'),
            subprocess.CompletedProcess([], 2, b"unexpected", b'{"code":"provider_busy","message":"held"}'),
            subprocess.CompletedProcess([], 1, b"", b'{"code":"provider_busy","message":"held"}'),
            subprocess.CompletedProcess([], 2, b"", b"x" * 8193),
        ]
        for failure in failures:
            with self.subTest(failure=failure), mock.patch.object(driver.subprocess, "run", return_value=failure) as run:
                with self.assertRaisesRegex(driver.Failure, "non-retryable observation"):
                    acceptance.observe("status", "runtime", "status", "--json")
                self.assertEqual(run.call_count, 1)

    def test_busy_observation_stops_at_its_budget(self):
        acceptance = self.observation()
        busy = subprocess.CompletedProcess([], 2, b"", b'{"code":"provider_busy","message":"held"}')
        with mock.patch.object(driver.subprocess, "run", return_value=busy) as run:
            with self.assertRaisesRegex(driver.Failure, "provider_busy observation deadline"):
                acceptance.observe("status", "runtime", "status", "--json")
        self.assertGreater(run.call_count, 1)
        self.assertLessEqual(run.call_count, 4)
        self.assertTrue((acceptance.evidence / "status.attempt-2.json").exists())

    def test_malformed_successful_observation_is_not_retried(self):
        acceptance = self.observation()
        for output in [b'[]', b'{', b'', b'{"phase":"stopped","phase":"ready-observed"}']:
            with self.subTest(output=output), mock.patch.object(driver.subprocess, "run") as run:
                run.return_value = subprocess.CompletedProcess([], 0, output, b"")
                with self.assertRaises((driver.Failure, ValueError)):
                    acceptance.observe("status", "runtime", "status", "--json")
                self.assertEqual(run.call_count, 1)

    def test_mutations_exec_and_refresh_never_enter_observation_retry(self):
        acceptance = self.observation()
        for argv in [("runtime", "down", "--json"), ("graph", "exec", "--run-id", "a" * 32, "--json"),
                     ("graph", "refresh-dependencies", "--run-id", "a" * 32, "--json"),
                     ("graph", "inspect", "--run-id", "../foreign", "--json")]:
            with self.subTest(argv=argv), mock.patch.object(driver.subprocess, "run") as run:
                with self.assertRaisesRegex(driver.Failure, "restricted to"):
                    acceptance.observe("refused", *argv)
                run.assert_not_called()

    def test_observation_timeout_is_not_retried(self):
        acceptance = self.observation()
        with mock.patch.object(driver.subprocess, "run", side_effect=subprocess.TimeoutExpired([], 1)) as run:
            with self.assertRaises(subprocess.TimeoutExpired):
                acceptance.observe("status", "runtime", "status", "--json")
            self.assertEqual(run.call_count, 1)
        self.assertEqual(json.loads((acceptance.evidence / "status.attempt-1.json").read_text()), {"timed_out": True})


if __name__ == "__main__":
    unittest.main()
