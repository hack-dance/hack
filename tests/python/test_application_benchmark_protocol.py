"""Offline controls for the frozen matched application benchmark protocol; no live runs."""
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "scripts/check-application-benchmark-protocol.py"
SPEC = importlib.util.spec_from_file_location("application_benchmark_protocol", SOURCE)
protocol_check = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(protocol_check)

PROTOCOL = json.loads((ROOT / "scripts/application-benchmark-protocol.json").read_text())
PROTOCOL_DOC = (ROOT / "docs/reference/application-benchmark-protocol.md").read_text()
PERFORMANCE_DOC = (ROOT / "docs/performance.md").read_text()
MARKER = "PRIVATE-MARKER-9f2c"


def mutated(change):
    doc = copy.deepcopy(PROTOCOL)
    change(doc)
    return doc


def lane(doc, lane_id):
    return next(item for item in doc["lanes"] if item["id"] == lane_id)


def budget(doc, kind, metric):
    return next(item for item in doc["budgets"][kind] if item["metric"] == metric)


def entry(values, expected=None):
    return {"samples": list(values), "expected": len(values) if expected is None else expected}


def small_summary(candidate_scale=0.5, runs=10, tail=60):
    """A complete small-fixture summary where the candidate is `candidate_scale` of each baseline."""
    baselines = [item for item in PROTOCOL["workloads"][1]["lanes"] if item != "candidate"]
    base = {"steady_physical_footprint_bytes": 1000.0, "cpu_seconds_per_task": 10.0,
            "warm_startup_seconds": 20.0, "warm_restart_seconds": 10.0}
    lanes = {item: {metric: entry([value] * runs) for metric, value in base.items()} for item in baselines}
    lanes["candidate"] = {metric: entry([value * candidate_scale] * runs) for metric, value in base.items()}
    lanes["candidate"].update({
        "info_latency_ms": entry([50] * tail),
        "warm_admission_ms": entry([100] * tail),
        "cached_status_1000_objects_ms": entry([100] * tail),
        "idle_control_plane_core_fraction": entry([0.005] * runs),
        "watcher_ack_ms": entry([100] * tail),
    })
    return {"protocol_revision": 1, "workload": "small-fixture",
            "observer_cost": {metric: 0.0 for metric in base}, "lanes": lanes}


def verdicts(records, metric, baseline=None):
    return [record["verdict"] for record in records
            if record["metric"] == metric and record.get("baseline", baseline) == baseline]


