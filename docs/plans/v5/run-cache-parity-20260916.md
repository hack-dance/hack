# One-off dependency-cache parity

The candidate Compose command path now supplies `hack run` with the same
lockfile/runtime-keyed volume override used by `up` and `restart`. The override
precedes runtime-host metadata and environment overlays, preserving existing
precedence and branch/profile/service selection.

A running target alone no longer permits `--no-deps` for a declared cache. A
bounded Docker inspection verifies the target ID, running state, Compose project
and service labels, and all selected cache volume names. The inspection uses the
same environment and working directory as Compose, and requests no container
environment or command arguments. Missing/mismatched mounts, uncertain identity,
or inspection failure leaves dependency reconciliation to Compose. Caches mounted
only by other services take this conservative reconciliation path. Unlabelled
services keep the existing behavior without extra inspection.

`exec` continues using the existing container. A one-off `run` can populate a new
cache while the existing service still mounts the old one; `restart` adopts the
new selection. The fix does not silently replace that running service, certify
cache completeness, or remove old caches.

## Verification

The maintained `tests/e2e/run-dependency-cache.test.ts` invokes the actual source
CLI with a recording Docker stub and isolated homes. It covers primary/linked
worktree selection, warm cache reuse, changed lockfiles, wrong identity/project/
service/mount type, stopped targets, malformed/failed inspection and unlabelled
services. The previous command path failed the cache-selection and invalidation
regressions, confirming the tests distinguish this correction. Existing branch
and dependency-cache tests also passed.

The compiled current-branch CLI then ran against a private Docker 29.5.2 engine
with the pinned Bun image already loaded, private home/client configuration,
unique project names and no global DNS/TLS dependency. Actual named-volume marker
readback and inspected mounts confirmed:

| Control | Observed result |
| --- | --- |
| Candidate `up`, `exec`, warm `run` | Same populated cache and marker |
| Installed Hack 4.2.0 `run` after candidate `up` | Created the old per-instance volume; marker read failed |
| Linked-worktree cold `run`, `up`, warm `run` | Reused the primary cache and marker |
| Changed primary lockfile followed by `run` | New cache populated; different marker returned |
| Existing primary and worktree containers | Still read their original marker |
| Primary `restart`, `exec`, warm `run` | Adopted the new cache and marker |
| New fingerprint with deliberately failing installer | One-off failed; existing API still read its previous marker |

The final run passed all controls and cleanup. Both projects were stopped; each
created volume was inspected for fixture ownership and absence of container
references before exact-name removal. Container, network and volume inventories
returned to the pre-run baseline. The linked worktree was removed, the VM was
confirmed stopped, and installed Hack/global configuration hashes were unchanged.
All 26 pressure-watchdog samples were normal, with unchanged swapouts and more
than the required 2 GiB headroom.

An earlier run passed the command and engine cleanup controls but Git refused to
remove an untracked generated `hack.branches.json` from the fixture. Its receipt
was preserved, the exact owned file removed, and ordinary worktree removal then
succeeded. The final fixture ignores that generated file and completes cleanup
without a recovery step.

These are cache/command controls, not full application, networking, real package
installation or performance benchmarks. The installer only creates a marker;
concurrent writers, interrupted installs, runtime/image/platform compatibility,
first-start budgets and bounded cache retention remain open. The private engine
reported disabled IPv4 forwarding, so this run provides no external-network
qualification. No installed binary, provider pin or global configuration changed.

Evidence: `.hack-local/run-cache-live/1789605565520634000/`, including the frozen
protocol, protected-hash setup, per-command results, watchdog and final receipt.
Compiled CLI SHA-256:
`3e8c8f02b08b8750128205af663bba820e449f8433ec8db8942fcacba3708116`.
The command uses the candidate source regardless of the retained package version
string. The first run and cleanup recovery are under
`.hack-local/run-cache-live/1789605319074953000/`. Earlier source-path negative
control: `.hack-local/run-cache-negative.log`.
