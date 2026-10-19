#!/usr/bin/env python3
"""Validate the frozen matched application benchmark protocol and judge retained summaries.

This helper never runs a benchmark, starts a runtime, calls Docker or reads host state. It:

  (default)            validates scripts/application-benchmark-protocol.json against the
                       protocol's invariants and prints a value-free verdict;
  --schedule           prints the frozen rotated lane order for each round;
  --evaluate SUMMARY   judges a retained cohort summary against the frozen budgets.

Diagnostics are closed codes from DIAGNOSTICS; they never echo input values or paths.
A budget verdict is one of VERDICTS. Anything short of complete, sufficient, admitted
samples is inconclusive, never a pass. See docs/reference/application-benchmark-protocol.md.
"""
import argparse
import json
import math
from pathlib import Path
import re
import sys

DEFAULT_PROTOCOL = Path(__file__).resolve().parent / "application-benchmark-protocol.json"
PROTOCOL_ID = "hack-application-benchmark"
PROTOCOL_REVISION = 1

COMMIT = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$")
LANE_ID = re.compile(r"^[a-z0-9][a-z0-9.-]{0,31}$")

# Program floors (Linear program acceptance, Gate C). A protocol revision may be
# stricter than these, never weaker.
MIN_ROTATED_LIFECYCLE_RUNS = 5
REQUIRED_BASELINES = ("compose", "hack-4.1.1", "hack-4.2.0", "hack-4.2.1")
COMPARATIVE_CEILINGS = {
    "steady_physical_footprint_bytes": 0.70,
    "cpu_seconds_per_task": 0.75,
    "warm_startup_seconds": 0.80,
    "warm_restart_seconds": 0.80,
}
# (ceiling, whether the ceiling itself passes): "p95 <= 100 ms" versus "< 1% of one core".
ABSOLUTE_CEILINGS = {
    "info_latency_ms": (100, True),
    "cached_status_1000_objects_ms": (150, True),
    "warm_admission_ms": (250, True),
    "idle_control_plane_core_fraction": (0.01, False),
    "watcher_ack_ms": (200, True),
}
STATISTICS = ("median", "p95", "window_mean")

DIAGNOSTICS = frozenset({
    "protocol_unreadable",
    "protocol_not_object",
    "protocol_id_mismatch",
    "protocol_revision_mismatch",
    "host_incomplete",
    "lanes_malformed",
    "lane_id_duplicate",
    "candidate_lane_missing",
    "baseline_lane_missing",
    "artifact_commit_malformed",
    "artifact_digest_malformed",
    "artifact_version_malformed",
    "workloads_malformed",
    "workload_lane_unknown",
    "cache_class_missing",
    "schedule_lane_set_mismatch",
    "schedule_rounds_below_minimum",
    "schedule_position_unbalanced",
    "schedule_carryover_unbalanced",
    "p95_samples_insufficient",
    "comparative_budget_missing",
    "comparative_budget_weakened",
    "absolute_budget_missing",
    "absolute_budget_weakened",
    "statistic_unknown",
    "observer_policy_missing",
    "known_limit_malformed",
    "summary_unreadable",
    "summary_not_object",
    "summary_revision_mismatch",
    "summary_workload_unknown",
    "summary_lane_unknown",
})

VERDICTS = frozenset({
    "pass",
    "fail",
    "not_applicable",
    "inconclusive_coverage",
    "inconclusive_samples",
    "inconclusive_observer",
    "inconclusive_missing",
})


def williams_orders(lanes):
    """Williams design: each lane takes each position, and follows each other lane, equally.

    An even lane count needs one square (n rounds); an odd count needs the square plus
    its mirror (2n rounds) to balance first-order carryover.
    """
    n = len(lanes)
    base, low, high = [0], 1, n - 1
    while len(base) < n:
        base.append(low)
        low += 1
        if len(base) < n:
            base.append(high)
            high -= 1
    rows = [[(index + shift) % n for index in base] for shift in range(n)]
    if n % 2:
        rows += [list(reversed(row)) for row in rows]
    return [[lanes[index] for index in row] for row in rows]


def position_balanced(orders):
    lanes = sorted(orders[0])
    for position in range(len(lanes)):
        counts = {lane: 0 for lane in lanes}
        for order in orders:
            counts[order[position]] += 1
        if len(set(counts.values())) != 1:
            return False
    return True


