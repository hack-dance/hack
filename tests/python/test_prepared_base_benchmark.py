"""Failure controls for the prepared-base startup harness."""
import argparse
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

source = Path(__file__).resolve().parents[2] / "scripts/benchmark-prepared-base.py"
spec = importlib.util.spec_from_file_location("prepared_base_benchmark", source)
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)

# A stand-in bundle: logs its argv and replays scripted JSON responses in order.
FAKE = """#!{python}
import json, pathlib, sys
here = pathlib.Path(__file__).parent
with open(here / "argv.log", "a") as log:
    log.write(json.dumps(sys.argv[1:]) + "\\n")
responses = json.loads((here / "responses.json").read_text())
count = here / "count"
index = int(count.read_text()) if count.exists() else 0
count.write_text(str(index + 1))
code, body = responses[min(index, len(responses) - 1)]
print(json.dumps(body))
sys.exit(code)
"""


class Harness(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="hack-prepared-bench-"))
        self.bundle = self.root / "bundle"
        self.bundle.write_text(FAKE.format(python=sys.executable))
        self.bundle.chmod(0o700)
        self.args = argparse.Namespace(bundle=str(self.bundle), root=str(self.root), store="/store", profile="development")
        self.trial = benchmark.Trial(self.args, "control")

    def tearDown(self):
        shutil.rmtree(self.root)

    def respond(self, *responses):
        (self.root / "responses.json").write_text(json.dumps(list(responses)))

    def argv(self):
        return [json.loads(line) for line in (self.root / "argv.log").read_text().splitlines()]

    def test_json_output_precedes_the_program_separator(self):
        self.respond([0, {}])
        self.trial.cli("graph", "exec", "--run-id", "r", "--", "/bin/cat", "/data/token")
        self.trial.cli("runtime", "prepare", "--archive", "/a", json_output=False)
        exec_argv, prepare_argv = self.argv()
        self.assertEqual(exec_argv[-4:], ["--json", "--", "/bin/cat", "/data/token"])
        self.assertNotIn("--json", prepare_argv)

    def test_busy_attempts_are_retried_counted_and_timed_together(self):
        busy = [2, {"code": "provider_busy"}]
        self.respond(busy, busy, [0, {"phase": "ready"}])
        self.trial.step("run", "graph", "run")
        self.assertEqual(self.trial.samples["run"]["busy_retries"], 2)
        self.assertEqual(len(self.argv()), 3)

    def test_other_failures_are_not_retried(self):
        self.respond([2, {"code": "provider_down"}], [0, {}])
        with self.assertRaises(benchmark.Failure):
            self.trial.step("run", "graph", "run")
        self.assertEqual(len(self.argv()), 1)

    def test_a_stock_fallback_never_counts_as_a_prepared_sample(self):
        fallback = {"phase": "running", "prepared_base": {"selection": {"source": "stock"}, "activation": None}}
        self.respond([0, fallback])
        with self.assertRaisesRegex(benchmark.Failure, "did not start from the base"):
            self.trial.up("up", "prepared")
        self.assertIn("--prepared-base", self.argv()[0])
        self.respond([0, fallback])
        with self.assertRaisesRegex(benchmark.Failure, "stock lane"):
            self.trial.up("up", "stock")

    def test_provider_accounting_counts_each_returned_process_once(self):
        def usage(pid, executable, cpu, resident):
            return {"identity": {"pid": pid, "start_micros": pid * 10, "uid": 501, "executable": executable},
                    "resident_bytes": resident, "physical_footprint_bytes": resident,
                    "user_cpu_nanoseconds": cpu, "system_cpu_nanoseconds": cpu}

        provider = usage(4000001, str(self.trial.home / ".hack-local/providers/smolvm/smolvm-bin"), 500_000_000, 100)
        helper = usage(4000002, "/usr/libexec/stand-in-helper", 250_000_000, 10)
        observed = self.trial.provider({"provider_resources": {"processes": [provider, helper, helper]}})
        self.assertEqual((observed["vm_cpu_s"], observed["vm_resident_bytes"], observed["tree_processes"],
                          observed["tree_helpers"]), (1.5, 110, 2, 1))
        # Without this home's provider binary the tree is not owned, however it is spelled.
        lookalike = usage(4000003, str(self.trial.home / ".hack-local/providers-other/smolvm-bin"), 1, 1)
        self.assertEqual(self.trial.provider({"provider_resources": {"processes": [lookalike, helper]}}), {})

    def test_cleanup_of_an_uncreated_trial_touches_nothing(self):
        self.assertEqual(self.trial.cleanup(), {"removed": True, "created": False})
        self.assertFalse((self.root / "argv.log").exists())

    def test_flagged_pairs_are_excluded_from_the_admitted_ratio(self):
        records = [
            pair(0, "stock", 10, CLEAN), pair(0, "prepared", 5, CLEAN),
            pair(1, "stock", 10, LOADED), pair(1, "prepared", 1, CLEAN),
            {"mode": "cohort", "size": 8, "lane": "stock", "ok": False, "error": "x", "cleanup": {"error": "left"}},
        ]
        summary = benchmark.summarize(records, 16)
        ratio = summary["admitted_pair_ratios"]["up_wall"]
        self.assertEqual((ratio["n"], ratio["median"]), (1, 0.5))
        self.assertEqual(summary["pairs_flagged"]["stock"]["up_wall_s"]["n"], 1)
        self.assertIsNone(summary["pairs_flagged"]["prepared"])
        self.assertEqual(summary["failures"][0]["error"], "x")
        self.assertEqual(len(summary["cleanup_failures"]), 1)
        self.assertIn("start:load_high", summary["flag_reasons"])


