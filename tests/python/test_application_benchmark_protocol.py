"""Offline controls for the frozen matched application benchmark protocol; no live runs."""
import contextlib
import copy
import importlib.util
import io
import json
import math
from pathlib import Path
import re
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
BASELINES = ("compose", "hack-4.1.1", "hack-4.2.0", "hack-4.2.1")
COMPARATIVE = ("steady_physical_footprint_bytes", "cpu_seconds_per_task", "warm_startup_seconds",
               "warm_restart_seconds")
ABSOLUTE = ("info_latency_ms", "warm_admission_ms", "cached_status_1000_objects_ms",
            "idle_control_plane_core_fraction", "watcher_ack_ms")
# Every JSON value type, including the non-standard numbers Python's json module accepts
# and integers too large for a float, which Python's json module also parses.
HUGE = 10 ** 400
FUZZ_VALUES = (None, True, 0, -1, 1.5, float("nan"), float("inf"), float("-inf"), HUGE, -HUGE, 2 ** 53,
               "x", [], ["x"], [["x"]], {}, {"x": []})
# Another well-formed 40-hex commit and 64-hex digest: only the identity pin refuses them.
OTHER_COMMIT = "0123456789abcdef0123456789abcdef01234567"
OTHER_DIGEST = "0123456789abcdef" * 4


def mutated(change, doc=None):
    doc = copy.deepcopy(PROTOCOL if doc is None else doc)
    change(doc)
    return doc


def lane(doc, lane_id):
    return next(item for item in doc["lanes"] if item["id"] == lane_id)


def workload(doc, workload_id):
    return next(item for item in doc["workloads"] if item["id"] == workload_id)


def budget(doc, kind, metric):
    return next(item for item in doc["budgets"][kind] if item["metric"] == metric)


def entry(values, expected=None, flagged=0, failed=0):
    return {"samples": list(values), "expected": len(values) if expected is None else expected,
            "flagged": flagged, "failed": failed}


def not_applicable():
    return {"not_applicable": True, "reason": "lane cannot express this workload"}


def small_summary(candidate_scale=0.5, runs=10, tail=60):
    """A complete small-fixture summary where the candidate is `candidate_scale` of each baseline."""
    base = {"steady_physical_footprint_bytes": 1000.0, "cpu_seconds_per_task": 10.0,
            "warm_startup_seconds": 20.0, "warm_restart_seconds": 10.0}
    lanes = {item: {metric: entry([value] * runs) for metric, value in base.items()} for item in BASELINES}
    lanes["candidate"] = {metric: entry([value * candidate_scale] * runs) for metric, value in base.items()}
    lanes["candidate"].update({
        "info_latency_ms": entry([50] * tail),
        "warm_admission_ms": entry([100] * tail),
        "cached_status_1000_objects_ms": entry([100] * tail),
        "idle_control_plane_core_fraction": entry([0.005] * runs),
        "watcher_ack_ms": entry([100] * tail),
    })
    return {"protocol_revision": 1, "workload": "small-fixture", "cache_class": "warm",
            "scale": {"branch_instances": 1},
            "observer_cost": {metric: 0.0 for metric in base}, "lanes": lanes}


def verdicts(records, metric, baseline=None):
    return [record["verdict"] for record in records
            if record["metric"] == metric and record.get("baseline", baseline) == baseline]


def run_cli(argv):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = protocol_check.main(argv)
    return code, json.loads(out.getvalue())


def evaluate_file(summary):
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "summary.json"
        path.write_text(json.dumps(summary))
        return run_cli(["--evaluate", str(path)])


def node_paths(node, prefix=(), list_limit=None):
    """Yield the path of every node below `node`; `list_limit` caps indices per list."""
    if isinstance(node, dict):
        children = node.items()
    elif isinstance(node, list):
        children = list(enumerate(node))[:list_limit]
    else:
        return
    for key, child in children:
        yield prefix + (key,)
        yield from node_paths(child, prefix + (key,), list_limit)


def replace_at(doc, path, value):
    doc = copy.deepcopy(doc)
    parent = doc
    for key in path[:-1]:
        parent = parent[key]
    if value is DELETE:
        del parent[path[-1]]
    else:
        parent[path[-1]] = copy.deepcopy(value)
    return doc


DELETE = object()


