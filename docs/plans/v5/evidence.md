# Candidate evidence and decisions

This is a sanitized summary of private September 8–9 experiments. Exact scripts, pinned artifacts,
raw logs, machine inventories, and failed attempts remain in private research storage. No raw
timing in this document is a comparative performance claim.

| Observation | What it changes | What it does not establish |
| --- | --- | --- |
| Small VZ native-storage fixture passed watcher, graph, persistence, and cancellation cells | Keep VZ as a functioning reference | Best performance, hostile containment, real project parity |
| Tested host forwarding missed atomic replacement and deletion | Prefer native source plus explicit sync for the new lane | That every host filesystem/provider has the same defect |
| Native reconciliation and immutable-input prototype passed positive and negative cells | Preserve source barrier and snapshot separation in the product | Automatic sync, large trees, crash durability, production code |
| SmolVM privately booted and ran the synthetic graph | Select SmolVM/libkrun as the first product adapter | Winning memory/startup/DX or portable checkpoint support |
| SmolVM persistent guest PID state conflicted after restart | Require ephemeral runtime directories and actual restart tests | That clean restart proves sudden-crash durability |
| Krunkit required ABI/build and storage/shutdown fixes | Retain as a challenger; record integration/maintenance cost | That warm graph success qualifies dedicated data-disk persistence |
| Early krunkit counters missed the VM process | Attribute helpers/descendants before comparing memory | A tiny launcher is a tiny running environment |
| Corrected repeated comparison stopped before boot on admission | Keep performance decision open; retain failed/incomplete cohort | A backend failure or permission to weaken experiment thresholds |
| Stock Apple container startup needed global service integration | Defer in the private candidate lane | A general performance or capability rejection |
| No selected native Linux host completed parity | Make Linux/SSH acceptance a distinct work unit | Remote Mac tests imply native Linux performance |

## Candidate decisions after review

The user chose to begin implementation with SmolVM/libkrun, emphasizing speed, low resource use,
ergonomics, and portability. The choice is reversible through a small provider contract. Docker/
Compose remain the initial engine and compatibility path. Rust is introduced in a separate local
core package; rewriting the stable CLI and replacing the engine are not prerequisites.

The earlier design's safety, source identity, durable operation, environment, terminal, networking,
remote, and migration contracts remain. Their delivery is staged in the work-unit ledger. Live
memory snapshots and hostile multi-user execution stay behind separate capability gates.

## Carried-forward acceptance coverage

| Earlier contract family | Candidate coverage |
| --- | --- |
| Authority, capabilities, helpers, extensibility (R01–05) | Spec §§3–4, 8; WU02, WU04, WU09, WU11 |
| Identity, journal, idempotency, state machines (R06–09) | Spec §4; WU03–04, WU08 |
| Native plan and Compose compatibility (R10–12) | Spec §§2, 5; WU03, WU07; new public YAML format deferred |
| Source, caches, data, builders, snapshots (R13–18) | Spec §5; WU05–07, WU10–11 |
| Admission, locality, watchers, resources (R19–22) | Spec §§6–7; WU02, WU05, WU09–10 |
| Principals, isolation, env, credentials, supervision (R23–27) | Spec §§4, 8; WU04, WU08–09, WU11 |
| Endpoints and trust (R28–29) | Spec §7; WU07, WU09, WU11 |
| Remote authority, reservations, Harness boundary (R30–32) | Spec §§7–8; WU08–09 |
| API, read-only behavior, evidence levels (R33–35) | Spec §§4, 7, 9; WU01, WU04, WU08 |
| Migration, packages, slim, guidance, release gates (R36–40) | Spec §§2, 8–9; WU11 |

The previous A01–A27 matrix is retained privately for detailed adversarial cases. The candidate
units carry its mandatory outcomes: identity/ownership, duplicate/ambiguous effects, crash and
cancellation, PTYs, graph/env/source/data parity, cache races, remote partitions/reservations,
account/toolchain drift, trust lifecycle, expiring credentials, endpoint claims, bounded streams,
performance, slim execution, packaged handshakes, migration, guidance, and semantic result evidence.
Hostile cross-principal and `isolated-vm` confinement require separate platform-specific tests before
those capabilities are advertised. No new checkpoint inherits a passing result merely from this map.