# Pure admission, summary and coverage controls; no processes.
CLEAN = benchmark.admission_from(1.0, ["zsh"], "1", 16)
LOADED = benchmark.admission_from(12.0, ["zsh"], "1", 16)


def pair(index, lane, wall, admission, vm_cpu=1.0, private=1):
    up = {"wall_s": wall, "cli_cpu_s": 1.0}
    if vm_cpu is not None:
        up["vm_cpu_s"] = vm_cpu
    return {
        "mode": "pairs", "index": index, "lane": lane, "ok": True, "service_ready_s": wall,
        "admission": admission, "admission_end": CLEAN,
        "disks_at_ready": {"storage.raw": {"allocated": 2, "private": private}},
        "cleanup": {"removed": True, "allocated_after_down": 3},
        "samples": {"up": up, "restart_up": {"wall_s": 1}},
    }


def cohort(size, repeat, lane, all_ready, admission):
    return {
        "mode": "cohort", "size": size, "repeat": repeat, "lane": lane, "ok": True, "all_ready_s": all_ready,
        "admission": admission, "admission_end": CLEAN, "after_all_ready": {"vm_cpu_s": 2.0},
        "disks_at_ready": {}, "cleanup": {"removed": True}, "samples": {"up": {"wall_s": 1, "cli_cpu_s": 1}},
    }