class FrozenProtocolTest(unittest.TestCase):
    def test_frozen_protocol_is_valid(self):
        self.assertEqual(protocol_check.validate_protocol(PROTOCOL), [])

    def test_frozen_schedule_is_the_williams_design_for_the_frozen_lanes(self):
        lanes = [item["id"] for item in PROTOCOL["lanes"]]
        self.assertEqual(PROTOCOL["schedule"]["orders"], protocol_check.williams_orders(lanes))
        self.assertEqual(PROTOCOL["schedule"]["rounds_per_workload"], len(PROTOCOL["schedule"]["orders"]))
        self.assertGreaterEqual(len(PROTOCOL["schedule"]["orders"]), protocol_check.MIN_ROTATED_LIFECYCLE_RUNS)
        self.assertEqual(PROTOCOL["samples"]["min_lifecycle_runs_per_lane"], len(PROTOCOL["schedule"]["orders"]))

    def test_williams_design_balances_position_and_carryover(self):
        for count in range(2, 9):
            orders = protocol_check.williams_orders([f"lane{index}" for index in range(count)])
            self.assertEqual(len(orders), count * (2 if count % 2 else 1))
            self.assertTrue(protocol_check.position_balanced(orders), count)
            self.assertTrue(protocol_check.carryover_balanced(orders), count)

    def test_p95_sample_floor_is_the_distribution_free_bound(self):
        required = protocol_check.minimum_order_statistic_samples(0.95, 0.95)
        self.assertEqual(required, 59)
        self.assertLess(1 - 0.95 ** (required - 1), 0.95)
        self.assertGreaterEqual(1 - 0.95 ** required, 0.95)
        self.assertGreaterEqual(PROTOCOL["samples"]["p95_min_samples"], required)

    def test_nearest_rank_and_median(self):
        self.assertEqual(protocol_check.nearest_rank(list(range(1, 11)), 0.95), 10)
        self.assertEqual(protocol_check.nearest_rank(list(range(61, 0, -1)), 0.95), 58)
        self.assertEqual(protocol_check.nearest_rank(list(range(1, 61)), 0.95), 57)
        self.assertEqual(protocol_check.median([3, 1, 2]), 2)
        self.assertEqual(protocol_check.median([4, 1, 3, 2]), 2.5)

    def test_documents_carry_every_frozen_artifact_and_budget(self):
        for item in PROTOCOL["lanes"]:
            for field in ("commit", "asset", "asset_sha256", "tag"):
                if field in item:
                    self.assertIn(item[field], PROTOCOL_DOC, (item["id"], field))
        host = PROTOCOL["host"]
        for value in (host["cpu"], host["os"], host["docker_cli"], host["compose"],
                      host["orbstack"]["version"], host["orbstack"]["build"]):
            self.assertIn(str(value), PROTOCOL_DOC)
        for item in PROTOCOL["budgets"]["comparative"]:
            self.assertIn(f"`{item['metric']}`", PROTOCOL_DOC)
            self.assertIn(f"{item['max_ratio']:.2f}", PROTOCOL_DOC)
        for item in PROTOCOL["budgets"]["absolute"]:
            self.assertIn(f"`{item['metric']}`", PROTOCOL_DOC)
        self.assertIn(str(PROTOCOL["samples"]["p95_min_samples"]), PROTOCOL_DOC)
        limit = PROTOCOL["known_limits"][0]
        for value in (limit["issue"], "#313", f"{limit['warm_up_seconds']} s", f"{limit['witness_seconds']} s",
                      f"{limit['witness_target_seconds']} s", "HACK-1169"):
            self.assertIn(value, PERFORMANCE_DOC)
        self.assertIn("application-benchmark-protocol.md", PERFORMANCE_DOC)


