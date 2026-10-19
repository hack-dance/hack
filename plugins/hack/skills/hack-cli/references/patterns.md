# Hack pattern catalogue

Reusable patterns observed across Hack projects, with what Hack supports today.
Use a card's commands only within its disposition. A partial, retained, deferred
or rejected card names the missing contract and its owner; do not improvise the
missing part with ad hoc scripts.

| Id | Pattern | Disposition | Owner |
| --- | --- | --- | --- |
| HACK-P01 | One-shot dependency and generated-artifact bootstrap | Partial | WU07/WU11 |
| HACK-P02 | Portable toolchain without an always-on application | Partial | WU11 |
| HACK-P03 | Cloud prerequisite preflight | Partial | WU27 |
| HACK-P04 | Shared host service with identity-aware adoption | Retained as example | WU29 |
| HACK-P05 | Branch-owned external routing claim | Deferred | WU29 |
| HACK-P06 | Opt-in public tunnel with end-to-end readiness | Deferred | WU29 |
| HACK-P07 | Laptop and headless-runner capability overlays | Partial | WU27/WU30 |
| HACK-P08 | Tracked defaults plus idempotent machine-local hydration | Deferred | WU27/WU14 |
| HACK-P09 | Disposable run workspaces with reference-aware retention | Partial | WU12/WU30 |
| HACK-P10 | Pinned tool image plus independent dependency caches | Partial | WU30 |
| HACK-P11 | Stable agent guidance and typed operation results | Partial | WU19/WU21 |
| HACK-P12 | Multi-lane admission and durable run provenance | Deferred | WU13/WU04 |

## HACK-P01: One-shot dependency and generated-artifact bootstrap

- Use when: Services need installed dependencies or generated artifacts before the application starts.
- Disposition: Partial. Missing: locked-v1 covers one immutable payload per volume. Atomic publication of worktree-specific generated artifacts, env-dependent installers, and two-worktree or interrupted-writer qualification remain open.
- Owner: WU07/WU11; tracked in HACK-1145.
- Commands: `hack up --json`, `hack ps --json`, `hack logs --no-follow --tail 100`
- Prerequisites: A Compose initializer service that consumers require through `service_completed_successfully`; for the opt-in `hack.dependencies.cache-protocol: locked-v1` label, a pinned installer image and an immutable dependency payload.
- Env ownership: locked-v1 runs the initializer and verifier with a clean environment and refuses explicit `environment`/`env_file`; credential- or env-dependent installers keep their existing setup.
- Readiness: Installation, generated-artifact publication and application readiness are separate steps. Completion is the initializer's successful exit plus its verifier, not a populated cache.
- Cleanup: Ordinary `hack down` keeps dependency volumes. Keep worktree-specific generated output in its own always-run step and directory.
- Provenance: 4 consumers (HACK-P01 research register).

<!-- negative-example -->
> Negative control: A populated cache directory is not a completion marker. Concurrent writers to one volume and failed publication need ownership and recovery; consumers must see a complete old or complete new artifact.
<!-- /negative-example -->

## HACK-P02: Portable toolchain without an always-on application

- Use when: Checks, builds or tests need pinned tools in a container, but the project has no long-running app to start.
- Disposition: Partial. Missing: Cross-worktree cache reuse with bounded eviction, a source receipt for linked worktrees, and owned cache accounting remain open.
- Owner: WU11; tracked in HACK-1146.
- Commands: `hack run --profile <profile> <service> -- <cmd...>`
- Prerequisites: A one-shot Compose service behind an opt-in profile with pinned tool versions, explicit resource bounds and separate named volumes for reusable build caches.
- Env ownership: Mount no Docker socket, user home, SSH agent or credential directory; keep project secrets out of the image build context.
- Readiness: The task's own exit status is the result. Check the `hack run` exit status directly, not through a pipe filter, so a failed check stays a failure.
- Cleanup: The service is one-shot. Caches live in named volumes that `hack down` preserves; a source-identity override used for tests must not reach release evidence.
- Provenance: 4 consumers (HACK-P02 research register).

<!-- negative-example -->
> Negative control: A test-only source identity override must not escape into release evidence, and a linked worktree's Git pointer needs deliberate handling rather than an assumed `.git` directory.
<!-- /negative-example -->

## HACK-P03: Cloud prerequisite preflight

- Use when: Startup depends on cloud credentials or tokens that may be missing, expired or scoped wrongly.
- Disposition: Partial. Missing: Hack has no credential availability, expiry or scope check and no machine-identity path for headless runners; the WU27 env contract owns both.
- Owner: WU27; tracked in HACK-1147.
- Commands: `hack doctor --json`, `hack env explain <key> --json`, `hack env explain <key> --target compose --json`
- Prerequisites: Required key names declared in Hack env; the credential tool and its native sign-in owned by the user.
- Env ownership: Report key names, winning source and repair direction, never values. Check the container view separately from the host view.
- Readiness: Preflight runs before startup and fails with the missing name; a present value is not proof that it is valid or unexpired.
- Cleanup: Preflight starts nothing and leaves no state.
- Provenance: 3 consumers (HACK-P03 research register).