class Accounting(unittest.TestCase):
    def test_unobserved_admission_inputs_fail_closed_with_reasons(self):
        cases = {
            "load_unobserved": (None, ["zsh"], "1"),
            "load_high": (9.0, ["zsh"], "1"),
            "processes_unobserved": (1.0, None, "1"),
            "build_tools": (1.0, ["/usr/bin/cargo", "zsh"], "1"),
            "pressure_unobserved": (1.0, ["zsh"], ""),
            "memory_pressure": (1.0, ["zsh"], "4"),
        }
        for reason, (load, names, pressure) in cases.items():
            observed = benchmark.admission_from(load, names, pressure, 16)
            self.assertFalse(observed["admitted"], reason)
            self.assertEqual(observed["reasons"], [reason])
        self.assertIsNone(benchmark.admission_from(1.0, ["zsh"], None, 16)["memory_pressure"])
        self.assertTrue(CLEAN["admitted"])

    def test_legacy_start_only_records_are_reevaluated_not_trusted(self):
        legacy = {"load1": 1.0, "build_tools": [], "memory_pressure": "", "admitted": True}
        ok, reasons, boundary = benchmark.admitted({"admission": legacy}, 16)
        self.assertFalse(ok)
        self.assertEqual(reasons, ["start:pressure_unobserved"])
        self.assertTrue(boundary.startswith("start-only (legacy"))
        ok, _, boundary = benchmark.admitted({"admission": dict(legacy, memory_pressure="1")}, 16)
        self.assertTrue(ok)
        ok, reasons, _ = benchmark.admitted({"admission": CLEAN, "admission_end": LOADED}, 16)
        self.assertEqual((ok, reasons), (False, ["end:load_high"]))

    def test_continuous_admission_flags_any_failed_sample_during_timed_work(self):
        observations = iter([CLEAN, LOADED] + [CLEAN] * 1000)
        sampler = benchmark.Sampler(0.001, observe=lambda: next(observations)).start()
        deadline = time.monotonic() + 5
        while len(sampler.samples) < 3 and time.monotonic() < deadline:
            time.sleep(0.001)
        during = sampler.stop()
        self.assertGreaterEqual(during["samples"], 3)
        self.assertEqual((during["reasons"], during["admitted"]), (["load_high"], False))
        ok, reasons, boundary = benchmark.admitted({"admission": CLEAN, "admission_during": during, "admission_end": CLEAN}, 16)
        self.assertEqual((ok, reasons, boundary), (False, ["during:load_high"], "continuous"))

    def test_a_sampler_without_samples_is_unobserved_not_admitted(self):
        result = benchmark.Sampler(1.0).result()
        self.assertEqual((result["reasons"], result["admitted"]), (["unobserved"], False))

    def test_a_failing_observer_flags_the_trial_and_sampling_continues(self):
        calls = []

        def observe():
            calls.append(1)
            if len(calls) == 2:
                raise OSError("ps unavailable")
            return CLEAN

        sampler = benchmark.Sampler(0.001, observe=observe).start()
        deadline = time.monotonic() + 5
        while len(sampler.samples) < 3 and time.monotonic() < deadline:
            time.sleep(0.001)
        during = sampler.stop()
        self.assertEqual((during["reasons"], during["admitted"]), (["observer_failed"], False))
        self.assertGreaterEqual(during["samples"], 3)

    def test_unobserved_gaps_flag_the_trial(self):
        def sampler(times, stopped):
            observed = benchmark.Sampler(1.0)
            observed.started, observed.times, observed.stopped = 0.0, times, stopped
            observed.samples = [CLEAN] * len(times)
            return observed.result()

        steady = sampler([0.1, 1.1, 2.1, 3.1], 3.5)
        self.assertEqual((steady["reasons"], steady["max_gap_s"]), ([], 1.0))
        for times, stopped in (([0.1, 7.0], 7.5), ([0.1, 1.1], 9.0), ([6.0], 6.5)):
            self.assertEqual(sampler(times, stopped)["reasons"], ["sampling_gap"], (times, stopped))

    def test_cohorts_are_split_by_admission_and_paired_by_size_and_repeat(self):
        records = [
            cohort(8, 0, "stock", 20.0, CLEAN), cohort(8, 0, "prepared", 10.0, CLEAN),
            cohort(8, 1, "stock", 30.0, LOADED), cohort(8, 1, "prepared", 10.0, CLEAN),
            cohort(32, 0, "stock", 60.0, CLEAN),
        ]
        summary = benchmark.summarize(records, 16)
        self.assertEqual(summary["cohorts_admitted"]["8"]["stock"]["all_ready_s"]["n"], 1)
        self.assertEqual(summary["cohorts_admitted"]["8"]["prepared"]["all_ready_s"]["n"], 2)
        self.assertEqual(summary["cohorts_flagged"]["8"]["stock"]["all_ready_s"]["median"], 30.0)
        ratio = summary["admitted_cohort_all_ready_ratio_by_size"]
        self.assertEqual((ratio["8"]["n"], ratio["8"]["median"]), (1, 0.5))
        self.assertNotIn("32", ratio)

    def test_unobserved_resources_stay_null_and_unqualified(self):
        summary = benchmark.summarize([pair(0, "stock", 10, CLEAN, vm_cpu=None, private=None), pair(0, "prepared", 5, CLEAN)], 16)
        stock, prepared = summary["pairs_admitted"]["stock"], summary["pairs_admitted"]["prepared"]
        for metric in ("up_cpu_s", "disk_private_bytes"):
            self.assertEqual({k: stock[metric][k] for k in ("n", "of", "qualified")}, {"n": 0, "of": 1, "qualified": False})
            self.assertNotIn("median", stock[metric])
            self.assertTrue(prepared[metric]["qualified"])
        self.assertEqual(prepared["up_cpu_s"]["median"], 2.0)


