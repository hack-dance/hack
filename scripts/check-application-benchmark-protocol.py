#!/usr/bin/env python3
"""Validate the frozen matched application benchmark protocol and judge retained summaries.

This helper never runs a benchmark, starts a runtime, calls Docker or reads host state. It:

  (default)            validates scripts/application-benchmark-protocol.json against the
                       protocol's invariants and prints a value-free verdict;
  --schedule           prints the frozen rotated lane order for each round;
  --evaluate SUMMARY   judges a retained cohort summary against the frozen budgets.

Revision-1 identities (artifacts, host, lane kinds and backends, candidate capacity,
workload pins, rotated lane order) are exact; budgets and sample counts are floors at
their frozen values, which a revision may tighten.
Every number anywhere in the protocol or a summary must be finite and lie within
MAX_JSON_NUMBER, including fields the checker does not otherwise read.
Diagnostics are closed codes from DIAGNOSTICS; they never echo input values or paths.
A budget verdict is one of VERDICTS. A statistic is judged only from complete,
sufficient, admitted samples: missing, short, flagged or unaccounted samples are
inconclusive, never a pass. The candidate is never `not_applicable`, and a comparative
budget with no applicable baseline is inconclusive. Malformed input is refused with a
closed code (exit 2), never a traceback. See docs/reference/application-benchmark-protocol.md.
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

# Program floors (Linear program acceptance, Gate C) and the frozen revision-1 choices.
# A protocol revision may be stricter than these, never weaker.
MIN_ROTATED_LIFECYCLE_RUNS = 5
# Frozen revision-1 sample counts. These are floors: a revision may plan more, never fewer.
FROZEN_LIFECYCLE_RUNS = 10
FROZEN_P95_MIN_SAMPLES = 60
REQUIRED_BASELINES = ("compose", "hack-4.1.1", "hack-4.2.0", "hack-4.2.1")
# metric: (ceiling ratio, frozen statistic). A ratio at the ceiling passes.
COMPARATIVE_CEILINGS = {
    "steady_physical_footprint_bytes": (0.70, "median"),
    "cpu_seconds_per_task": (0.75, "median"),
    "warm_startup_seconds": (0.80, "median"),
    "warm_restart_seconds": (0.80, "median"),
}
# metric: (ceiling, whether the ceiling itself passes, frozen statistic, frozen scope).
# "p95 <= 100 ms" versus "< 1% of one core". A scope of None means every workload. A
# scoped budget may be broadened to every workload, but no budget may be narrowed.
ABSOLUTE_CEILINGS = {
    "info_latency_ms": (100, True, "p95", None),
    "cached_status_1000_objects_ms": (150, True, "p95", None),
    "warm_admission_ms": (250, True, "p95", None),
    "idle_control_plane_core_fraction": (0.01, False, "window_mean", None),
    "watcher_ack_ms": (200, True, "p95", "small-fixture"),
}
STATISTICS = ("median", "p95", "window_mean")
P95_QUANTILE = 0.95
P95_MIN_CONFIDENCE = 0.95
P95_METHOD = "nearest-rank"
SCHEDULE_DESIGN = "williams"
MIN_OBSERVER_FACTOR = 2
MIN_OBSERVER_WINDOW_SECONDS = 600
WORKLOAD_SHAPES = {
    "event-agent": {"services": 14, "http_health_checks": 9, "initializers": 2},
    "small-fixture": {"services": 2, "http_health_checks": 1, "initializers": 1},
}
# Gate C phases. "restore" is an ordinary up after a retaining down, with data readback.
REQUIRED_PHASES = (
    "cold-startup", "warm-startup", "restart", "restore", "reload", "build-test", "exec",
    "steady-idle", "sustained-load", "shutdown", "cleanup",
)
# Gate C scale points. Revision 1 judges budgets at the single-instance lifecycle only.
SCALE_POINTS = {"branch_instances": (1, 8, 32), "mcp_clients": (1, 32)}
JUDGED_SCALE = {"branch_instances": 1}

# Revision-1 identities. These are exact, not floors: a different artifact, host, lane
# kind or backend, candidate capacity or workload pin is a different experiment and
# needs a new revision (and new constants here), never an edit to revision 1.
FROZEN_HOST = {
    "id": "m3-max",
    "cpu": "Apple M3 Max",
    "logical_cpus": 16,
    "memory_bytes": 137438953472,
    "os": "macOS 27.0",
    "docker_cli": "29.4.0",
    "compose": "5.1.2",
    "orbstack": {"version": "2.2.3", "build": "20963", "cpu": 16, "memory_mib": 71680},
}
# Fields that identify the exact released artifact a lane installs.
ARTIFACT_FIELDS = ("version", "tag", "commit", "asset", "asset_sha256")
# Fields that identify how a lane runs.
LANE_RUNTIME_FIELDS = ("kind", "backend", "engine", "compose_version")
FROZEN_LANES = {
    "candidate": {
        "kind": "hack", "backend": "native", "version": "5.0.0-next.5", "tag": "v5.0.0-next.5",
        "commit": "28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc",
        "asset": "hack-5.0.0-next.5-darwin-arm64-native.tar.gz",
        "asset_sha256": "ba1da4d349ab70069a1b0775ba671838440b5479cffd1fc2fe41c59816c3df11",
    },
    "compose": {"kind": "compose", "backend": "docker-compose", "engine": "orbstack", "compose_version": "5.1.2"},
    "hack-4.1.1": {
        "kind": "hack", "backend": "compose", "version": "4.1.1", "tag": "v4.1.1",
        "commit": "74bf0672f41bd3f68a4ce6cba28b9ba15467c2b2",
        "asset": "hack-4.1.1-darwin-arm64.tar.gz",
        "asset_sha256": "968f75fe66cd84fdf93b0c5b64ca5df02f98c74281b5a9238125b3afd2f3d72b",
    },
    "hack-4.2.0": {
        "kind": "hack", "backend": "compose", "version": "4.2.0", "tag": "v4.2.0",
        "commit": "575847486963db94623e1e7f8cd49acca286c517",
        "asset": "hack-4.2.0-darwin-arm64.tar.gz",
        "asset_sha256": "c62b533aaddbeaafa594cab682cf10041c9bcaea69e2fe25e33e85df49654a85",
    },
    "hack-4.2.1": {
        "kind": "hack", "backend": "compose", "version": "4.2.1", "tag": "v4.2.1",
        "commit": "5a4c51babb7ef725a30f2f3fd3677081a64bc247",
        "asset": "hack-4.2.1-darwin-arm64.tar.gz",
        "asset_sha256": "557583d946abcd0dd0a3fa12b2f7b81f18310d594b0699d663ebf239d0d4d729",
    },
}
# The native `development` profile: graph execution, and so every workload here,
# refuses any other profile (see the protocol page, "Capacities").
FROZEN_CANDIDATE_CAPACITY = {"profile": "development", "vcpus": 4, "memory_mib": 6144, "storage_gib": 32,
                             "overlay_gib": 10}
FROZEN_WORKLOAD_PINS = {
    "event-agent": "application commit and configuration digest recorded per cohort; identical across lanes",
    "small-fixture": "image oven/bun:1.4.2-slim with its image ID recorded per cohort, pull never",
}
# Frozen correctness checks per workload. A revision may add checks, never drop one.
FROZEN_CORRECTNESS = {
    "event-agent": (
        "all declared long-running services running and every HTTP health check healthy",
        "both initializers exited 0",
        "routed sign-in page returns HTTP 200",
        "a per-run data marker written before restart reads back after restart",
    ),
    "small-fixture": (
        "initializer creates the SQLite schema in a named volume and exits 0",
        "web health endpoint returns HTTP 200",
        "check task inserts a per-run row and reads the expected count",
        "the row reads back after restart",
        "a source edit is served within the watcher acknowledgement window",
    ),
}
# Largest JSON number magnitude accepted anywhere: the I-JSON (RFC 7493) interoperable
# integer range. Bounding every number keeps each statistic and ratio finite and keeps
# Python from converting an unbounded JSON integer to a float.
MAX_JSON_NUMBER = 2 ** 53 - 1

DIAGNOSTICS = frozenset({
    "protocol_unreadable",
    "protocol_not_object",
    "protocol_id_mismatch",
    "protocol_revision_mismatch",
    "host_incomplete",
    "host_mismatch",
    "lanes_malformed",
    "lane_id_duplicate",
    "compose_lane_host_mismatch",
    "candidate_lane_missing",
    "baseline_lane_missing",
    "artifact_commit_malformed",
    "artifact_digest_malformed",
    "artifact_version_malformed",
    "artifact_identity_mismatch",
    "lane_runtime_mismatch",
    "candidate_capacity_mismatch",
    "workloads_malformed",
    "workload_lane_unknown",
    "workload_baseline_missing",
    "workload_shape_mismatch",
    "workload_pin_mismatch",
    "workload_correctness_weakened",
    "phases_mismatch",
    "scale_points_mismatch",
    "cache_class_missing",
    "schedule_design_mismatch",
    "schedule_lane_set_mismatch",
    "schedule_rounds_below_minimum",
    "schedule_rounds_mismatch",
    "schedule_position_unbalanced",
    "schedule_carryover_unbalanced",
    "schedule_order_mismatch",
    "p95_samples_insufficient",
    "p95_method_mismatch",
    "comparative_budget_missing",
    "comparative_budget_weakened",
    "absolute_budget_missing",
    "absolute_budget_weakened",
    "budget_statistic_mismatch",
    "budget_scope_narrowed",
    "statistic_unknown",
    "observer_policy_missing",
    "known_limit_malformed",
    "protocol_number_out_of_range",
    "summary_unreadable",
    "summary_not_object",
    "summary_number_out_of_range",
    "summary_revision_mismatch",
    "summary_workload_unknown",
    "summary_cache_class_mismatch",
    "summary_scale_unknown",
    "summary_scale_not_judged",
    "summary_lane_unknown",
    "summary_lane_malformed",
    "summary_entry_malformed",
    "summary_observer_malformed",
    "summary_candidate_not_applicable",
})

VERDICTS = frozenset({
    "pass",
    "fail",
    "not_applicable",
    "inconclusive_coverage",
    "inconclusive_samples",
    "inconclusive_admission",
    "inconclusive_observer",
    "inconclusive_missing",
    "inconclusive_no_baseline",
})
ACCEPTING_VERDICTS = frozenset({"pass", "not_applicable"})

SAMPLE_ENTRY_KEYS = frozenset({"samples", "expected", "flagged", "failed"})
NOT_APPLICABLE_KEYS = frozenset({"not_applicable", "reason"})


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


# The frozen revision-1 rotation: the Williams square for this lane sequence. Another
# balanced order is a different schedule, so it needs a new revision.
FROZEN_LANE_SEQUENCE = ("candidate", "compose", "hack-4.1.1", "hack-4.2.0", "hack-4.2.1")
FROZEN_ORDERS = williams_orders(list(FROZEN_LANE_SEQUENCE))


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
    """A finite JSON number within MAX_JSON_NUMBER; a boolean is not a number.

    The range comparison never converts an int to a float, so an oversized integer is
    refused rather than raising OverflowError, and NaN and infinities compare false.
    """
    return isinstance(value, (int, float)) and not isinstance(value, bool) \
        and -MAX_JSON_NUMBER <= value <= MAX_JSON_NUMBER


def _numbers_in_range(value):
    """True when every number anywhere in a JSON value satisfies _number.

    Booleans are not numbers and object keys are strings, so neither is checked. The
    walk is iterative, so a deeply nested value cannot raise RecursionError.
    """
    pending = [value]
    while pending:
        node = pending.pop()
        if isinstance(node, dict):
            pending.extend(node.values())
        elif isinstance(node, list):
            pending.extend(node)
        elif isinstance(node, (int, float)) and not isinstance(node, bool) and not _number(node):
            return False
    return True


def _same(value, frozen):
    """Exact JSON equality: unlike ==, 4.0 is not 4 and true is not 1."""
    return json.dumps(value, sort_keys=True) == json.dumps(frozen, sort_keys=True)


def _count(value):
    """A non-negative JSON integer; a boolean is not a count."""
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _strings(value):
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def _check_host(host, found):
    fields = ("id", "cpu", "logical_cpus", "memory_bytes", "os", "docker_cli", "compose", "orbstack")
    if not isinstance(host, dict) or any(not host.get(field) for field in fields):
        found.add("host_incomplete")
    elif not isinstance(host["orbstack"], dict) or any(
            not host["orbstack"].get(field) for field in ("version", "build", "cpu", "memory_mib")):
        found.add("host_incomplete")
    # Native stateful results are host-specific: any other host or engine is a new revision.
    if not _same(host, FROZEN_HOST):
        found.add("host_mismatch")


def _check_lane_identity(lane_id, lane, found):
    """Refuse a frozen lane whose artifact, runtime or capacity differs from revision 1.

    A missing field counts as different, so removing an identity cannot weaken it.
    """
    frozen = FROZEN_LANES.get(lane_id)
    if frozen is None:
        return
    for field in ARTIFACT_FIELDS + LANE_RUNTIME_FIELDS:
        if (field in frozen or field in lane) and not _same(lane.get(field), frozen.get(field)):
            found.add("artifact_identity_mismatch" if field in ARTIFACT_FIELDS else "lane_runtime_mismatch")
    if lane_id == "candidate":
        if not _same(lane.get("capacity"), FROZEN_CANDIDATE_CAPACITY):
            found.add("candidate_capacity_mismatch")
    elif "capacity" in lane:
        # Baselines run with the shared engine's default capacity; a per-lane capacity
        # would make them a different experiment.
        found.add("lane_runtime_mismatch")


def _check_lanes(lanes, host, found):
    """Return the well-formed lane ids, in order."""
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
                    or lane.get("tag") != "v" + lane["version"]:
                found.add("artifact_version_malformed")
        elif lane.get("kind") == "compose":
            if not lane.get("engine") or not lane.get("compose_version"):
                found.add("lanes_malformed")
            # The direct Compose lane is the frozen host's own engine and Compose.
            elif not isinstance(host, dict) or lane["engine"] != "orbstack" \
                    or lane["compose_version"] != host.get("compose"):
                found.add("compose_lane_host_mismatch")
        else:
            found.add("lanes_malformed")
        _check_lane_identity(lane_id, lane, found)
    if "candidate" not in lane_ids:
        found.add("candidate_lane_missing")
    if any(baseline not in lane_ids for baseline in REQUIRED_BASELINES):
        found.add("baseline_lane_missing")
    return lane_ids


def _check_workloads(workloads, lane_ids, found):
    """Return the workload ids when every workload has a distinct string id; otherwise []."""
    if not isinstance(workloads, list) or not all(isinstance(w, dict) for w in workloads):
        found.add("workloads_malformed")
        return []
    ids = [w.get("id") for w in workloads]
    if not _strings(ids) or len(set(ids)) != len(ids):
        found.add("workloads_malformed")
        ids = []
    if not set(WORKLOAD_SHAPES) <= set(ids):
        found.add("workloads_malformed")
    for workload in workloads:
        applicable = workload.get("lanes")
        if not _strings(applicable) or len(set(applicable)) != len(applicable) or "candidate" not in applicable:
            found.add("workloads_malformed")
        else:
            if any(lane not in lane_ids for lane in applicable):
                found.add("workload_lane_unknown")
            # Every workload is compared against every required baseline; dropping one
            # from a workload would silently drop that workload's comparison.
            if any(baseline not in applicable for baseline in REQUIRED_BASELINES):
                found.add("workload_baseline_missing")
        if not _strings(workload.get("correctness")) or not workload["correctness"]:
            found.add("workloads_malformed")
        workload_id = workload.get("id")
        shape = WORKLOAD_SHAPES.get(workload_id) if isinstance(workload_id, str) else None
        if shape is not None and not _same(workload.get("shape"), shape):
            found.add("workload_shape_mismatch")
        if isinstance(workload_id, str) and workload_id in FROZEN_WORKLOAD_PINS:
            if not _same(workload.get("pin"), FROZEN_WORKLOAD_PINS[workload_id]):
                found.add("workload_pin_mismatch")
            checks = workload.get("correctness")
            if not _strings(checks) or not set(FROZEN_CORRECTNESS[workload_id]) <= set(checks):
                found.add("workload_correctness_weakened")
    return ids


def _check_phases_and_scale(doc, found):
    phases = doc.get("phases")
    if not _strings(phases) or len(set(phases)) != len(phases) or not set(REQUIRED_PHASES) <= set(phases):
        found.add("phases_mismatch")
    scale = doc.get("scale_points")
    if not isinstance(scale, dict) or scale.get("judged") != JUDGED_SCALE:
        found.add("scale_points_mismatch")
        return
    for kind, required in SCALE_POINTS.items():
        points = scale.get(kind)
        if not isinstance(points, list) or not all(_count(point) and point > 0 for point in points) \
                or not set(required) <= set(points):
            found.add("scale_points_mismatch")


def _check_schedule(doc, lane_ids, found):
    schedule = doc.get("schedule") if isinstance(doc.get("schedule"), dict) else {}
    if schedule.get("design") != SCHEDULE_DESIGN:
        found.add("schedule_design_mismatch")
    orders = schedule.get("orders")
    if not isinstance(orders, list) or not orders or not all(_strings(order) for order in orders) \
            or any(sorted(order) != sorted(lane_ids) or len(set(order)) != len(order) for order in orders):
        found.add("schedule_lane_set_mismatch")
        return
    rounds = schedule.get("rounds_per_workload")
    if not _count(rounds) or rounds != len(orders):
        found.add("schedule_rounds_mismatch")
    samples = doc.get("samples") if isinstance(doc.get("samples"), dict) else {}
    planned = samples.get("min_lifecycle_runs_per_lane")
    if not _count(planned) or planned < max(MIN_ROTATED_LIFECYCLE_RUNS, FROZEN_LIFECYCLE_RUNS) \
            or len(orders) < planned:
        found.add("schedule_rounds_below_minimum")
    if not position_balanced(orders):
        found.add("schedule_position_unbalanced")
    if not carryover_balanced(orders):
        found.add("schedule_carryover_unbalanced")
    if orders != FROZEN_ORDERS:
        found.add("schedule_order_mismatch")


def _check_samples(doc, found):
    samples = doc.get("samples") if isinstance(doc.get("samples"), dict) else {}
    quantile = samples.get("p95_quantile")
    confidence = samples.get("p95_bound_confidence")
    floor = samples.get("p95_min_samples")
    if not _number(quantile) or quantile != P95_QUANTILE \
            or not _number(confidence) or not P95_MIN_CONFIDENCE <= confidence < 1 \
            or not _count(floor) or floor < FROZEN_P95_MIN_SAMPLES \
            or floor < minimum_order_statistic_samples(P95_QUANTILE, confidence):
        found.add("p95_samples_insufficient")
    if samples.get("p95_method") != P95_METHOD:
        found.add("p95_method_mismatch")


def _budget_index(items, kind, found):
    """Index a budget list by metric; malformed or duplicate entries weaken the list."""
    if not isinstance(items, list):
        found.add(f"{kind}_budget_missing")
        return {}
    index = {}
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("metric"), str) or item["metric"] in index:
            found.add(f"{kind}_budget_weakened")
            continue
        index[item["metric"]] = item
    return index


def _check_budgets(doc, workload_ids, found):
    budgets = doc.get("budgets") if isinstance(doc.get("budgets"), dict) else {}
    comparative = _budget_index(budgets.get("comparative"), "comparative", found)
    absolute = _budget_index(budgets.get("absolute"), "absolute", found)
    # Structural checks for every listed budget, frozen or additional: the evaluator
    # judges each listed budget, so each must be judgeable.
    for budget in list(comparative.values()) + list(absolute.values()):
        if budget.get("statistic") not in STATISTICS:
            found.add("statistic_unknown")
    for budget in comparative.values():
        if not _number(budget.get("max_ratio")):
            found.add("comparative_budget_weakened")
    for budget in absolute.values():
        if not _number(budget.get("max")) or not isinstance(budget.get("inclusive"), bool):
            found.add("absolute_budget_weakened")
        scope = budget.get("workload")
        if scope is not None and scope not in workload_ids:
            found.add("budget_scope_narrowed")

    for metric, (ceiling, statistic) in COMPARATIVE_CEILINGS.items():
        budget = comparative.get(metric)
        if budget is None:
            found.add("comparative_budget_missing")
            continue
        if _number(budget.get("max_ratio")) and budget["max_ratio"] > ceiling:
            found.add("comparative_budget_weakened")
        if budget.get("statistic") in STATISTICS and budget["statistic"] != statistic:
            found.add("budget_statistic_mismatch")
    for metric, (ceiling, ceiling_inclusive, statistic, scope) in ABSOLUTE_CEILINGS.items():
        budget = absolute.get(metric)
        if budget is None:
            found.add("absolute_budget_missing")
            continue
        if _number(budget.get("max")) and isinstance(budget.get("inclusive"), bool) and (
                budget["max"] > ceiling
                or (budget["max"] == ceiling and budget["inclusive"] and not ceiling_inclusive)):
            found.add("absolute_budget_weakened")
        if budget.get("statistic") in STATISTICS and budget["statistic"] != statistic:
            found.add("budget_statistic_mismatch")
        if budget.get("workload") not in (None, scope):
            found.add("budget_scope_narrowed")


def validate_protocol(doc):
    """Return sorted closed diagnostic codes; empty means the protocol is valid.

    Never raises on any JSON value: every malformed node maps to a closed code.
    """
    if not isinstance(doc, dict):
        return ["protocol_not_object"]
    found = set()
    if not _numbers_in_range(doc):
        found.add("protocol_number_out_of_range")
    if doc.get("protocol") != PROTOCOL_ID:
        found.add("protocol_id_mismatch")
    if not _count(doc.get("revision")) or doc["revision"] != PROTOCOL_REVISION:
        found.add("protocol_revision_mismatch")
    _check_host(doc.get("host"), found)
    lane_ids = _check_lanes(doc.get("lanes"), doc.get("host"), found)
    workload_ids = _check_workloads(doc.get("workloads"), lane_ids, found)
    _check_phases_and_scale(doc, found)

    cache = doc.get("cache_classes")
    if not isinstance(cache, dict) or not {"warm", "cold-capacity", "cold-cache"} <= set(cache) \
            or cache.get("budget_class") != "warm":
        found.add("cache_class_missing")

    _check_schedule(doc, lane_ids, found)
    _check_samples(doc, found)
    _check_budgets(doc, workload_ids, found)

    observer = doc.get("observer")
    if not isinstance(observer, dict) or not _number(observer.get("inconclusive_factor")) \
            or observer["inconclusive_factor"] < MIN_OBSERVER_FACTOR \
            or not _number(observer.get("control_window_seconds")) \
            or observer["control_window_seconds"] < MIN_OBSERVER_WINDOW_SECONDS:
        found.add("observer_policy_missing")

    limits = doc.get("known_limits", [])
    if not isinstance(limits, list):
        found.add("known_limit_malformed")
        limits = []
    for limit in limits:
        if not isinstance(limit, dict) or not all(
                _number(limit.get(field)) for field in ("warm_up_seconds", "witness_seconds", "witness_target_seconds")) \
                or not limit.get("issue") or not limit.get("revisit"):
            found.add("known_limit_malformed")
    return sorted(found)


def _entry_malformed(entry):
    """True when a budget-metric entry is neither a sample record nor a not-applicable record.

    A sample record is {"samples": [non-negative numbers], "expected": positive int,
    "flagged": count, "failed": count}; samples hold only admitted samples, and flagged
    or failed lifecycles are counted, not listed. A not-applicable record is exactly
    {"not_applicable": true, "reason": non-empty string}: it can never carry samples.
    """
    if not isinstance(entry, dict):
        return True
    if "not_applicable" in entry:
        return set(entry) != NOT_APPLICABLE_KEYS or entry["not_applicable"] is not True \
            or not isinstance(entry["reason"], str) or not entry["reason"].strip()
    if not set(entry) <= SAMPLE_ENTRY_KEYS:
        return True
    samples = entry.get("samples")
    if not isinstance(samples, list) or not all(_number(value) and value >= 0 for value in samples):
        return True
    if any(field in entry and not _count(entry[field]) for field in ("flagged", "failed")):
        return True
    expected = entry.get("expected")
    if expected is None:
        return False
    if not _count(expected) or expected == 0:
        return True
    # More accounted samples than planned means unplanned reruns, which could select results.
    return len(samples) + entry.get("flagged", 0) + entry.get("failed", 0) > expected


def _scale_known(protocol, scale):
    if not isinstance(scale, dict) or len(scale) != 1:
        return False
    ((kind, count),) = scale.items()
    points = protocol["scale_points"].get(kind) if kind in SCALE_POINTS else None
    return isinstance(points, list) and _count(count) and count in points


def _budget_metrics(protocol):
    return {budget["metric"] for kind in ("comparative", "absolute") for budget in protocol["budgets"][kind]}


def validate_summary(protocol, summary):
    """Return (sorted closed diagnostics, workload); a summary with diagnostics is never judged.

    `protocol` must already be valid. Never raises on any JSON value.
    """
    if not isinstance(summary, dict):
        return ["summary_not_object"], None
    if not _count(summary.get("protocol_revision")) or summary["protocol_revision"] != protocol["revision"]:
        return ["summary_revision_mismatch"], None
    workload_id = summary.get("workload")
    workloads = {w["id"]: w for w in protocol["workloads"]}
    workload = workloads.get(workload_id) if isinstance(workload_id, str) else None
    if workload is None:
        return ["summary_workload_unknown"], None
    found = set()
    if not _numbers_in_range(summary):
        found.add("summary_number_out_of_range")
    # Budgets are frozen for the warm class only; other classes are reported separately.
    if summary.get("cache_class") != protocol["cache_classes"]["budget_class"]:
        found.add("summary_cache_class_mismatch")
    if not _scale_known(protocol, summary.get("scale")):
        found.add("summary_scale_unknown")
    elif summary["scale"] != protocol["scale_points"]["judged"]:
        found.add("summary_scale_not_judged")

    observer = summary.get("observer_cost", {})
    if not isinstance(observer, dict) or not all(_number(cost) and cost >= 0 for cost in observer.values()):
        found.add("summary_observer_malformed")

    lanes = summary.get("lanes")
    if not isinstance(lanes, dict):
        found.add("summary_lane_malformed")
        return sorted(found), workload
    metrics = _budget_metrics(protocol)
    for lane_id, lane in lanes.items():
        if lane_id not in workload["lanes"]:
            found.add("summary_lane_unknown")
        if not isinstance(lane, dict):
            found.add("summary_lane_malformed")
            continue
        for metric in metrics & set(lane):
            if _entry_malformed(lane[metric]):
                found.add("summary_entry_malformed")
            elif lane_id == "candidate" and "not_applicable" in lane[metric]:
                # The candidate is the subject of every budget: it cannot opt out of one.
                found.add("summary_candidate_not_applicable")
    return sorted(found), workload


def window_mean(samples):
    """The correctly rounded sum divided by the count.

    Built-in sum() rounds after every addition, and Python 3.12 changed how, so a mean
    at an exclusive ceiling (ten samples of 0.01) could land just below it on one
    interpreter and on it on another. math.fsum gives the same verdict everywhere.
    """
    return math.fsum(samples) / len(samples)


def _statistic(samples, statistic):
    if statistic == "median":
        return median(samples)
    if statistic == "p95":
        return nearest_rank(samples, P95_QUANTILE)
    return window_mean(samples)


def _sample_floor(protocol, statistic):
    if statistic == "p95":
        return protocol["samples"]["p95_min_samples"]
    return protocol["samples"]["min_lifecycle_runs_per_lane"]


def _judge(protocol, entry, statistic, candidate):
    """Return (statistic value or None, verdict or None) for a validated entry.

    A None verdict means the value is judgeable. A failed candidate lifecycle is a
    failure; a flagged sample, an unaccounted admission or a failed baseline lifecycle
    leaves the statistic inconclusive.
    """
    if entry is None:
        return None, "inconclusive_missing"
    if "not_applicable" in entry:
        return None, "not_applicable"
    if candidate and entry.get("failed"):
        return None, "fail"
    expected = entry.get("expected")
    if expected is None:
        return None, "inconclusive_missing"
    if not _count(entry.get("flagged")) or not _count(entry.get("failed")) or entry["flagged"] or entry["failed"]:
        return None, "inconclusive_admission"
    samples = entry["samples"]
    if len(samples) < expected:
        return None, "inconclusive_coverage"
    if len(samples) < _sample_floor(protocol, statistic):
        return None, "inconclusive_samples"
    return _statistic(samples, statistic), None


def evaluate(protocol, summary):
    """Judge one workload's retained summary. Returns (diagnostics, verdict records).

    Comparative budgets are judged against each applicable baseline separately; there is no
    aggregate. A candidate/baseline difference smaller than inconclusive_factor times the
    observer's own cost for that metric is inconclusive rather than a pass or a fail. A
    comparative budget whose baselines are all not_applicable gets one extra
    inconclusive_no_baseline record, so it can never be accepted without a comparison.
    """
    diagnostics, workload = validate_summary(protocol, summary)
    if diagnostics:
        return diagnostics, []
    lanes = summary["lanes"]
    observer = summary.get("observer_cost", {})
    factor = protocol["observer"]["inconclusive_factor"]
    candidate = lanes.get("candidate", {})
    records = []

    for budget in protocol["budgets"]["comparative"]:
        metric, statistic = budget["metric"], budget["statistic"]
        cand_value, cand_problem = _judge(protocol, candidate.get(metric), statistic, candidate=True)
        applicable = 0
        for baseline in (lane for lane in workload["lanes"] if lane != "candidate"):
            record = {"workload": workload["id"], "metric": metric, "statistic": statistic,
                      "baseline": baseline, "max_ratio": budget["max_ratio"]}
            base_value, base_problem = _judge(protocol, lanes.get(baseline, {}).get(metric), statistic,
                                              candidate=False)
            if base_problem == "not_applicable":
                record["verdict"] = "not_applicable"
                records.append(record)
                continue
            applicable += 1
            problem = cand_problem or base_problem
            cost = observer.get(metric)
            if problem is None and cost is None:
                problem = "inconclusive_observer"
            if problem is None and base_value <= 0:
                problem = "inconclusive_missing"
            ratio = None
            if problem is None:
                ratio = cand_value / base_value
                # A tiny positive baseline can overflow the ratio to infinity: that is a
                # failure, but only a finite ratio is printed, so the report stays strict JSON.
                if math.isfinite(ratio):
                    record["ratio"] = ratio
                if abs(cand_value - base_value) < factor * cost:
                    problem = "inconclusive_observer"
            record["verdict"] = problem or ("pass" if ratio <= budget["max_ratio"] else "fail")
            records.append(record)
        if applicable == 0:
            records.append({"workload": workload["id"], "metric": metric, "statistic": statistic,
                            "max_ratio": budget["max_ratio"], "applicable_baselines": 0,
                            "verdict": "fail" if cand_problem == "fail" else "inconclusive_no_baseline"})

    for budget in protocol["budgets"]["absolute"]:
        if budget.get("workload") not in (None, workload["id"]):
            continue
        metric, statistic = budget["metric"], budget["statistic"]
        record = {"workload": workload["id"], "metric": metric, "statistic": statistic, "max": budget["max"]}
        value, problem = _judge(protocol, candidate.get(metric), statistic, candidate=True)
        if problem is None:
            record["value"] = value
            within = value <= budget["max"] if budget["inclusive"] else value < budget["max"]
            problem = "pass" if within else "fail"
        record["verdict"] = problem
        records.append(record)
    return [], records


def accepted(records):
    """A summary is accepted only when it has verdicts and every one is pass or not_applicable."""
    return bool(records) and all(record["verdict"] in ACCEPTING_VERDICTS for record in records)


def _load(path, unreadable):
    try:
        return json.loads(Path(path).read_text()), None
    except (OSError, ValueError, UnicodeDecodeError, RecursionError):
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
        ok = accepted(records)
        print(json.dumps({"status": "judged", "accepted": ok, "verdicts": records}, indent=2))
        return 0 if ok else 1
    print(json.dumps({"status": "valid", "protocol": PROTOCOL_ID, "revision": PROTOCOL_REVISION,
                      "lanes": len(protocol["lanes"]), "rounds": len(protocol["schedule"]["orders"])}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
