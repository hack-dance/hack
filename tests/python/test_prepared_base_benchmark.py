"""Failure controls for the prepared-base startup harness."""
import argparse
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile
import time
import unittest

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
        while len(sampler.samples) < 3:
            time.sleep(0.001)
        during = sampler.stop()
        self.assertGreaterEqual(during["samples"], 3)
        self.assertEqual((during["reasons"], during["admitted"]), (["load_high"], False))
        ok, reasons, boundary = benchmark.admitted({"admission": CLEAN, "admission_during": during, "admission_end": CLEAN}, 16)
        self.assertEqual((ok, reasons, boundary), (False, ["during:load_high"], "continuous"))

    def test_a_sampler_without_samples_is_unobserved_not_admitted(self):
        result = benchmark.Sampler(1.0).result()
        self.assertEqual((result["reasons"], result["admitted"]), (["unobserved"], False))

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


if __name__ == "__main__":
    unittest.main()