# A stand-in runtime for worktree trials, with one state file per candidate home. Graphs serve
# the files of the worktree they were started from; FAKE_FAULT injects the failures the trial
# must catch.
FAKE_RUNTIME = r'''#!PYTHON
import base64, hashlib, json, os, pathlib, secrets, sys

argv = sys.argv[1:]
home, argv = pathlib.Path(argv[1]), [a for a in argv[2:] if a != "--json"]
with open(pathlib.Path(__file__).with_name("argv.log"), "a") as log:
    log.write(json.dumps(argv) + "\n")
path = home / "fake.json"
state = json.loads(path.read_text()) if path.exists() else {"boots": 0, "runs": {}}
fault = os.environ.get("FAKE_FAULT", "")


def option(name):
    return argv[argv.index(name) + 1] if name in argv else None


def current_plan():
    """Like the real planner, the plan identity covers the source inventory."""
    root = pathlib.Path(option("--project"))
    files = sorted(p for p in root.rglob("*") if p.is_file() and ".git" not in p.relative_to(root).parts)
    inventory = [str(p.relative_to(root)) + ":" + p.read_text() for p in files]
    return "p" + hashlib.sha256(json.dumps([str(root), option("--branch"), inventory]).encode()).hexdigest()[:16]


def usage(pid, executable, cpu, resident, footprint):
    return {"identity": {"pid": pid, "start_micros": pid * 10, "uid": 501, "executable": executable},
            "resident_bytes": resident, "physical_footprint_bytes": footprint,
            "user_cpu_nanoseconds": cpu, "system_cpu_nanoseconds": 0}


def reply(body, code=0):
    path.write_text(json.dumps(state))
    print(json.dumps(body))
    sys.exit(code)


command = argv[:2]
if command == ["runtime", "up"]:
    state["boots"] += 1
    state["alive"] = True
    body = {"phase": "running"}
    if "--prepared-base" in argv:
        body["prepared_base"] = {"selection": {"mode": "require", "source": "prepared", "base_id": "b" * 64},
                                 "activation": "consumed"}
    reply(body)
if command == ["runtime", "status"]:
    trial, alive = home.parent.name, bool(state.get("alive"))
    # The root provider, a helper descendant outside the providers directory, and a repeat.
    root = usage(4000001, str(home / ".hack-local/providers/smolvm/smolvm-bin"), 1_000_000_000, 100, 80)
    helper = usage(4000002, "/usr/libexec/stand-in-helper", 500_000_000, 10, 8)
    reply({"phase": "running" if alive else "stopped", "process_alive": alive, "machine": "m-" + trial,
           "guest_boot_id": f"{trial}-{state['boots']}", "guest_memory_mib": 6144,
           "provider_resources": {"processes": [root, helper, helper] if alive else []}})
if command == ["runtime", "down"]:
    if fault == "down-fails":
        reply({"code": "provider_down"}, 1)
    if fault == "drift-on-down":
        for run in state["runs"].values():
            (pathlib.Path(run["root"]) / "drift.txt").write_text("changed while down")
    # `still-alive`: down reports success but the VM process is still observed.
    state["alive"] = fault == "still-alive"
    reply({"phase": "stopped"})
if command == ["runtime", "ensure-image"]:
    reply({"image_id": "sha256:" + "a" * 64})
if command == ["project", "plan"]:
    namespace = hashlib.sha256((option("--project") + option("--branch")).encode()).hexdigest()
    reply({"plan_id": current_plan(), "plan": {"namespace": namespace}})
if command in (["graph", "run"], ["graph", "restore"]) and option("--expect-plan") != current_plan():
    reply({"code": "execution_plan_changed"}, 2)
if command == ["graph", "run"]:
    token = "c" * 32 if fault == "shared-token" else secrets.token_hex(16)
    state["runs"][option("--run-id")] = {"root": option("--project"), "token": token, "plan": option("--expect-plan"),
                                         "shared": "--shared-source" in argv, "normalized": "--normalized-file" in argv}
    reply({"readiness": {"web": "healthy"}})
if command == ["graph", "restore"]:
    run = state["runs"].get(option("--run-id"))
    if not run or run["root"] != option("--project"):
        reply({"code": "graph_restore_refused"}, 2)
    # As in the runtime: a changed review restores only a shared, normalized receipt, whose
    # compatibility contract is honored; a raw receipt restores only its exact source.
    if option("--expect-plan") != run["plan"] and not (run["shared"] and run["normalized"]):
        reply({"code": "graph_shared_source",
               "message": "Changed shared-source review has no retained compatibility contract."}, 2)
    if fault == "lose-data":
        run["token"] = secrets.token_hex(16)
    reply({"readiness": {"web": "starting" if fault == "restore-unready" else "healthy"}})
if command == ["graph", "exec"]:
    run = state["runs"][option("--run-id")]
    if argv[-1] == "/data/token":
        data = run["token"]
    else:
        root = pathlib.Path(run["root"])
        if fault == "cross-source" or (fault == "cross-live" and argv[-1] == "/workspace/live.txt"):
            siblings = sorted(p for p in root.parent.iterdir() if p.name.startswith("w"))
            root = siblings[(siblings.index(root) + 1) % len(siblings)]
        data = (root / argv[-1][len("/workspace/"):]).read_text()
    reply({"exit_code": 0, "stdout_base64": base64.b64encode(data.encode()).decode()})
reply({})
'''