def carryover_balanced(orders):
    """Every ordered (predecessor, successor) pair of distinct lanes occurs equally often."""
    lanes = sorted(orders[0])
    pairs = {(a, b): 0 for a in lanes for b in lanes if a != b}
    for order in orders:
        for a, b in zip(order, order[1:]):
            pairs[(a, b)] += 1
    return len(set(pairs.values())) == 1


def minimum_order_statistic_samples(quantile, confidence):
    """Smallest n whose sample maximum bounds the true quantile with this confidence.

    P(max of n samples >= true q-quantile) = 1 - q**n, distribution free.
    """
    if not (0 < quantile < 1 and 0 < confidence < 1):
        raise ValueError("quantile and confidence must be in (0, 1)")
    n = math.ceil(math.log(1 - confidence) / math.log(quantile))
    while 1 - quantile ** n < confidence:
        n += 1
    while n > 1 and 1 - quantile ** (n - 1) >= confidence:
        n -= 1
    return n


def nearest_rank(samples, quantile):
    ordered = sorted(samples)
    return ordered[max(1, math.ceil(quantile * len(ordered))) - 1]


def median(samples):
    ordered = sorted(samples)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def validate_protocol(doc):
    """Return sorted closed diagnostic codes; empty means the protocol is valid."""
    if not isinstance(doc, dict):
        return ["protocol_not_object"]
    found = set()
    if doc.get("protocol") != PROTOCOL_ID:
        found.add("protocol_id_mismatch")
    if doc.get("revision") != PROTOCOL_REVISION:
        found.add("protocol_revision_mismatch")

    host = doc.get("host")
    host_fields = ("id", "cpu", "logical_cpus", "memory_bytes", "os", "docker_cli", "compose", "orbstack")
    if not isinstance(host, dict) or any(not host.get(field) for field in host_fields):
        found.add("host_incomplete")
    elif not isinstance(host["orbstack"], dict) or any(
            not host["orbstack"].get(field) for field in ("version", "build", "cpu", "memory_mib")):
        found.add("host_incomplete")

    lanes = doc.get("lanes")
    lane_ids = []
    if not isinstance(lanes, list) or not lanes or not all(isinstance(lane, dict) for lane in lanes):
        found.add("lanes_malformed")
        lanes = []
    for lane in lanes:
        lane_id = lane.get("id")
        if not isinstance(lane_id, str) or not LANE_ID.fullmatch(lane_id):
            found.add("lanes_malformed")
            continue
        if lane_id in lane_ids:
            found.add("lane_id_duplicate")
        lane_ids.append(lane_id)
        if lane.get("kind") == "hack":
            if not isinstance(lane.get("commit"), str) or not COMMIT.fullmatch(lane["commit"]):
                found.add("artifact_commit_malformed")
            if not isinstance(lane.get("asset_sha256"), str) or not SHA256.fullmatch(lane["asset_sha256"]):
                found.add("artifact_digest_malformed")
            if not isinstance(lane.get("version"), str) or not VERSION.fullmatch(lane["version"]) \
                    or lane.get("tag") != "v" + str(lane.get("version")):
                found.add("artifact_version_malformed")
        elif lane.get("kind") == "compose":
            if not lane.get("engine") or not lane.get("compose_version"):
                found.add("lanes_malformed")
        else:
            found.add("lanes_malformed")
    if "candidate" not in lane_ids:
        found.add("candidate_lane_missing")
    if any(baseline not in lane_ids for baseline in REQUIRED_BASELINES):
        found.add("baseline_lane_missing")

    workloads = doc.get("workloads")
    if not isinstance(workloads, list) or len(workloads) < 2 or not all(isinstance(w, dict) for w in workloads):
        found.add("workloads_malformed")
        workloads = []
    workload_ids = {w.get("id") for w in workloads}
    if not {"event-agent", "small-fixture"} <= workload_ids:
        found.add("workloads_malformed")
    for workload in workloads:
        applicable = workload.get("lanes")
        if not isinstance(applicable, list) or "candidate" not in applicable:
            found.add("workloads_malformed")
        elif any(lane not in lane_ids for lane in applicable):
            found.add("workload_lane_unknown")
        if not workload.get("correctness"):
            found.add("workloads_malformed")

    cache = doc.get("cache_classes")
    if not isinstance(cache, dict) or not {"warm", "cold-capacity", "cold-cache"} <= set(cache) \
            or cache.get("budget_class") != "warm":
        found.add("cache_class_missing")

    schedule = doc.get("schedule")
    orders = schedule.get("orders") if isinstance(schedule, dict) else None
    if not isinstance(orders, list) or not orders or not all(isinstance(order, list) for order in orders):
        found.add("schedule_lane_set_mismatch")
    else:
        if any(sorted(order) != sorted(lane_ids) or len(set(order)) != len(order) for order in orders):
            found.add("schedule_lane_set_mismatch")
        else:
            planned = doc.get("samples", {}).get("min_lifecycle_runs_per_lane") \
                if isinstance(doc.get("samples"), dict) else None
            if not isinstance(planned, int) or isinstance(planned, bool) \
                    or planned < MIN_ROTATED_LIFECYCLE_RUNS or len(orders) < planned:
                found.add("schedule_rounds_below_minimum")
            if not position_balanced(orders):
                found.add("schedule_position_unbalanced")
            if not carryover_balanced(orders):
                found.add("schedule_carryover_unbalanced")

    samples = doc.get("samples")
    try:
        required = minimum_order_statistic_samples(samples["p95_quantile"], samples["p95_bound_confidence"])
        if samples["p95_quantile"] != 0.95 or samples["p95_min_samples"] < required:
            found.add("p95_samples_insufficient")
    except (TypeError, KeyError, ValueError):
        found.add("p95_samples_insufficient")

    budgets = doc.get("budgets") if isinstance(doc.get("budgets"), dict) else {}
    comparative = {b.get("metric"): b for b in budgets.get("comparative", []) if isinstance(b, dict)}
    for metric, ceiling in COMPARATIVE_CEILINGS.items():
        budget = comparative.get(metric)
        if budget is None:
            found.add("comparative_budget_missing")
        elif not _number(budget.get("max_ratio")) or budget["max_ratio"] > ceiling:
            found.add("comparative_budget_weakened")
    absolute = {b.get("metric"): b for b in budgets.get("absolute", []) if isinstance(b, dict)}
    for metric, (ceiling, ceiling_inclusive) in ABSOLUTE_CEILINGS.items():
        budget = absolute.get(metric)
        if budget is None:
            found.add("absolute_budget_missing")
        elif not _number(budget.get("max")) or not isinstance(budget.get("inclusive"), bool) \
                or budget["max"] > ceiling \
                or (budget["max"] == ceiling and budget["inclusive"] and not ceiling_inclusive):
            found.add("absolute_budget_weakened")
    for budget in list(comparative.values()) + list(absolute.values()):
        if budget.get("statistic") not in STATISTICS:
            found.add("statistic_unknown")

    observer = doc.get("observer")
    if not isinstance(observer, dict) or not _number(observer.get("inconclusive_factor")) \
            or observer["inconclusive_factor"] < 1 or not _number(observer.get("control_window_seconds")) \
            or observer["control_window_seconds"] < 600:
        found.add("observer_policy_missing")

    for limit in doc.get("known_limits", []):
        if not isinstance(limit, dict) or not all(
                _number(limit.get(field)) for field in ("warm_up_seconds", "witness_seconds", "witness_target_seconds")) \
                or not limit.get("issue") or not limit.get("revisit"):
            found.add("known_limit_malformed")
    return sorted(found)