class FrozenProtocolTest(unittest.TestCase):
    def test_frozen_protocol_is_valid(self):
        self.assertEqual(protocol_check.validate_protocol(PROTOCOL), [])

    def test_frozen_schedule_is_the_williams_design_for_the_frozen_lanes(self):
        lanes = [item["id"] for item in PROTOCOL["lanes"]]
        self.assertEqual(PROTOCOL["schedule"]["orders"], protocol_check.williams_orders(lanes))
        self.assertEqual(PROTOCOL["schedule"]["orders"], protocol_check.FROZEN_ORDERS)
        self.assertEqual(PROTOCOL["samples"]["min_lifecycle_runs_per_lane"], protocol_check.FROZEN_LIFECYCLE_RUNS)
        self.assertEqual(PROTOCOL["samples"]["p95_min_samples"], protocol_check.FROZEN_P95_MIN_SAMPLES)
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

    def test_frozen_gate_c_coverage(self):
        self.assertIn("restore", PROTOCOL["phases"])
        self.assertEqual(PROTOCOL["scale_points"]["branch_instances"], [1, 8, 32])
        self.assertEqual(PROTOCOL["scale_points"]["mcp_clients"], [1, 32])
        scopes = {item["metric"]: item.get("workload") for item in PROTOCOL["budgets"]["absolute"]}
        # Gate C limits only the watcher budget to the small fixture.
        self.assertEqual(scopes, {metric: None for metric in ABSOLUTE} | {"watcher_ack_ms": "small-fixture"})
        for item in PROTOCOL["workloads"]:
            self.assertEqual(sorted(item["lanes"]), sorted(("candidate",) + BASELINES))

    def test_frozen_file_matches_the_pinned_identities(self):
        for lane_id, frozen in protocol_check.FROZEN_LANES.items():
            item = lane(PROTOCOL, lane_id)
            for field, value in frozen.items():
                self.assertEqual(item[field], value, (lane_id, field))
        self.assertEqual(lane(PROTOCOL, "candidate")["capacity"], protocol_check.FROZEN_CANDIDATE_CAPACITY)
        self.assertEqual(PROTOCOL["host"], protocol_check.FROZEN_HOST)
        for workload_id, pin in protocol_check.FROZEN_WORKLOAD_PINS.items():
            self.assertEqual(workload(PROTOCOL, workload_id)["pin"], pin)
            self.assertEqual(workload(PROTOCOL, workload_id)["correctness"],
                             list(protocol_check.FROZEN_CORRECTNESS[workload_id]))

    def test_documents_carry_every_frozen_artifact_and_budget(self):
        # Driven by the validator's pins, not the JSON, so a removed field is still required.
        for lane_id, frozen in protocol_check.FROZEN_LANES.items():
            if frozen["kind"] != "hack":
                continue
            for field in ("commit", "asset", "asset_sha256", "tag"):
                self.assertIn(f"`{frozen[field]}`", PROTOCOL_DOC, (lane_id, field))
        capacity = protocol_check.FROZEN_CANDIDATE_CAPACITY
        self.assertIn(f"native `{capacity['profile']}` profile: {capacity['vcpus']} vCPUs, "
                      f"{capacity['memory_mib']} MiB guest memory, {capacity['storage_gib']} GiB storage, "
                      f"{capacity['overlay_gib']} GiB overlay", PROTOCOL_DOC)
        # The candidate's own source labels this profile non-qualifying; the page must say why it is used.
        for phrase in ("experimental-development-not-benchmark-qualified", "graph_profile", "`research`"):
            self.assertIn(phrase, PROTOCOL_DOC)
        host = PROTOCOL["host"]
        for value in (host["cpu"], host["os"], host["docker_cli"], host["compose"],
                      host["orbstack"]["version"], host["orbstack"]["build"]):
            self.assertIn(str(value), PROTOCOL_DOC)
        for item in PROTOCOL["budgets"]["comparative"]:
            self.assertIn(f"`{item['metric']}`", PROTOCOL_DOC)
            self.assertIn(f"{item['max_ratio']:.2f}", PROTOCOL_DOC)
        for item in PROTOCOL["budgets"]["absolute"]:
            self.assertIn(f"`{item['metric']}`", PROTOCOL_DOC)
        for phase in PROTOCOL["phases"]:
            self.assertIn(f"`{phase}`", PROTOCOL_DOC)
        self.assertIn("1, 8 and 32 branch instances", PROTOCOL_DOC)
        self.assertIn("1 and 32 MCP clients", PROTOCOL_DOC)
        for code in sorted(protocol_check.VERDICTS):
            self.assertIn(f"`{code}`", PROTOCOL_DOC)
        self.assertIn(f"at least {protocol_check.FROZEN_P95_MIN_SAMPLES} samples per lane", PROTOCOL_DOC)
        self.assertIn(f"at least {protocol_check.FROZEN_LIFECYCLE_RUNS} lifecycles per lane", PROTOCOL_DOC)
        # The published order table is the frozen rotation, round for round.
        rows = re.findall(r"^\| (\d+) \| ([a-z0-9., -]+) \|$", PROTOCOL_DOC, re.MULTILINE)
        self.assertEqual([int(number) for number, _ in rows],
                         list(range(1, len(protocol_check.FROZEN_ORDERS) + 1)))
        self.assertEqual([order.split(", ") for _, order in rows], protocol_check.FROZEN_ORDERS)
        limit = PROTOCOL["known_limits"][0]
        for value in (limit["issue"], "#313", f"{limit['warm_up_seconds']} s", f"{limit['witness_seconds']} s",
                      f"{limit['witness_target_seconds']} s", "HACK-1169"):
            self.assertIn(value, PERFORMANCE_DOC)
        self.assertIn("application-benchmark-protocol.md", PERFORMANCE_DOC)