class NegativeProtocolControls(unittest.TestCase):
    CASES = {
        "comparative_budget_weakened": lambda d: budget(d, "comparative", "steady_physical_footprint_bytes")
        .update(max_ratio=0.71),
        "absolute_budget_weakened": lambda d: budget(d, "absolute", "idle_control_plane_core_fraction")
        .update(inclusive=True),
        "comparative_budget_missing": lambda d: d["budgets"]["comparative"].pop(),
        "absolute_budget_missing": lambda d: d["budgets"]["absolute"].pop(),
        "statistic_unknown": lambda d: budget(d, "absolute", "info_latency_ms").update(statistic="mean"),
        "artifact_commit_malformed": lambda d: lane(d, "candidate").update(commit="28de2f89"),
        "artifact_digest_malformed": lambda d: lane(d, "hack-4.2.1").update(asset_sha256="0" * 63),
        "artifact_version_malformed": lambda d: lane(d, "hack-4.1.1").update(tag="v4.1.2"),
        "p95_samples_insufficient": lambda d: d["samples"].update(p95_min_samples=58),
        "observer_policy_missing": lambda d: d["observer"].update(inconclusive_factor=0.5),
        "observer_policy_missing:window": lambda d: d["observer"].update(control_window_seconds=599),
        "cache_class_missing": lambda d: d["cache_classes"].update(budget_class="cold-cache"),
        "workload_lane_unknown": lambda d: d["workloads"][0]["lanes"].append("hack-3.0.0"),
        "host_incomplete": lambda d: d["host"]["orbstack"].pop("build"),
        "protocol_revision_mismatch": lambda d: d.update(revision=2),
        "known_limit_malformed": lambda d: d["known_limits"][0].pop("revisit"),
        "lane_id_duplicate": lambda d: d["lanes"].append(copy.deepcopy(d["lanes"][0])),
    }

    def test_each_weakening_is_refused_with_its_closed_code(self):
        for code, change in self.CASES.items():
            with self.subTest(code=code):
                found = protocol_check.validate_protocol(mutated(change))
                self.assertIn(code.split(":")[0], found)
                self.assertTrue(set(found) <= protocol_check.DIAGNOSTICS)

    def test_dropping_a_required_baseline_is_refused(self):
        def drop(doc):
            doc["lanes"] = [item for item in doc["lanes"] if item["id"] != "hack-4.2.0"]
            doc["schedule"]["orders"] = protocol_check.williams_orders([item["id"] for item in doc["lanes"]])
            for workload in doc["workloads"]:
                workload["lanes"].remove("hack-4.2.0")
        self.assertIn("baseline_lane_missing", protocol_check.validate_protocol(mutated(drop)))

    def test_unbalanced_or_short_rotation_is_refused(self):
        def swap(doc):
            order = doc["schedule"]["orders"][0]
            order[0], order[1] = order[1], order[0]
        self.assertIn("schedule_position_unbalanced", protocol_check.validate_protocol(mutated(swap)))
        repeated = mutated(lambda d: d["schedule"].update(orders=[d["schedule"]["orders"][0]] * 10))
        found = protocol_check.validate_protocol(repeated)
        self.assertIn("schedule_position_unbalanced", found)
        self.assertIn("schedule_carryover_unbalanced", found)
        short = mutated(lambda d: d["schedule"].update(orders=d["schedule"]["orders"][:4]))
        self.assertIn("schedule_rounds_below_minimum", protocol_check.validate_protocol(short))
        floor = mutated(lambda d: d["samples"].update(min_lifecycle_runs_per_lane=4))
        self.assertIn("schedule_rounds_below_minimum", protocol_check.validate_protocol(floor))
        more_than_scheduled = mutated(lambda d: d["samples"].update(min_lifecycle_runs_per_lane=11))
        self.assertIn("schedule_rounds_below_minimum", protocol_check.validate_protocol(more_than_scheduled))
        missing_lane = mutated(lambda d: d["schedule"]["orders"][3].pop())
        self.assertIn("schedule_lane_set_mismatch", protocol_check.validate_protocol(missing_lane))

    def test_diagnostics_never_echo_input_values(self):
        doc = mutated(lambda d: lane(d, "candidate").update(commit=MARKER, asset_sha256=MARKER))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / f"{MARKER}.json"
            path.write_text(json.dumps(doc))
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = protocol_check.main(["--protocol", str(path)])
            self.assertEqual(code, 2)
            self.assertNotIn(MARKER, out.getvalue())
            self.assertEqual(json.loads(out.getvalue())["diagnostics"],
                             ["artifact_commit_malformed", "artifact_digest_malformed"])
            path.write_text("{not json " + MARKER)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(protocol_check.main(["--protocol", str(path)]), 2)
            self.assertEqual(json.loads(out.getvalue()), {"status": "invalid", "diagnostics": ["protocol_unreadable"]})