def _samples(entry):
    if not isinstance(entry, dict) or not isinstance(entry.get("samples"), list) \
            or not all(_number(value) for value in entry["samples"]):
        return None, None
    expected = entry.get("expected")
    return entry["samples"], expected if isinstance(expected, int) and not isinstance(expected, bool) else None


def _statistic(samples, statistic):
    if statistic == "median":
        return median(samples)
    if statistic == "p95":
        return nearest_rank(samples, 0.95)
    return sum(samples) / len(samples)


def _sample_floor(protocol, statistic):
    if statistic == "p95":
        return protocol["samples"]["p95_min_samples"]
    return protocol["samples"]["min_lifecycle_runs_per_lane"]


def _judge(protocol, entry, statistic):
    """Return (statistic value or None, inconclusive verdict or None)."""
    if entry is None:
        return None, "inconclusive_missing"
    if isinstance(entry, dict) and entry.get("not_applicable") is True:
        return None, "not_applicable"
    samples, expected = _samples(entry)
    if samples is None or expected is None:
        return None, "inconclusive_missing"
    if len(samples) < expected:
        return None, "inconclusive_coverage"
    if len(samples) < _sample_floor(protocol, statistic):
        return None, "inconclusive_samples"
    return _statistic(samples, statistic), None


def evaluate(protocol, summary):
    """Judge one workload's retained summary. Returns (diagnostics, verdict records).

    Comparative budgets are judged against each applicable baseline separately; there is no
    aggregate. A candidate/baseline difference smaller than inconclusive_factor times the
    observer's own cost for that metric is inconclusive rather than a pass or a fail.
    """
    if not isinstance(summary, dict):
        return ["summary_not_object"], []
    if summary.get("protocol_revision") != protocol["revision"]:
        return ["summary_revision_mismatch"], []
    workloads = {w["id"]: w for w in protocol["workloads"]}
    workload = workloads.get(summary.get("workload"))
    if workload is None:
        return ["summary_workload_unknown"], []
    lanes = summary.get("lanes")
    if not isinstance(lanes, dict) or any(lane not in workload["lanes"] for lane in lanes):
        return ["summary_lane_unknown"], []
    observer = summary.get("observer_cost") if isinstance(summary.get("observer_cost"), dict) else {}
    factor = protocol["observer"]["inconclusive_factor"]
    candidate = lanes.get("candidate") if isinstance(lanes.get("candidate"), dict) else {}
    records = []

    for budget in protocol["budgets"]["comparative"]:
        metric, statistic = budget["metric"], budget["statistic"]
        cand_value, cand_problem = _judge(protocol, candidate.get(metric), statistic)
        for baseline in (lane for lane in workload["lanes"] if lane != "candidate"):
            record = {"workload": workload["id"], "metric": metric, "statistic": statistic,
                      "baseline": baseline, "max_ratio": budget["max_ratio"]}
            base_entry = lanes.get(baseline, {}).get(metric) if isinstance(lanes.get(baseline), dict) else None
            base_value, base_problem = _judge(protocol, base_entry, statistic)
            problem = cand_problem or base_problem
            cost = observer.get(metric)
            if problem is None and not (_number(cost) and cost >= 0):
                problem = "inconclusive_observer"
            if problem is None and base_value <= 0:
                problem = "inconclusive_missing"
            if problem is None:
                record["ratio"] = cand_value / base_value
                if abs(cand_value - base_value) < factor * cost:
                    problem = "inconclusive_observer"
            record["verdict"] = problem or ("pass" if record["ratio"] <= budget["max_ratio"] else "fail")
            records.append(record)

    for budget in protocol["budgets"]["absolute"]:
        if budget.get("workload") not in (None, workload["id"]):
            continue
        metric, statistic = budget["metric"], budget["statistic"]
        record = {"workload": workload["id"], "metric": metric, "statistic": statistic, "max": budget["max"]}
        value, problem = _judge(protocol, candidate.get(metric), statistic)
        if problem is None:
            record["value"] = value
            within = value <= budget["max"] if budget["inclusive"] else value < budget["max"]
            problem = "pass" if within else "fail"
        record["verdict"] = problem
        records.append(record)
    return [], records


