"""Failure controls for the prepared-base startup harness."""
import argparse
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile
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
        def pair(index, lane, wall, admitted):
            return {
                "mode": "pairs", "index": index, "lane": lane, "ok": True, "service_ready_s": wall,
                "admission": {"admitted": admitted}, "disks_at_ready": {}, "cleanup": {"removed": True},
                "samples": {"up": {"wall_s": wall, "cli_cpu_s": 1}, "restart_up": {"wall_s": 1}},
            }

        records = [
            pair(0, "stock", 10, True), pair(0, "prepared", 5, True),
            pair(1, "stock", 10, False), pair(1, "prepared", 1, True),
            {"mode": "cohort", "size": 8, "lane": "stock", "ok": False, "error": "x", "cleanup": {"error": "left"}},
        ]
        summary = benchmark.summarize(records)
        self.assertEqual(summary["admitted_pair_up_wall_ratio"], {"n": 1, "median": 0.5, "min": 0.5, "max": 0.5})
        self.assertEqual(summary["pairs_flagged"]["stock"]["up_wall_s"]["n"], 1)
        self.assertEqual(summary["failures"][0]["error"], "x")
        self.assertEqual(len(summary["cleanup_failures"]), 1)


if __name__ == "__main__":
    unittest.main()