class WorktreeTrials(unittest.TestCase):
    """Real linked worktrees against the stand-in runtime: the passing path and each source,
    isolation and retention failure, all ending with the owned homes and fixture removed."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="hack-worktree-bench-")).resolve()
        self.tools = Path(tempfile.mkdtemp(prefix="hack-worktree-fake-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.addCleanup(shutil.rmtree, self.tools, True)
        self.addCleanup(os.environ.pop, "FAKE_FAULT", None)
        bundle = self.tools / "bundle"
        bundle.write_text(FAKE_RUNTIME.replace("PYTHON", sys.executable, 1))
        bundle.chmod(0o700)
        self.args = argparse.Namespace(
            bundle=str(bundle), root=str(self.root), store="/store", profile="development",
            image="example@sha256:" + "d" * 64, provider_archive="/p", engine_archive="/e", network_tools="/n",
            admission_interval=1.0, worktree_parallel=2)
        benchmark.SEEN_BASES.clear()

    def trial(self, lane="prepared", fault=""):
        os.environ["FAKE_FAULT"] = fault
        record = benchmark.worktree_trial(self.args, 2, 0, lane)
        self.assertEqual(list(self.root.iterdir()), [])
        self.assertTrue(all(c.get("removed") for c in record["cleanup"]), record["cleanup"])
        return record

    def calls(self, *commands):
        lines = (self.tools / "argv.log").read_text().splitlines()
        return [c for c in map(json.loads, lines) if c[:2] in [list(command) for command in commands]]

    def test_each_worktree_is_shared_isolated_and_retained(self):
        record = self.trial()
        self.assertTrue(record["ok"], record.get("error"))
        self.assertEqual(record["isolation"], {"pools": 2, "namespaces": 2, "tokens": 2, "live_edits_read_back": 2})
        self.assertEqual({k: record["fixture"][k] for k in ("registered", "roots", "branches", "heads", "common_dirs")},
                         {"registered": 2, "roots": 2, "branches": 2, "heads": 2, "common_dirs": 1})
        self.assertEqual(record["retained"], 2)
        self.assertEqual(sorted(p["base_use"] for p in record["provenance"]), ["first-in-run", "repeat-in-run"])
        self.assertEqual({(p["start"], p["source"], p["base_use"]) for p in record["warm_provenance"]},
                         {("warm", "prepared", None)})
        ups = self.calls(("runtime", "up"))
        shares = [c[c.index("--project-share") + 1] for c in ups]
        self.assertEqual((len(ups), len(set(shares))), (4, 2))
        self.assertTrue(all("--unfiltered-source" in c and s.startswith(f"{self.root}/") for c, s in zip(ups, shares)))
        graphs = self.calls(("graph", "run"), ("graph", "restore"))
        self.assertEqual(len(graphs), 4)
        self.assertTrue(all("--shared-source" in c for c in graphs))
        self.assertEqual({c[c.index("--branch") + 1] for c in graphs}, {"wt-00", "wt-01"})
        # Each pool's tree is its provider plus one helper outside providers, returned twice.
        resources = record["resources"]
        self.assertEqual((resources["vm_cpu_s"], resources["vm_resident_bytes"], resources["vm_footprint_bytes"]),
                         (3.0, 220, 176))
        self.assertEqual({(vm["tree_processes"], vm["tree_helpers"]) for vm in resources["vms"]}, {(2, 1)})
        self.assertGreater(resources["cpu_attributed_s"], resources["vm_cpu_s"])
        self.assertEqual(resources["observed"]["kind"], "staggered-per-pool")
        self.assertLessEqual(resources["observed"]["from_s"], resources["observed"]["to_s"])
        # Warm restore keeps the run and its exact plan: the source is unchanged until the
        # post-restore host edit, which each restored pool then reads back.
        plans = {c[c.index("--run-id") + 1]: c[c.index("--expect-plan") + 1] for c in self.calls(("graph", "run"))}
        restores = self.calls(("graph", "restore"))
        self.assertEqual(len(restores), 2)
        for restore in restores:
            run = restore[restore.index("--run-id") + 1]
            self.assertEqual(restore[restore.index("--expect-plan") + 1], plans[run])

    def test_a_host_edit_reaching_another_pool_fails_after_restore(self):
        record = self.trial(fault="cross-live")
        self.assertFalse(record["ok"])
        self.assertIn("did not reach exactly its own pool", record["error"])
        self.assertEqual(record["retained"], 2)

    def test_source_drift_before_restore_fails_before_any_restore_effect(self):
        record = self.trial(fault="drift-on-down")
        self.assertFalse(record["ok"])
        self.assertIn("source changed since its run", record["error"])
        self.assertEqual(self.calls(("graph", "restore")), [])

    def test_an_unready_restore_fails_even_when_reads_succeed(self):
        record = self.trial(fault="restore-unready")
        self.assertFalse(record["ok"])
        self.assertIn("restore: exit 0", record["error"])
        self.assertNotIn("warm_all_ready_s", record)

    def test_a_pool_serving_another_worktree_fails_before_readiness_counts(self):
        record = self.trial(lane="stock", fault="cross-source")
        self.assertFalse(record["ok"])
        self.assertIn("did not serve its own committed marker", record["error"])
        self.assertNotIn("all_ready_s", record)

    def test_shared_data_fails_isolation(self):
        record = self.trial(fault="shared-token")
        self.assertFalse(record["ok"])
        self.assertIn("isolation failed", record["error"])
        self.assertNotIn("warm_all_ready_s", record)

    def test_data_lost_across_down_up_fails_retention(self):
        record = self.trial(fault="lose-data")
        self.assertFalse(record["ok"])
        self.assertIn("did not retain data and source", record["error"])
        self.assertNotIn("retained", record)

    def assert_fixture_preserved(self, record, pool_error):
        """Every root keeps its registration, branch and committed marker, and every home stays."""
        *pools, fixture = record["cleanup"]
        self.assertTrue(all(pool_error in c.get("error", "") for c in pools), pools)
        self.assertIn("not confirmed disposed", fixture["error"])
        self.assertTrue(all(Path(home).is_dir() for home in record["homes"]))
        base = Path(fixture["preserved"])
        listed = subprocess.run(["git", "-C", str(base / "repo"), "worktree", "list", "--porcelain"],
                                capture_output=True, text=True, check=True).stdout
        for index in range(2):
            root = base / f"w{index:02d}"
            self.assertIn(f"worktree {root}\n", listed)
            self.assertIn(f"branch refs/heads/wt-{index:02d}\n", listed)
            committed = subprocess.run(["git", "-C", str(root), "show", "HEAD:branch.txt"],
                                       capture_output=True, text=True, check=True).stdout
            self.assertRegex(committed, r"^[0-9a-f]{32}$")
            self.assertEqual((root / "branch.txt").read_text(), committed)

    def test_failed_down_preserves_every_worktree_and_home(self):
        os.environ["FAKE_FAULT"] = "down-fails"
        record = benchmark.worktree_trial(self.args, 2, 0, "prepared")
        self.assertFalse(record["ok"])
        self.assert_fixture_preserved(record, "down failed")

    def test_a_vm_still_alive_after_down_preserves_every_worktree_and_home(self):
        os.environ["FAKE_FAULT"] = "still-alive"
        record = benchmark.worktree_trial(self.args, 2, 0, "prepared")
        self.assertTrue(record["ok"], record.get("error"))
        self.assertTrue(record["cleanup_failed"])
        self.assert_fixture_preserved(record, "not confirmed stopped")
        summary = benchmark.summarize([record], 16)
        self.assertTrue(summary["cleanup_failures"])
        # Its checks passed, but its measurements shared the host with a pool left alive.
        self.assertEqual((summary["worktrees_admitted"], summary["worktrees_flagged"]), ({}, {}))
        self.assertEqual(summary["worktrees_unqualified_cleanup"][0]["lane"], "prepared")

    def test_no_later_cohort_starts_after_a_cleanup_failure(self):
        os.environ["FAKE_FAULT"] = "still-alive"
        self.args.worktree_repeats = 2
        records = []
        self.assertFalse(benchmark.run_worktrees(self.args, [2, 1], records.append))
        self.assertEqual([(r["size"], r["repeat"], r["lane"]) for r in records], [(2, 0, "stock")])
        record = records[0]
        self.assert_fixture_preserved(record, "not confirmed stopped")
        # Nothing beyond the failed cohort's own fixture and homes was ever created.
        fixture = record["cleanup"][-1]["preserved"]
        self.assertEqual(sorted(p.name for p in self.root.iterdir()),
                         sorted([Path(fixture).name, *(Path(home).name for home in record["homes"])]))
        shares = [c[c.index("--project-share") + 1] for c in self.calls(("runtime", "up"))]
        self.assertEqual(len(shares), 4)
        self.assertTrue(all(share.startswith(fixture + "/") for share in shares))

    def test_every_planned_cohort_runs_when_cleanup_succeeds(self):
        self.args.worktree_repeats = 1
        records = []
        self.assertTrue(benchmark.run_worktrees(self.args, [1], records.append))
        self.assertEqual([(r["lane"], r["ok"], r["cleanup_failed"]) for r in records],
                         [("prepared", True, False), ("stock", True, False)])
        self.assertEqual(list(self.root.iterdir()), [])


class WorktreeFixture(unittest.TestCase):
    def test_worktrees_are_registered_linked_checkouts_on_their_own_branches(self):
        root = Path(tempfile.mkdtemp(prefix="hack-worktree-fixture-")).resolve()
        self.addCleanup(shutil.rmtree, root, True)
        fixture = benchmark.Worktrees(root, 3)
        entries = fixture.create()
        for entry in entries:
            self.assertTrue((entry["root"] / ".git").is_file(), "a linked worktree has a .git pointer file")
            self.assertEqual(entry["root"].stat().st_mode & 0o777, 0o700)
            self.assertEqual((entry["root"] / "branch.txt").read_text(), entry["marker"])
            current = subprocess.run(["git", "-C", str(entry["root"]), "branch", "--show-current"],
                                     capture_output=True, text=True, check=True).stdout.strip()
            self.assertEqual(current, entry["branch"])
        provenance = fixture.provenance()
        self.assertEqual({k: provenance[k] for k in ("registered", "roots", "branches", "heads", "common_dirs")},
                         {"registered": 3, "roots": 3, "branches": 3, "heads": 3, "common_dirs": 1})
        self.assertGreater(provenance["checkout_allocated_bytes"], 0)
        self.assertIn("preserved", fixture.cleanup(pools_disposed=False))
        self.assertTrue(all(entry["root"].is_dir() for entry in entries))
        self.assertEqual(fixture.cleanup(pools_disposed=True), {"removed": True})


class WorktreePlan(unittest.TestCase):
    def preview(self, *extra):
        argv = ["benchmark", "--image", "i", "--bundle", "/b", "--root", "/r", "--store", "/s",
                "--provider-archive", "/p", "--engine-archive", "/e", "--network-tools", "/n",
                "--mode", "worktrees", *extra]
        with mock.patch.object(sys, "argv", argv), mock.patch("sys.stdout", new_callable=io.StringIO) as out:
            benchmark.main()
        return json.loads(out.getvalue())["preview"]

    def test_configured_guest_maxima_warn_but_never_refuse(self):
        plan = benchmark.worktree_plan([1, 8, 32], 1, 4, "development", 128 << 30)
        self.assertEqual(plan["peak_configured_guest_memory_bytes"], 32 * 6144 << 20)
        self.assertEqual(plan["peak_configured_guest_cpus"], 128)
        self.assertIn("not measured footprint", plan["warning"])
        self.assertNotIn("warning", benchmark.worktree_plan([1, 8], 1, 4, "development", 128 << 30))
        self.assertNotIn("warning", benchmark.worktree_plan([32], 1, 4, "development", None))
        preview = self.preview()
        self.assertEqual(preview["pools_created"], 2 * (1 + 8 + 32))
        self.assertEqual(preview["worktrees"]["peak_simultaneous_pools"], 32)

    def test_worktree_mode_requires_the_development_profile(self):
        with self.assertRaises(SystemExit), mock.patch("sys.stderr", new_callable=io.StringIO):
            self.preview("--profile", "research")

    def test_configured_maxima_match_the_runtime_profiles(self):
        text = (source.parents[1] / "packages/runtime-core/src/provider/profile.rs").read_text()
        for function, table in (("memory_mib", benchmark.GUEST_MEMORY_MIB), ("cpus", benchmark.GUEST_CPUS)):
            body = re.search(rf"fn {function}\(self\)[^{{]*\{{(.*?)\n    \}}", text, re.S).group(1)
            self.assertEqual({name.lower(): int(value) for name, value in re.findall(r"Self::(\w+) => (\d+)", body)},
                             table)


def worktree_record(size, repeat, lane, all_ready, admission, resident=100):
    use = "first-in-run" if lane == "prepared" else None
    return {
        "mode": "worktrees", "size": size, "repeat": repeat, "lane": lane, "ok": True, "all_ready_s": all_ready,
        "warm_all_ready_s": all_ready / 2, "admission": admission, "admission_end": CLEAN,
        "provenance": [{"lane": lane, "start": "cold", "source": lane, "base_use": use}] * size,
        "warm_provenance": [{"lane": lane, "start": "warm", "source": lane, "base_use": None}] * size,
        "fixture": {"checkout_allocated_bytes": 10},
        "resources": {"cpu_attributed_s": 3.0, "vm_resident_bytes": resident, "vm_footprint_bytes": 80,
                      "guest_memory_configured_bytes": 6 << 30,
                      "observed": {"kind": "staggered-per-pool", "from_s": 5.0, "to_s": 5.5}},
        "samples": [{"up": {"wall_s": 2.0}, "restart_up": {"wall_s": 1.0}, "ensure_image": {"wall_s": 4.0}}] * size,
        "cleanup": [{"removed": True}],
    }


class WorktreeSummary(unittest.TestCase):
    def test_worktree_cohorts_split_by_admission_and_keep_cold_warm_and_memory_kinds_apart(self):
        records = [
            worktree_record(8, 0, "stock", 20.0, CLEAN), worktree_record(8, 0, "prepared", 10.0, CLEAN),
            worktree_record(8, 1, "stock", 30.0, LOADED), worktree_record(8, 1, "prepared", 10.0, CLEAN, resident=None),
        ]
        summary = benchmark.summarize(records, 16)
        prepared = summary["worktrees_admitted"]["8"]["prepared"]
        self.assertEqual(summary["worktrees_flagged"]["8"]["stock"]["all_ready_s"]["median"], 30.0)
        ratio = summary["admitted_worktree_all_ready_ratio_by_size"]["8"]
        self.assertEqual((ratio["n"], ratio["median"]), (1, 0.5))
        self.assertEqual((prepared["cold_up_median_s"]["median"], prepared["warm_up_median_s"]["median"]), (2.0, 1.0))
        self.assertEqual(prepared["vm_footprint_bytes"]["median"], 80)
        self.assertEqual({k: prepared["vm_resident_bytes"][k] for k in ("n", "of", "qualified")},
                         {"n": 1, "of": 2, "qualified": False})
        self.assertEqual(prepared["guest_memory_configured_bytes"]["median"], 6 << 30)
        self.assertEqual(prepared["resource_snapshot_span_s"]["median"], 0.5)
        self.assertEqual(summary["worktree_selections"]["prepared/cold/prepared/first-in-run"], 16)
        self.assertEqual(summary["worktree_selections"]["stock/warm/stock/None"], 16)


if __name__ == "__main__":
    unittest.main()