def _recast_as_compose(item):
    for field in ("version", "commit", "asset_sha256", "tag", "asset", "capacity"):
        item.pop(field, None)
    item.update(kind="compose", engine="orbstack", compose_version="5.1.2")


def _reorder_schedule(doc):
    doc["lanes"][1], doc["lanes"][2] = doc["lanes"][2], doc["lanes"][1]
    doc["schedule"]["orders"] = protocol_check.williams_orders([item["id"] for item in doc["lanes"]])


def _set_scope(metric, scope):
    def change(doc):
        budget(doc, "absolute", metric)["workload"] = scope
    return change


class NegativeProtocolControls(unittest.TestCase):
    CASES = {
        "comparative_budget_weakened": lambda d: budget(d, "comparative", "steady_physical_footprint_bytes")
        .update(max_ratio=0.71),
        # A weaker duplicate listed before the frozen entry must not hide behind it.
        "comparative_budget_weakened:duplicate": lambda d: d["budgets"]["comparative"].insert(
            0, {"metric": "cpu_seconds_per_task", "statistic": "median", "max_ratio": 0.9}),
        "absolute_budget_weakened": lambda d: budget(d, "absolute", "idle_control_plane_core_fraction")
        .update(inclusive=True),
        "absolute_budget_weakened:ceiling": lambda d: budget(d, "absolute", "info_latency_ms").update(max=1000),
        "absolute_budget_weakened:ceiling-exclusive": lambda d: budget(d, "absolute", "watcher_ack_ms")
        .update(max=201, inclusive=False),
        "comparative_budget_missing": lambda d: d["budgets"]["comparative"].pop(),
        "absolute_budget_missing": lambda d: d["budgets"]["absolute"].pop(),
        "statistic_unknown": lambda d: budget(d, "absolute", "info_latency_ms").update(statistic="mean"),
        "budget_statistic_mismatch:absolute": lambda d: budget(d, "absolute", "info_latency_ms")
        .update(statistic="median"),
        "budget_statistic_mismatch:comparative": lambda d: budget(d, "comparative", "cpu_seconds_per_task")
        .update(statistic="window_mean"),
        "budget_statistic_mismatch:idle": lambda d: budget(d, "absolute", "idle_control_plane_core_fraction")
        .update(statistic="median"),
        "budget_scope_narrowed:watcher": _set_scope("watcher_ack_ms", "event-agent"),
        "budget_scope_narrowed:info": _set_scope("info_latency_ms", "small-fixture"),
        "budget_scope_narrowed:idle": _set_scope("idle_control_plane_core_fraction", "small-fixture"),
        "budget_scope_narrowed:unknown": _set_scope("watcher_ack_ms", "nowhere"),
        "budget_scope_narrowed:additional": lambda d: d["budgets"]["absolute"].append(
            {"metric": "exec_ms", "statistic": "p95", "max": 50, "inclusive": True, "workload": "nowhere"}),
        "workload_baseline_missing": lambda d: workload(d, "event-agent")["lanes"].remove("compose"),
        "workload_shape_mismatch": lambda d: workload(d, "event-agent")["shape"].update(services=13),
        "phases_mismatch": lambda d: d["phases"].remove("restore"),
        "scale_points_mismatch:instances": lambda d: d["scale_points"].update(branch_instances=[1, 8]),
        "scale_points_mismatch:clients": lambda d: d["scale_points"].update(mcp_clients=[1]),
        "scale_points_mismatch:judged": lambda d: d["scale_points"].update(judged={"branch_instances": 8}),
        "artifact_commit_malformed": lambda d: lane(d, "candidate").update(commit="28de2f89"),
        "artifact_digest_malformed": lambda d: lane(d, "hack-4.2.1").update(asset_sha256="0" * 63),
        "artifact_version_malformed": lambda d: lane(d, "hack-4.1.1").update(tag="v4.1.2"),
        "p95_samples_insufficient": lambda d: d["samples"].update(p95_min_samples=58),
        # 59 clears the distribution-free bound; only the frozen revision-1 floor of 60 refuses it.
        "p95_samples_insufficient:frozen-floor": lambda d: d["samples"].update(p95_min_samples=59),
        # 0.90 needs only 29 samples, so 60 still clears the bound: only the quantile check catches it.
        "p95_samples_insufficient:quantile": lambda d: d["samples"].update(p95_quantile=0.9),
        # 0.90 confidence needs only 45 samples, so 60 still clears it: only the confidence floor catches it.
        "p95_samples_insufficient:confidence": lambda d: d["samples"].update(p95_bound_confidence=0.9),
        "p95_method_mismatch": lambda d: d["samples"].update(p95_method="linear-interpolation"),
        "schedule_rounds_mismatch": lambda d: d["schedule"].update(rounds_per_workload=9),
        "schedule_design_mismatch": lambda d: d["schedule"].update(design="latin-square"),
        # Above the program floor of 5 but below the frozen 10 runs per lane.
        "schedule_rounds_below_minimum:frozen-floor": lambda d: d["samples"].update(min_lifecycle_runs_per_lane=5),
        # Another balanced Williams square, from a reordered lane list: only the order pin refuses it.
        "schedule_order_mismatch": _reorder_schedule,
        "observer_policy_missing": lambda d: d["observer"].update(inconclusive_factor=0.5),
        "observer_policy_missing:factor": lambda d: d["observer"].update(inconclusive_factor=1),
        "observer_policy_missing:window": lambda d: d["observer"].update(control_window_seconds=599),
        "cache_class_missing": lambda d: d["cache_classes"].update(budget_class="cold-cache"),
        "workload_lane_unknown": lambda d: d["workloads"][0]["lanes"].append("hack-3.0.0"),
        "workloads_malformed:id": lambda d: d["workloads"][0].update(id=["event-agent"]),
        "host_incomplete": lambda d: d["host"]["orbstack"].pop("build"),
        "protocol_revision_mismatch": lambda d: d.update(revision=2),
        "protocol_revision_mismatch:bool": lambda d: d.update(revision=True),
        "known_limit_malformed": lambda d: d["known_limits"][0].pop("revisit"),
        "known_limit_malformed:number": lambda d: d.update(known_limits=7),
        "lane_id_duplicate": lambda d: d["lanes"].append(copy.deepcopy(d["lanes"][0])),
        "compose_lane_host_mismatch": lambda d: lane(d, "compose").update(compose_version="2.0.0"),
        "compose_lane_host_mismatch:engine": lambda d: lane(d, "compose").update(engine="docker-desktop"),
        # Well-formed but different identities: only the revision-1 pins refuse these.
        "artifact_identity_mismatch:candidate-commit": lambda d: lane(d, "candidate").update(commit=OTHER_COMMIT),
        "artifact_identity_mismatch:baseline-commit": lambda d: lane(d, "hack-4.2.0").update(commit=OTHER_COMMIT),
        "artifact_identity_mismatch:digest": lambda d: lane(d, "hack-4.1.1").update(asset_sha256=OTHER_DIGEST),
        "artifact_identity_mismatch:version": lambda d: lane(d, "candidate").update(
            version="5.0.0-next.6", tag="v5.0.0-next.6"),
        "artifact_identity_mismatch:asset": lambda d: lane(d, "hack-4.2.1").update(
            asset="hack-4.2.1-darwin-x64.tar.gz"),
        "artifact_identity_mismatch:asset-removed": lambda d: lane(d, "candidate").pop("asset"),
        # A hack lane recast as a Compose lane on the frozen engine, with its artifact removed.
        "lane_runtime_mismatch:candidate-kind": lambda d: _recast_as_compose(lane(d, "candidate")),
        "lane_runtime_mismatch:baseline-kind": lambda d: _recast_as_compose(lane(d, "hack-4.1.1")),
        "lane_runtime_mismatch:backend": lambda d: lane(d, "candidate").update(backend="compose"),
        "lane_runtime_mismatch:backend-removed": lambda d: lane(d, "candidate").pop("backend"),
        "lane_runtime_mismatch:compose-backend": lambda d: lane(d, "compose").update(backend="hack"),
        "lane_runtime_mismatch:baseline-capacity": lambda d: lane(d, "compose").update(capacity={"cpus": 4}),
        "candidate_capacity_mismatch": lambda d: lane(d, "candidate")["capacity"].update(memory_mib=12288),
        "candidate_capacity_mismatch:profile": lambda d: lane(d, "candidate")["capacity"].update(
            profile="research"),
        "candidate_capacity_mismatch:removed": lambda d: lane(d, "candidate").pop("capacity"),
        "candidate_capacity_mismatch:float": lambda d: lane(d, "candidate")["capacity"].update(vcpus=4.0),
        "host_mismatch:os": lambda d: d["host"].update(os="macOS 26.5.1"),
        "host_mismatch:cpu": lambda d: d["host"].update(cpu="Apple M5 Max", logical_cpus=18),
        "host_mismatch:orbstack": lambda d: d["host"]["orbstack"].update(memory_mib=32768),
        "workload_pin_mismatch": lambda d: workload(d, "small-fixture").update(pin="image oven/bun:latest"),
        "workload_correctness_weakened": lambda d: workload(d, "event-agent")["correctness"].pop(),
    }

    def test_each_weakening_is_refused_with_its_closed_code(self):
        for code, change in self.CASES.items():
            with self.subTest(code=code):
                found = protocol_check.validate_protocol(mutated(change))
                self.assertIn(code.split(":")[0], found)
                self.assertTrue(set(found) <= protocol_check.DIAGNOSTICS)

    def test_stricter_revisions_stay_valid(self):
        stricter = mutated(lambda d: (
            workload(d, "small-fixture")["correctness"].append("cleanup leaves no owned container"),
            budget(d, "absolute", "watcher_ack_ms").pop("workload"),
            budget(d, "absolute", "info_latency_ms").update(max=90),
            budget(d, "comparative", "cpu_seconds_per_task").update(max_ratio=0.6),
            d["observer"].update(inconclusive_factor=3),
            d["scale_points"].update(branch_instances=[1, 8, 16, 32]),
        ))
        self.assertEqual(protocol_check.validate_protocol(stricter), [])

    def test_dropping_a_required_baseline_is_refused(self):
        def drop(doc):
            doc["lanes"] = [item for item in doc["lanes"] if item["id"] != "hack-4.2.0"]
            doc["schedule"]["orders"] = protocol_check.williams_orders([item["id"] for item in doc["lanes"]])
            doc["schedule"]["rounds_per_workload"] = len(doc["schedule"]["orders"])
            for item in doc["workloads"]:
                item["lanes"].remove("hack-4.2.0")
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

    def test_any_malformed_node_maps_to_closed_codes_without_raising(self):
        for path in node_paths(PROTOCOL):
            for value in FUZZ_VALUES + (DELETE,):
                with self.subTest(path=path, value=repr(value)):
                    found = protocol_check.validate_protocol(replace_at(PROTOCOL, path, value))
                    self.assertTrue(set(found) <= protocol_check.DIAGNOSTICS, found)
        for value in FUZZ_VALUES:
            found = protocol_check.validate_protocol(value)
            if not isinstance(value, dict):
                self.assertEqual(found, ["protocol_not_object"])
            self.assertTrue(found and set(found) <= protocol_check.DIAGNOSTICS)

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
                             ["artifact_commit_malformed", "artifact_digest_malformed",
                              "artifact_identity_mismatch"])
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

    def refused(self, summary):
        diagnostics, records = protocol_check.evaluate(PROTOCOL, summary)
        self.assertEqual(records, [])
        self.assertTrue(diagnostics and set(diagnostics) <= protocol_check.DIAGNOSTICS, diagnostics)
        return diagnostics

    def test_complete_improved_cohort_passes_every_budget_against_every_baseline(self):
        records = self.judge(small_summary())
        self.assertEqual({record["verdict"] for record in records}, {"pass"})
        comparative = [record for record in records if "baseline" in record]
        self.assertEqual(len(comparative), 4 * 4)
        self.assertEqual(len(records) - len(comparative), 5)
        self.assertTrue(protocol_check.accepted(records))
        self.assertFalse(protocol_check.accepted([]))

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

    def test_flagged_failed_or_unaccounted_samples_are_never_passes(self):
        summary = small_summary()
        summary["lanes"]["compose"]["cpu_seconds_per_task"] = entry([10.0] * 10, expected=11, flagged=1)
        summary["lanes"]["hack-4.1.1"]["cpu_seconds_per_task"] = entry([10.0] * 10, expected=11, failed=1)
        summary["lanes"]["hack-4.2.0"]["cpu_seconds_per_task"].pop("flagged")
        summary["lanes"]["candidate"]["info_latency_ms"].pop("failed")
        records = self.judge(summary)
        self.assertEqual(verdicts(records, "cpu_seconds_per_task", "compose"), ["inconclusive_admission"])
        self.assertEqual(verdicts(records, "cpu_seconds_per_task", "hack-4.1.1"), ["inconclusive_admission"])
        self.assertEqual(verdicts(records, "cpu_seconds_per_task", "hack-4.2.0"), ["inconclusive_admission"])
        self.assertEqual(verdicts(records, "info_latency_ms"), ["inconclusive_admission"])
        self.assertEqual(verdicts(records, "cpu_seconds_per_task", "hack-4.2.1"), ["pass"])
        self.assertFalse(protocol_check.accepted(records))

    def test_failed_candidate_lifecycle_is_a_failure(self):
        summary = small_summary()
        summary["lanes"]["candidate"]["warm_startup_seconds"] = entry([10.0] * 10, expected=11, failed=1)
        summary["lanes"]["candidate"]["watcher_ack_ms"] = entry([100] * 60, expected=61, failed=1)
        records = self.judge(summary)
        self.assertEqual(set(verdicts(records, "warm_startup_seconds", "compose")), {"fail"})
        self.assertEqual(verdicts(records, "watcher_ack_ms"), ["fail"])

    def test_difference_within_observer_cost_is_inconclusive(self):
        summary = small_summary()
        summary["observer_cost"]["cpu_seconds_per_task"] = 2.6
        records = self.judge(summary)
        self.assertEqual(set(verdicts(records, "cpu_seconds_per_task", "compose")), {"inconclusive_observer"})
        summary["observer_cost"].pop("warm_startup_seconds")
        records = self.judge(summary)
        self.assertEqual(set(verdicts(records, "warm_startup_seconds", "compose")), {"inconclusive_observer"})

    def test_frozen_observer_factor_is_two(self):
        # A 5.0 difference against a 2.6 cost is inside 2 x cost; a factor of 1 would pass it.
        summary = small_summary()
        summary["observer_cost"]["cpu_seconds_per_task"] = 2.6
        weak = mutated(lambda d: d["observer"].update(inconclusive_factor=1))
        _, records = protocol_check.evaluate(weak, summary)
        self.assertEqual(set(verdicts(records, "cpu_seconds_per_task", "compose")), {"pass"})
        self.assertIn("observer_policy_missing", protocol_check.validate_protocol(weak))

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

    def test_window_mean_is_correctly_rounded_on_every_interpreter(self):
        # Built-in sum() gives 0.009999999999999998 here before Python 3.12, which would
        # pass the exclusive 1% idle ceiling; on 3.12+ it differs from the exact mean on
        # the second list. Both must judge from the correctly rounded mean.
        self.assertEqual(protocol_check.window_mean([0.01] * 10), 0.01)
        large = [1000000000000000.2, 0.001, 0.007, 0.1, 0.01, 3.0, 1.0, 0.0, 0.007, 1000000000000000.2]
        exact = math.fsum(large) / len(large)
        self.assertEqual(protocol_check.window_mean(large), exact)
        # A stricter extra budget whose exclusive ceiling is that exact mean must fail.
        strict = mutated(lambda d: d["budgets"]["absolute"].append(
            {"metric": "probe_window_mean", "statistic": "window_mean", "max": exact, "inclusive": False}))
        self.assertEqual(protocol_check.validate_protocol(strict), [])
        summary = small_summary()
        summary["lanes"]["candidate"]["probe_window_mean"] = entry(large)
        _, records = protocol_check.evaluate(strict, summary)
        self.assertEqual(verdicts(records, "probe_window_mean"), ["fail"])

    def test_a_not_applicable_baseline_with_a_reason_is_skipped_and_missing_lanes_are_inconclusive(self):
        summary = small_summary()
        summary["lanes"]["hack-4.1.1"]["warm_startup_seconds"] = not_applicable()
        records = self.judge(summary)
        self.assertEqual(verdicts(records, "warm_startup_seconds", "hack-4.1.1"), ["not_applicable"])
        self.assertEqual(verdicts(records, "warm_startup_seconds", "compose"), ["pass"])
        self.assertTrue(protocol_check.accepted(records))
        summary["lanes"].pop("hack-4.2.0")
        records = self.judge(summary)
        self.assertEqual(set(verdicts(records, "cpu_seconds_per_task", "hack-4.2.0")), {"inconclusive_missing"})
        self.assertFalse(protocol_check.accepted(records))

    def test_no_applicable_baseline_is_inconclusive_never_accepted(self):
        summary = small_summary()
        for baseline in BASELINES:
            summary["lanes"][baseline] = {metric: not_applicable() for metric in COMPARATIVE}
        records = self.judge(summary)
        for metric in COMPARATIVE:
            self.assertEqual(verdicts(records, metric), ["inconclusive_no_baseline"])
        self.assertFalse(protocol_check.accepted(records))
        code, report = evaluate_file(summary)
        self.assertEqual((code, report["accepted"]), (1, False))

    def test_the_candidate_can_never_be_not_applicable(self):
        summary = small_summary()
        summary["lanes"]["candidate"] = {metric: not_applicable() for metric in COMPARATIVE + ABSOLUTE}
        self.assertEqual(self.refused(summary), ["summary_candidate_not_applicable"])
        self.assertEqual(evaluate_file(summary),
                         (2, {"status": "invalid", "diagnostics": ["summary_candidate_not_applicable"]}))
        for metric in COMPARATIVE + ABSOLUTE:
            with self.subTest(metric=metric):
                one = small_summary()
                one["lanes"]["candidate"][metric] = not_applicable()
                self.assertEqual(self.refused(one), ["summary_candidate_not_applicable"])

    def test_not_applicable_never_overrides_samples(self):
        for lane_id in ("candidate", "compose"):
            with self.subTest(lane=lane_id):
                summary = small_summary(candidate_scale=5)
                summary["lanes"][lane_id]["warm_startup_seconds"]["not_applicable"] = True
                self.assertEqual(self.refused(summary), ["summary_entry_malformed"])
        for bad in ({"not_applicable": True}, {"not_applicable": True, "reason": " "},
                    {"not_applicable": False, "reason": "x"}, {"not_applicable": 1, "reason": "x"}):
            with self.subTest(entry=bad):
                summary = small_summary()
                summary["lanes"]["compose"]["warm_startup_seconds"] = bad
                self.assertEqual(self.refused(summary), ["summary_entry_malformed"])

    def test_only_warm_single_instance_summaries_are_judged(self):
        cases = {
            "summary_cache_class_mismatch": [("cache_class", "cold-cache"), ("cache_class", None)],
            "summary_scale_unknown": [("scale", None), ("scale", {"branch_instances": 2}),
                                      ("scale", {"branch_instances": True}),
                                      ("scale", {"branch_instances": 1, "mcp_clients": 1}), ("scale", [1])],
            "summary_scale_not_judged": [("scale", {"branch_instances": 32}), ("scale", {"mcp_clients": 1})],
        }
        for code, changes in cases.items():
            for key, value in changes:
                with self.subTest(code=code, value=value):
                    self.assertEqual(self.refused({**small_summary(), key: value}), [code])
        summary = small_summary()
        summary.pop("cache_class")
        self.assertEqual(self.refused(summary), ["summary_cache_class_mismatch"])
        self.assertEqual(evaluate_file({**small_summary(), "cache_class": "cold-cache"})[0], 2)

    def test_malformed_values_are_refused_with_closed_codes(self):
        def candidate(metric, value):
            def change(summary):
                summary["lanes"]["candidate"][metric] = value
            return change

        def baseline(metric, field, value):
            def change(summary):
                summary["lanes"]["compose"][metric][field] = value
            return change

        cases = [
            ("summary_entry_malformed", candidate("info_latency_ms", entry([-5] * 60))),
            ("summary_entry_malformed", candidate("warm_startup_seconds", entry([-1.0] * 10))),
            ("summary_entry_malformed", baseline("cpu_seconds_per_task", "expected", 0)),
            ("summary_entry_malformed", candidate("info_latency_ms", entry([], expected=0))),
            ("summary_entry_malformed", baseline("cpu_seconds_per_task", "expected", -10)),
            ("summary_entry_malformed", baseline("cpu_seconds_per_task", "expected", True)),
            ("summary_entry_malformed", baseline("cpu_seconds_per_task", "expected", 10.0)),
            ("summary_entry_malformed", baseline("cpu_seconds_per_task", "expected", 9)),
            ("summary_entry_malformed", baseline("cpu_seconds_per_task", "flagged", -1)),
            ("summary_entry_malformed", baseline("cpu_seconds_per_task", "failed", "0")),
            ("summary_entry_malformed", baseline("cpu_seconds_per_task", "samples", [1, "2"])),
            ("summary_entry_malformed", baseline("cpu_seconds_per_task", "samples", [float("nan")] * 10)),
            ("summary_entry_malformed", baseline("cpu_seconds_per_task", "median", 1.0)),
            ("summary_entry_malformed", candidate("watcher_ack_ms", [100] * 60)),
            ("summary_lane_malformed", lambda s: s["lanes"].update(compose=[MARKER])),
            ("summary_lane_malformed", lambda s: s.update(lanes=[MARKER])),
            ("summary_observer_malformed", lambda s: s["observer_cost"].update(cpu_seconds_per_task=-1)),
            ("summary_observer_malformed", lambda s: s.update(observer_cost=[0])),
            ("summary_workload_unknown", lambda s: s.update(workload=["x"])),
            ("summary_workload_unknown", lambda s: s.update(workload={"id": "small-fixture"})),
            ("summary_revision_mismatch", lambda s: s.update(protocol_revision=True)),
        ]
        for code, change in cases:
            summary = small_summary()
            change(summary)
            with self.subTest(code=code, summary=summary.get("workload")):
                self.assertEqual(self.refused(summary), [code])

    def test_oversized_integers_are_refused_not_a_traceback(self):
        """Python parses 10**400 exactly; converting it to a float would raise OverflowError."""
        cases = {
            "candidate": lambda s: s["lanes"]["candidate"].update(info_latency_ms=entry([HUGE] * 60)),
            "baseline": lambda s: s["lanes"]["compose"].update(cpu_seconds_per_task=entry([HUGE] * 10)),
            "beyond-interoperable": lambda s: s["lanes"]["compose"].update(
                cpu_seconds_per_task=entry([2 ** 53] * 10)),
        }
        for name, change in cases.items():
            with self.subTest(case=name):
                summary = small_summary()
                change(summary)
                self.assertEqual(evaluate_file(summary),
                                 (2, {"status": "invalid", "diagnostics": ["summary_entry_malformed"]}))
        summary = small_summary()
        summary["observer_cost"]["cpu_seconds_per_task"] = HUGE
        self.assertEqual(evaluate_file(summary),
                         (2, {"status": "invalid", "diagnostics": ["summary_observer_malformed"]}))
        protocol = mutated(lambda d: budget(d, "comparative", "cpu_seconds_per_task").update(max_ratio=HUGE))
        self.assertIn("comparative_budget_weakened", protocol_check.validate_protocol(protocol))

    def test_an_overflowing_ratio_fails_and_the_report_stays_strict_json(self):
        summary = small_summary()
        summary["lanes"]["compose"]["warm_startup_seconds"] = entry([5e-324] * 10)
        records = self.judge(summary)
        [record] = [item for item in records
                    if item["metric"] == "warm_startup_seconds" and item.get("baseline") == "compose"]
        self.assertEqual(record["verdict"], "fail")
        self.assertNotIn("ratio", record)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "summary.json"
            path.write_text(json.dumps(summary))
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(protocol_check.main(["--evaluate", str(path)]), 1)

        def refuse_constant(name):
            raise AssertionError(f"non-standard JSON constant {name}")
        json.loads(out.getvalue(), parse_constant=refuse_constant)

    def test_list_valued_workload_exits_invalid_not_with_a_traceback(self):
        self.assertEqual(evaluate_file({**small_summary(), "workload": ["x"]}),
                         (2, {"status": "invalid", "diagnostics": ["summary_workload_unknown"]}))

    def test_any_malformed_summary_node_maps_to_closed_codes_without_raising(self):
        summary = small_summary()
        for path in node_paths(summary, list_limit=1):
            for value in FUZZ_VALUES + (DELETE,):
                with self.subTest(path=path, value=repr(value)):
                    diagnostics, records = protocol_check.evaluate(PROTOCOL, replace_at(summary, path, value))
                    self.assertTrue(set(diagnostics) <= protocol_check.DIAGNOSTICS, diagnostics)
                    self.assertTrue({record["verdict"] for record in records} <= protocol_check.VERDICTS)
                    self.assertTrue(bool(diagnostics) != bool(records))

    def test_workload_scoped_budgets_only_apply_to_their_workload(self):
        summary = small_summary()
        summary["workload"] = "event-agent"
        records = self.judge(summary)
        metrics = {record["metric"] for record in records if "baseline" not in record}
        self.assertEqual(metrics, set(ABSOLUTE) - {"watcher_ack_ms"})

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
        for scale, expected in ((0.5, 0), (0.9, 1)):
            code, report = evaluate_file(small_summary(candidate_scale=scale))
            self.assertEqual(code, expected)
            self.assertEqual(report["accepted"], expected == 0)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(protocol_check.main([]), 0)
            self.assertEqual(protocol_check.main(["--schedule"]), 0)


if __name__ == "__main__":
    unittest.main()