<!-- negative-example -->
> Negative control: A token on the host does not prove the container receives it, and a headless runner cannot depend on interactive browser sign-in.
<!-- /negative-example -->

## HACK-P04: Shared host service with identity-aware adoption

- Use when: Several projects or branches share a host helper such as a session issuer or local proxy.
- Disposition: Retained as example. Missing: Today's adoption is port-only. Health- and upstream-checked adoption with a recorded adopted-versus-owned state is the WU29 lifecycle ownership contract.
- Owner: WU29; tracked in HACK-1148.
- Commands: `hack up --json`, `hack logs --no-follow --tail 100`
- Prerequisites: A lifecycle process with `singleton` ports. Hack adopts an existing helper only when every configured port is occupied and the config opts into `onConflict: "adopt"`.
- Env ownership: The helper's credentials stay with its owner; adoption must not forward broad host env.
- Readiness: Pair adoption with a `lifecycle.up.before` hook that checks the listener's identity and expected upstream and fails on mismatch.
- Cleanup: Hack stops only processes it started; an adopted helper is not Hack-owned and is never stopped by Hack.
- Provenance: single-consumer generalization (HACK-P04 research register).

<!-- negative-example -->
> Negative control: Port-only reuse can attach to a foreign service. Process liveness or a placeholder process is not readiness, and no foreign process may be killed to free a port.
<!-- /negative-example -->

## HACK-P05: Branch-owned external routing claim

- Use when: A branch needs an external route or callback claim tied to its own instance.
- Disposition: Deferred. Missing: Hack has no branch-scoped external claim/release contract with bounded retry, stop-during-retry and PID-reuse safety.
- Owner: WU29; tracked in HACK-1149.
- Commands: none yet; do not substitute a hand-written recipe.
- Prerequisites: Explicit project and branch identity for the claim; no recipe is published until the contract exists.
- Env ownership: Claim credentials stay host-scoped and are not written into tracked files.
- Readiness: A claim must be a bounded, observable operation with a retry budget.
- Cleanup: Release only the claim and process group that this branch owns.
- Provenance: single-consumer generalization (HACK-P05 research register).

<!-- negative-example -->
> Negative control: The observed consumer uses a fixed default URL, unbounded retry and broad name-based cleanup. Retain it as a negative example, not a copyable recipe.
<!-- /negative-example -->

## HACK-P06: Opt-in public tunnel with end-to-end readiness

- Use when: A developer occasionally needs the local application reachable from the public internet.
- Disposition: Deferred. Missing: Hack has no opt-in tunnel lifecycle with external-route readiness and owned-child shutdown.
- Owner: WU29; tracked in HACK-1150.
- Commands: none yet; do not substitute a hand-written recipe.
- Prerequisites: Default off; host-scoped tunnel credentials, the tunnel tool and the intended CA.
- Env ownership: Pass only the tunnel's own credential; never forward broad host env.
- Readiness: Probe the exposed application route end to end; a missing credential, tool or CA fails clearly.
- Cleanup: Shutdown leaves no owned tunnel child; disabled mode starts no tunnel.
- Provenance: single-consumer generalization (HACK-P06 research register).

<!-- negative-example -->
> Negative control: A running tunnel process or open TCP listener alone does not prove the external route reaches the right upstream.
<!-- /negative-example -->

## HACK-P07: Laptop and headless-runner capability overlays

- Use when: The same application topology runs on a laptop and on a headless runner with different auth, network or helpers.
- Disposition: Partial. Missing: Hack has env overlays and value-free inspection but no laptop/headless capability contract or headless machine identity; WU27 and WU30 own them.
- Owner: WU27/WU30; tracked in HACK-1151.
- Commands: `hack env explain <key> --env <overlay> --json`, `hack env explain <key> --env <overlay> --target compose --json`, `hack up --env <overlay> --json`
- Prerequisites: One shared Compose topology; env overlays that express only the auth, network and helper differences.
- Env ownership: Overlays own the differences; inspect the effective value source per target instead of reading host env.
- Readiness: Verify container metadata and dependency reachability on each target; the runner must not need browser sign-in.
- Cleanup: Overlays add no state of their own; inherited worktree overrides must be visible and deliberate.
- Provenance: single-consumer generalization (HACK-P07 research register).

<!-- negative-example -->
> Negative control: Do not change locality flags just to bypass a readiness check. Host env is not evidence of container delivery.
<!-- /negative-example -->

## HACK-P08: Tracked defaults plus idempotent machine-local hydration

- Use when: A repository tracks env defaults and each machine adds local values on top.
- Disposition: Deferred. Missing: Hack has no semantic no-op detection or atomic machine-local import contract for env hydration.
- Owner: WU27/WU14; tracked in HACK-1152.
- Commands: none yet; do not substitute a hand-written recipe.
- Prerequisites: Tracked defaults, a machine-local layer and preserved operator overrides.
- Env ownership: Defaults are tracked; hydration writes only the local layer and keeps values out of argv.
- Readiness: Repeat hydration leaves the tracked tree clean; an interrupted import still leaves a resolvable layer.
- Cleanup: Unchanged values cause no rewrite.
- Provenance: single-consumer generalization (HACK-P08 research register).