def _load(path, unreadable):
    try:
        return json.loads(Path(path).read_text()), None
    except (OSError, ValueError, UnicodeDecodeError):
        return None, unreadable


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--protocol", default=str(DEFAULT_PROTOCOL))
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--schedule", action="store_true")
    mode.add_argument("--evaluate", metavar="SUMMARY")
    args = parser.parse_args(argv)

    protocol, problem = _load(args.protocol, "protocol_unreadable")
    diagnostics = [problem] if problem else validate_protocol(protocol)
    if diagnostics:
        print(json.dumps({"status": "invalid", "diagnostics": diagnostics}))
        return 2
    if args.schedule:
        print(json.dumps({"protocol": PROTOCOL_ID, "revision": PROTOCOL_REVISION,
                          "orders": protocol["schedule"]["orders"]}, indent=2))
        return 0
    if args.evaluate:
        summary, problem = _load(args.evaluate, "summary_unreadable")
        diagnostics, records = ([problem], []) if problem else evaluate(protocol, summary)
        if diagnostics:
            print(json.dumps({"status": "invalid", "diagnostics": diagnostics}))
            return 2
        failed = any(record["verdict"] != "pass" and record["verdict"] != "not_applicable" for record in records)
        print(json.dumps({"status": "judged", "accepted": not failed, "verdicts": records}, indent=2))
        return 1 if failed else 0
    print(json.dumps({"status": "valid", "protocol": PROTOCOL_ID, "revision": PROTOCOL_REVISION,
                      "lanes": len(protocol["lanes"]), "rounds": len(protocol["schedule"]["orders"])}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
