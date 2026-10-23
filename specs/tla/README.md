# Supervisor model checks

From the repository root:

```sh
mise install
mise exec -- bun install --frozen-lockfile
mise exec -- bun run check:tla --download
```

The repository check command is **`bun run check:tla`**. With Bun 1.3.9 and Java 17
already selected, run it directly. `--download` only bootstraps a missing jar;
subsequent checks use the verified cache. Alternatively, `TLA2TOOLS_JAR` selects an
existing jar and `JAVA_BIN` selects Java 17. Every jar is checked against the same
committed SHA-256 before execution; a mismatch fails without replacing the file.

The restored tooling comes from source commit
`c15fd8117547a11148f540ae9bbc0b4baf9c30b9`. Only the checker structure, generic
result validation, tool pin, and relevant tool selections were retained. No old
product models or product changes were imported.

TLC is the official `v1.7.4/tla2tools.jar`, pinned to
`936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`.
The observed banner is `TLC2 Version 2.19 of 08 August 2024 (rev: 5a47802)`.
The checker uses one worker, a 512 MiB heap, fixed seed/fingerprint, and a 120-second
limit per subprocess. Deadlock checking stays enabled; explicit terminal stuttering
is limited to returned invocations (including rejected persistence), completed
cancellation acknowledgements, and unstarted invocations blocked by reference
deduplication. Active states cannot use `Idle` to hide a deadlock. A returned run
with rejected persistence still violates P4 `ClaimedTerminal`; a terminal return
does not imply durable success. This TLC version generates trace specifications
only when requested;
the checker does not request them. Temporary models, Java instrumentation, and state
directories are removed after each run. The jar cache and generated traces are ignored.

TLC 1.7.4 does not name temporal violations. The disposable Java launcher checks that
the config enables exactly one property, then records its name only when TLC emits
its actual temporal-violation event. The jar is unmodified. Exit 12 plus the exact
invariant diagnostic or exit 13 plus the exact temporal diagnostic is required;
parse errors, timeouts, unrelated violations, and unexpected passes fail the check.

The command runs actual-code baselines, separately labeled hypothetical references,
every checked-in mutation config, deterministic implementation replays and isolated
source mutations, then restored baselines. The replay harness also rejects unrelated
failures. Passing reference controls are not shipped repairs or product evidence.

**P1–P4 deliberately reproduce current guarantee gaps.** A zero wrapper exit means
all expected evidence matched, including those violations. P5 checks the existing
invocation-local cancellation promise and passes. See [coverage](../fv/COVERAGE.md)
for individual findings, limits, fairness assumptions, and source sync revisions.
The model's serialized store schedules do not establish store linearizability.