<!-- negative-example -->
> Negative control: Re-encrypting unchanged entries causes diff and stash churn, and values passed in command arguments are not a secure import mechanism.
<!-- /negative-example -->

## HACK-P09: Disposable run workspaces with reference-aware retention

- Use when: Runs or branches create workspaces and caches that should be reclaimed once nothing uses them.
- Disposition: Partial. Missing: Generation/run ownership, active references, holds and interrupted-reclamation recovery are not implemented for run workspaces.
- Owner: WU12/WU30; tracked in HACK-1153.
- Commands: `hack down --prune-caches`, `hack branch remove <name>`, `hack projects prune --dry-run`
- Prerequisites: Explicitly disposable cache volumes (`hack.cache.disposable: "true"` or Next.js build output) and a reviewed dry run before pruning.
- Env ownership: Reclamation reads no env values.
- Readiness: Not applicable; retention is a cleanup contract.
- Cleanup: `--prune-caches` is confirmation-gated and removes only exact, project-owned disposable volumes; sessions and application data keep their own retention.
- Provenance: single-consumer generalization (HACK-P09 research register).

<!-- negative-example -->
> Negative control: Stopped or Docker-reclaimable does not mean disposable. Active, pending, held or unknown resources must survive.
<!-- /negative-example -->

## HACK-P10: Pinned tool image plus independent dependency caches

- Use when: A runner or toolchain image must stay pinned while application dependencies and credentials vary.
- Disposition: Partial. Missing: Hack does not yet distinguish L1, L2 and cold misses, detect a tampered cache, or emit stage timing and provenance receipts.
- Owner: WU30; tracked in HACK-1154.
- Commands: `hack run --profile <profile> <service> -- <cmd...>`, `hack up --json`
- Prerequisites: Tool manifests pinned in the image; application dependencies in separate cache volumes; credentials outside both.
- Env ownership: Credentials are injected at run time and never baked into the tool image or caches.
- Readiness: Each run reports which stage ran; a changed lockfile or tool pin rebuilds through the same command.
- Cleanup: Tool images and dependency caches are retained; prune only explicitly disposable caches.
- Provenance: 3 consumers (HACK-P10 research register).

<!-- negative-example -->
> Negative control: Code that has landed is not an enabled, verified deployment, and a cache hit does not prove the installer was skipped.
<!-- /negative-example -->

## HACK-P11: Stable agent guidance and typed operation results

- Use when: Agents run project workflows and need versioned guidance plus machine-readable results.
- Disposition: Partial. Missing: A freeze that refuses explicit guidance updates while an agent runs, and a typed terminal result for resumed background operations, remain open.
- Owner: WU19/WU21; tracked in HACK-1155.
- Commands: `hack up --json`, `hack down --json`, `hack restart --json`, `hack doctor --json`, `hack run <service> -- <cmd...>`
- Prerequisites: Generated guidance from Hack's canonical source with a content revision; `--json` on lifecycle and diagnostic commands.
- Env ownership: Results report names and states, not values.
- Readiness: Pass child argv after `--` in `hack run <service> -- <cmd...>`; its exit status, and the MCP run result's `exitCode`, are the child's own. Check the exit status or `--json` envelope directly rather than through a pipe filter.
- Cleanup: Guidance updates are explicit `hack setup` operations, never side effects of ordinary commands. The `agent-surface-freeze` E2E scenario checks that init, agent, doctor and setup-sync runs leave tracked guidance and client config byte-identical.
- Provenance: 2 consumers (HACK-P11 research register).

<!-- negative-example -->
> Negative control: Filtered shell text can hide a failed child, and historical dispatch, PR or gateway requests must not silently expand current product scope.
<!-- /negative-example -->

## HACK-P12: Multi-lane admission and durable run provenance

- Use when: Several heavy runs compete for scarce resources and need queued admission with durable ownership.
- Disposition: Deferred. Missing: Hack has no multi-lane admission, lease or durable run-provenance contract.
- Owner: WU13/WU04; tracked in HACK-1156.
- Commands: none yet; do not substitute a hand-written recipe.
- Prerequisites: Separate job admission, scarce-resource leases and project-registry operations.
- Env ownership: Admission and provenance records hold no env values.
- Readiness: Report queue time separately from execution time with the exact workload.
- Cleanup: Cancellation and worker restart must not duplicate ownership or lose a continuation.
- Provenance: 2 consumers (HACK-P12 research register).

<!-- negative-example -->
> Negative control: A global registry lock is not a workload scheduler, and idle host, idle lane and idle application are different signals.
<!-- /negative-example -->

---

Content revision: `f2c6f4c76304`. Generated by Hack; edit the canonical source and regenerate the plugin.
