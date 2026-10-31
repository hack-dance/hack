# V5 release path and staged dogfooding

This is a readiness contract, not permission to publish or switch active projects.
Stable Hack remains the default while a candidate is qualified beside it. Reuse
[prerelease installation](candidate-install.md),
[dogfooding alongside v4](v5-dogfooding.md) and the
[native candidate contract](native-candidate.md); there is no forced migration.

## Version, channel and exact source

Official release metadata checked on 2026-10-28 reports stable **v4.2.4** and
prerelease **v5.0.0-next.5**. Protected `next` is
[`f73fbd56`](https://github.com/hack-dance/hack/commit/f73fbd56340078d66c0046ec5e371cd948173d2f).
The branch's package.json version is not the latest published stable version.
Recheck official releases and branch heads immediately before preparing a release.

The next proposed native release is **5.0.0-next.6**, channel **prerelease**, only
if that number is still unused. It is not reserved or approved for publication.
An exact integration candidate/artifact has not been selected: reviewed local
follow-ups and held draft PRs are not an integrated release. Record the immutable
source SHA, all included changes, build/tool versions, platform, artifact digests,
provenance, manager version and exact-head checks before requesting publication.

Publishing requires the existing release workflow and separate exact-action
approval. Do not repoint a stable formula, replace a tag/asset, turn the prerelease
into the stable default or switch active projects to create a readiness claim.

## Critical path

| Stage | Required evidence | Stop condition |
| --- | --- | --- |
| Reconcile the backlog | Existing Linear owners/status, current PR heads/reviews, source/test presence and remaining acceptance for every open unit | A historical component completion, merged PR or green fixture does not close application acceptance. Preserve deferred/unsupported scope. |
| Resolve local safety/test gates | Reviewed ownership, settlement, deadline, env/storage and fixture corrections on an exact candidate | Unknown identity/group/data state stays retained. Do not weaken a deadline, bypass a hook or discard failed evidence. |
| Prepare an integration candidate | Reviewed changes based on protected next, with approved integration actions and an immutable SHA | Held candidates are not authorized to merge merely because they pass local checks. |
| Run required source/CI gates | Pinned Bun/Rust checks, full sharded CLI tests, native plan/config compiler checks, platform core tests, secrets/privacy, model positive/negative controls | No cache/skip/fixture pass replaces an unavailable required gate. Release preparation must use the required bounded CI contract, not hide a stalled serial suite. |
| Build and verify the package | Exact-version artifact, all bundled executable identities/manifests, signature/checksum/provenance validation, official-download equality | A build, install or version string is not application acceptance. |
| Qualify fresh setup and existing-project upgrade | Fresh private candidate installation; reviewed project adaptation/import; env/secret delivery; supported routing/TLS, services/jobs/logs/exec/run; ownership-safe stop/recovery and retained data | No new credentials, provider/security settings or data migration inferred from software installation. |
| Qualify agent integration | Fresh supported Codex plugin and MCP sessions, actual client loading, full useful workflows, cancellation and duplicate-server behavior | Documentation or generated plugin files do not prove client integration; measure the actual selected bundle. |
| Qualify rollback and dogfood | Retained working software selection, explicit project/data compatibility, staged reversible project opt-in and measured acceptance | Software rollback is not data rollback. Refusal by an older candidate is not a successful rollback. |
| Publish or promote | Exact version/channel/SHA/artifact plus remaining checks and explicit approval | No blanket waiver, active-project switch or DNS/deployment authority. |

Track canonical acceptance under the [v5 program](https://linear.app/hackdance/issue/HACK-1112),
[distribution](https://linear.app/hackdance/issue/HACK-1124),
[agent integration](https://linear.app/hackdance/issue/HACK-1130),
[plugin guidance](https://linear.app/hackdance/issue/HACK-1132),
[MCP workflows](https://linear.app/hackdance/issue/HACK-1133) and
[agent cost](https://linear.app/hackdance/issue/HACK-1141).
Linear is canonical; this document supplies the reproducible gate structure.

## Staged, reversible primary-driver plan

1. **Record the baseline.** Capture stable/candidate versions and executable paths,
   the exact project/config revisions, ownership identities, data-retention markers
   and expected routing. Identify the supported backup/restore and recovery path
   before touching an existing project. Do not export secrets into reports.
2. **Install beside stable.** Select an exact verified candidate through its
   separate `hack-next` channel. Installation does not boot a VM, migrate project
   data, install DNS/trust or replace `hack`. Retain the prior verified bundle.
3. **Use disposable fixtures first.** Complete a fresh setup and reviewed import,
   then ordinary start/stop/restart, exec/run/logs, cancellation, crash recovery,
   changed-source and foreign-owner refusal. Confirm owned cleanup and retained
   application-data contents on the actual provider.
4. **Opt in one real project.** Use the candidate's explicit path; do not change a
   shared default. Record actual project/browser acceptance and client integrations.
   For Compose, stable and candidate share state: follow the existing candidate
   guide's daemon/lock protocol and never run them concurrently against that home.
5. **Exercise upgrade and rollback.** Upgrade only while the manager and runtime
   are proven quiescent. Validate retained-byte identities and data compatibility.
   Test an explicitly selected older retained bundle; if it refuses newer state,
   stop and retain evidence rather than deleting or downgrading the data.
6. **Expand deliberately.** Only after per-project evidence passes, extend to a
   small named cohort. Full-v5 readiness additionally needs the frozen matched
   performance/resource protocol, disk plateau and 1/8/32 branch qualification.
7. **Promote only when ready.** Report exact version/channel/artifact/source,
   project cohort, rollback result and remaining gates, then obtain approval for
   that primary-driver replacement. Keep the stable route available until its
   retirement is independently authorized.

The supported lifecycle is the local CLI. Hosted accounts/dashboard/Tickets and
built-in GitHub/Linear product integrations are retired; retained macOS and remote
surfaces are unsupported. A docs website is not a revival of those products.

## Models and uncertainty

[The coverage map](../reference/v5-model-coverage.md) connects models, critical
states, implementation boundaries and executable regressions. Release evidence
must include concurrent claims, cancellation/timeout, partial publication, crashes,
recovery and uncertain outcomes—not only successful start/stop diagrams.

Finite TLC exploration and bounded symbolic checks do not prove the implementation,
filesystem durability, external provider behavior or unbounded liveness. Current
software-selection/upgrade and primary-driver policy coverage gaps must remain
visible; neither a diagram nor a historical prerelease closes them.

## Docs destination

`hack.foo` is the intended documentation destination. Source preparation and local
validation do not authorize DNS, credentials/access changes or public deployment.
Keep canonical Markdown separate from generated site output, review the public
corpus, and test navigation/links/commands before a later deployment decision.
