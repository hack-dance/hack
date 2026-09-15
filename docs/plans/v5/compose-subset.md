# WU03 Compose review and enrollment subset

`hack-local project plan` reviews one explicitly selected Compose file. `project enroll` saves a
redacted, candidate-owned receipt for that exact review. Neither command executes the plan.
The earlier `hack-local plan` command remains a configuration-free WU01 preview and cannot enroll.

```sh
./hack-local project plan --project /path/to/project --file docker-compose.yml
./hack-local project plan --project /path/to/project --file docker-compose.yml --json
./hack-local project enroll --project /path/to/project --file docker-compose.yml --expect-plan <review-id>
./hack-local project status --project /path/to/project --json
```

Repeat `--profile <name>` to select profiles; repeat the same selection when enrolling. The source
root is the explicit project directory. Compose-relative paths use the selected file's directory
and may traverse parents only while remaining inside that project. No implicit Compose overrides,
parent-directory discovery, `.env` interpolation, Docker context or global configuration is loaded.

## Modeled fields

| Area | Enrollment subset |
| --- | --- |
| Service source | Literal image references; local build context, Dockerfile path, target and redacted build arguments |
| Commands | Explicit argv lists, null inheritance, empty overrides, and scalar intent. Scalar tokenization follows environment resolution at execution; it does not imply a shell |
| Profiles | Explicit selected profiles and always-active services; missing and profile-disabled dependencies are errors |
| Dependencies | Required started, healthy and successful-completion conditions; cycle detection; no inferred image healthcheck |
| Health | CMD/CMD-SHELL/NONE forms, explicit disable, positive integer duration components and retry counts |
| Mounts | Existing project-local source paths remapped to a filtered node-native view; declared candidate-owned local volumes; ro/rw modes |
| Environment | Map and KEY=VALUE forms; bare references; required env_file references inspected only as file metadata; Compose environment-over-env_file precedence recorded |
| Ports | Literal single TCP/UDP ports, short or bounded long form. All-interface declarations get an explicit proposed change to 127.0.0.1; active publication conflicts are rejected |
| Networks | Candidate-owned bridge network intent and network_mode none; no live networks created |
| Limits | Positive CPU, memory, PID and shared-memory declarations; matching service/deploy limits required when both are supplied |
| Other behavior | Read-only root, init, restart policy, working directory, user reference, supported Linux image platform, local logging metadata and stop settings |

Commands, environment values, build arguments, labels and logging options are redacted in output
and receipts. Command summaries identify the source field to review locally. Environment variable
names remain visible; their values and interpolation defaults are never resolved from the host.
A whole-Compose-file digest binds the review without storing the original file in candidate state.

Images are not pulled or resolved to immutable artifacts. Dockerfiles are not read or executed,
and Docker's complete build-context/`.dockerignore` behavior is not qualified here. Resource and
network declarations describe intent; this checkpoint does not enforce or execute them. WU04,
WU05 and WU07 must satisfy the displayed execution gates before using these plans for work.

## Explicit refusals

Unknown fields at supported schema levels produce compatibility errors rather than disappearing.
This includes include/extends behavior, privileged services, devices,
shared host namespaces, explicit global container names, external networks/volumes, custom volume
and network drivers, and existing router/runtime ownership labels. Invalid scalar types, paths,
resource limits and malformed YAML return typed errors without source values or YAML snippets.