class BudgetEvaluationTest(unittest.TestCase):
    def judge(self, summary):
        diagnostics, records = protocol_check.evaluate(PROTOCOL, summary)
        self.assertEqual(diagnostics, [])
        self.assertTrue({record["verdict"] for record in records} <= protocol_check.VERDICTS)
        return records

    def test_complete_improved_cohort_passes_every_budget_against_every_baseline(self):
        records = self.judge(small_summary())
        self.assertEqual({record["verdict"] for record in records}, {"pass"})
        comparative = [record for record in records if "baseline" in record]
        self.assertEqual(len(comparative), 4 * 4)
        self.assertEqual(len(records) - len(comparative), 5)

    def test_boundary_ratios_follow_the_frozen_thresholds(self):
        records = self.judge(small_summary(candidate_scale=0.75))
        self.assertEqual(set(verdicts(records, "cpu_seconds_per_task", "compose")), {"pass"})
        self.assertEqual(set(verdicts(records, "steady_physical_footprint_bytes", "compose")), {"fail"})
        self.assertEqual(set(verdicts(records, "warm_startup_seconds", "compose")), {"pass"})

    def test_each_baseline_is_judged_separately_without_aggregation(self):
        summary = small_summary()
        summary["lanes"]["hack-4.2.1"]["warm_startup_seconds"] = entry([5.0] * 10)
        records = self.judge(summary)
        self.assertEqual(verdicts(records, "warm_startup_seconds", "hack-4.2.1"), ["fail"])
        self.assertEqual(verdicts(records, "warm_startup_seconds", "compose"), ["pass"])

    def test_too_few_rotated_runs_or_tail_samples_are_inconclusive(self):
        records = self.judge(small_summary(runs=9))
        self.assertEqual(set(verdicts(records, "warm_restart_seconds", "compose")), {"inconclusive_samples"})
        records = self.judge(small_summary(tail=59))
        self.assertEqual(verdicts(records, "info_latency_ms"), ["inconclusive_samples"])
        self.assertEqual(verdicts(records, "watcher_ack_ms"), ["inconclusive_samples"])

    def test_missing_planned_samples_are_inconclusive_coverage(self):
        summary = small_summary()
        summary["lanes"]["compose"]["cpu_seconds_per_task"]["expected"] = 11
        records = self.judge(summary)
        self.assertEqual(verdicts(records, "cpu_seconds_per_task", "compose"), ["inconclusive_coverage"])
        summary["lanes"]["compose"]["cpu_seconds_per_task"]["expected"] = None
        records = self.judge(summary)
        self.assertEqual(verdicts(records, "cpu_seconds_per_task", "compose"), ["inconclusive_missing"])

    def test_difference_within_observer_cost_is_inconclusive(self):
        summary = small_summary()
        summary["observer_cost"]["cpu_seconds_per_task"] = 2.6
        records = self.judge(summary)
        self.assertEqual(set(verdicts(records, "cpu_seconds_per_task", "compose")), {"inconclusive_observer"})
        summary["observer_cost"].pop("warm_startup_seconds")
        records = self.judge(summary)
        self.assertEqual(set(verdicts(records, "warm_startup_seconds", "compose")), {"inconclusive_observer"})

    def test_absolute_ceilings_respect_inclusivity(self):
        summary = small_summary()
        summary["lanes"]["candidate"]["info_latency_ms"] = entry([100] * 60)
        summary["lanes"]["candidate"]["idle_control_plane_core_fraction"] = entry([0.01] * 10)
        records = self.judge(summary)
        self.assertEqual(verdicts(records, "info_latency_ms"), ["pass"])
        self.assertEqual(verdicts(records, "idle_control_plane_core_fraction"), ["fail"])
        summary["lanes"]["candidate"]["info_latency_ms"] = entry([50] * 57 + [101] * 3)
        self.assertEqual(verdicts(self.judge(summary), "info_latency_ms"), ["pass"])
        summary["lanes"]["candidate"]["info_latency_ms"] = entry([50] * 56 + [101] * 4)
        self.assertEqual(verdicts(self.judge(summary), "info_latency_ms"), ["fail"])

    def test_not_applicable_and_missing_lanes_are_never_passes(self):
        summary = small_summary()
        summary["lanes"]["hack-4.1.1"]["warm_startup_seconds"] = {"not_applicable": True}
        summary["lanes"].pop("hack-4.2.0")
        records = self.judge(summary)
        self.assertEqual(verdicts(records, "warm_startup_seconds", "hack-4.1.1"), ["not_applicable"])
        self.assertEqual(set(verdicts(records, "cpu_seconds_per_task", "hack-4.2.0")), {"inconclusive_missing"})

    def test_workload_scoped_budgets_only_apply_to_their_workload(self):
        summary = small_summary()
        summary["workload"] = "event-agent"
        records = self.judge(summary)
        metrics = {record["metric"] for record in records if "baseline" not in record}
        self.assertEqual(metrics, {"info_latency_ms", "warm_admission_ms"})

    def test_malformed_summaries_are_refused_with_closed_codes(self):
        cases = {
            "summary_not_object": [],
            "summary_revision_mismatch": {**small_summary(), "protocol_revision": 2},
            "summary_workload_unknown": {**small_summary(), "workload": MARKER},
            "summary_lane_unknown": {**small_summary(), "lanes": {MARKER: {}}},
        }
        for code, summary in cases.items():
            with self.subTest(code=code):
                self.assertEqual(protocol_check.evaluate(PROTOCOL, summary), ([code], []))

    def test_cli_exit_codes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "summary.json"
            for scale, expected in ((0.5, 0), (0.9, 1)):
                path.write_text(json.dumps(small_summary(candidate_scale=scale)))
                with contextlib.redirect_stdout(io.StringIO()) as out:
                    self.assertEqual(protocol_check.main(["--evaluate", str(path)]), expected)
                self.assertEqual(json.loads(out.getvalue())["accepted"], expected == 0)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(protocol_check.main([]), 0)
                self.assertEqual(protocol_check.main(["--schedule"]), 0)


if __name__ == "__main__":
    unittest.main()