Fields prefixed with `x-` are recorded as extension-metadata warnings after mapping merges.
Their provider-specific behavior is not executed unless explicitly documented below. This follows the [Compose extension convention](https://docs.docker.com/reference/compose-file/extension/).

### Explicit isolated replacement for an external network

An external network may opt into a **new candidate-owned internal bridge**:

```yaml
networks:
  legacy:
    external: true
    x-hack-isolated: true
```

The candidate preserves service references to `legacy` but records an internal bridge in the
review. It emits `isolated_network_replacement` and binds this choice to the plan digest.
Enrollment never joins or changes the existing external network. Ordinary Compose ignores the
extension and retains its external-network behavior. The option requires `external: true` and
does not enable custom drivers. False or absent retains the original external-network refusal.

This replacement deliberately has no outbound access or shared v4 routing. Use it for an isolated
candidate cohort; applications needing external dependencies still need a separately supported
network path. Router labels, credential-directory mounts, external volumes and graph execution
limits retain their existing gates. Planning and enrollment alone do not create the bridge.

Structural interpolation, port ranges and optional/restart-propagating dependencies
are outside this subset. A healthy dependency needs an explicit enabled health
check. An unconditional restart policy cannot satisfy a completion dependency.

## Source selection

Planning inventories metadata; it neither copies source nor hashes application file contents.
The reported identity covers paths, types, sizes, modification times, executable bits and local
ignore-rule identities. It is **not** a content revision, immutable job snapshot or sync receipt.

Only project-local `.gitignore` and `.ignore` rules are loaded, using bounded regular-file reads
that reject symlinks and hardlinks. Rules inside already excluded directories are not read.
Global ignore rules and Git configuration are not consulted. Unlike Git's index, these selection
rules exclude matching paths even if Git tracks them; the full result is reviewable with `--json`.

Fixed exclusions cover known credential paths, `.env*`, generated dependencies/builds, Git and
agent configuration, candidate/provider state, and nested `.worktrees`. Every declared env_file
is excluded regardless of its filename. These defaults are not a claim to discover arbitrary
secrets embedded in ordinary source files. No environment-file contents are read during enrollment.

WU03 refuses included symlinks, multiply linked files, special files, case-fold collisions and
non-ASCII names. Broader name/link conformance belongs to WU05. Bounds are 20,000 visited entries,
64 directory levels, 2 MiB of included path names and ten seconds of inventory work. Compose input
is limited to 256 KiB, 20,000 decoded values and 48 nesting levels; duplicate keys, custom tags,
non-finite scalars and multiple YAML documents are rejected. Alias replay shares the node budget and a 2 MiB expanded string/key budget.

## Enrollment identity and writes

A plan ID binds the selected source/candidate, Compose bytes, profiles, modeled declarations and
source selection. Enrollment recomputes it, rejects stale or incompatible plans, takes an exclusive
candidate lock, and rechecks before publication. It writes only below
`.hack-local/run/workspaces/<source-namespace>` with private permissions and a durable receipt.
No source project file, active v4 generated directory or runtime resource is created or adopted.

Enrolling the same plan is idempotent. Different existing enrollments, foreign ownership, aliases,
unsafe permissions and partial receipts are refused and retained. Replacement/removal operations
are not implemented in WU03. A changed source can still be reviewed as a redacted diff, but it
cannot silently overwrite its earlier enrollment. Interrupted publication requires inspection.

This is cooperative same-user filesystem ownership, not protection against a malicious process
with the same UID. Metadata inventory is not an atomic filesystem snapshot; WU06 owns immutable
execution-input guarantees.

## References

The subset is grounded in Docker's [service specification](https://docs.docker.com/reference/compose-file/services/),
[profile rules](https://docs.docker.com/reference/compose-file/profiles/) and
[interpolation rules](https://docs.docker.com/reference/compose-file/interpolation/).
Rust decoding uses pinned [serde_yaml_ng 0.10.0](https://docs.rs/crate/serde_yaml_ng/0.10.0) with a
bounded deserialization visitor and the `ignore` crate's matcher with explicit file loading.
The importer has not been qualified against the complete Compose conformance suite.

YAML mapping merges (`<<`) are normalized after bounded alias decoding. Explicit keys win over
merged defaults; earlier entries in a merge sequence win over later entries. Invalid merge shapes
and recursive or oversized expansion fail before planning. See the
[Compose fragment rules](https://docs.docker.com/reference/compose-file/fragments/).
Interpolated/home-relative mount sources produce `unresolved_mount_source` diagnostics without
looking up host environment values; they are not misclassified as named volumes.

### Explicit native HTTP health checks

The private graph executor supports the typed `healthcheck.x-hack-http` declaration documented in
[native HTTP probes](native-http-probe-20260915.md). It requires all six bounded fields and cannot
mix with command-health settings. Healthy dependencies recognize it; ordinary command checks retain
their existing behavior. Graph allocation requires the `native-http-probe` build feature.
