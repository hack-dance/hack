# Dogfooding v5 alongside v4

Use the native candidate on an Apple Silicon Mac for explicitly qualified projects.
Keep stable v4 available for existing work until each project's actual workflow
passes. Publishing a prerelease or passing hosted CI does not establish application
compatibility, lower resource use or whole-product readiness.

## No forced migration

The [version-pinned candidate installer](candidate-install.md) provides `hack-next`
alongside stable `hack`. It does not replace Homebrew Hack, edit PATH, convert
projects, move volumes, enable DNS or trust, or start a VM. On the default native
backend, candidate homes and stable state are separate; an explicit Compose test
uses your own Hack home. Do not alias `hack` to `hack-next` as a rollout step.

Each candidate upgrade starts fresh native and CLI homes. Retained bundles keep
their original homes; selecting another version does not migrate application data.
Returning to stable selects the existing stable environment, not a conversion of
native disks into Docker volumes. Verify retained data through the owning version
before calling a rollback successful.

Configuration migration is also separate from engine and data migration.
`config validate` checks authored input; `config plan` inspects binding completeness
without decrypting or starting workloads. `config import --dry-run` previews bounded
legacy mappings without writing a draft. `config adopt --dry-run` previews explicit
Compose adoption; actual adoption, recovery and rollback have their own ownership
and stopped-instance requirements. See the [command reference](../reference/cli.md#hack-config-import).
These commands do not establish that an arbitrary v4 project can run natively.

## Expand one project at a time

1. Install an explicit published version in a separate candidate root. Verify its
   source revision, checksums and signatures using the installer. Record version,
   source, host, selected home and project; keep secret values out of the receipt.
2. Use a disposable project with synthetic data first. Prepare its provider through
   the [candidate guide](native-candidate.md), with admitted storage and an explicitly
   approved source share and network policy. A refused guard is a result to inspect,
   not permission to change host security, erase evidence or raise resource limits.
   Test the backend the project will use. `hack-next` runs native by default;
   `HACK_RUNTIME_BACKEND=compose hack-next` runs the same candidate on Compose with
   your own Hack home, so global routing, DNS and CA trust are checked too. See
   [Test both backends](candidate-install.md#test-both-backends), including why
   stable `hack` must not run against the same home at the same time.
3. Exercise the project's supported command form: foreground start, readiness,
   status, finite logs, noninteractive exec, retaining stop and restart. Exercise
   one-off run only where admitted. For an authored project, check generated public
   runtime metadata and a saved-Ready status observation after the runtime stops.
4. Verify the application itself: browser sign-in, assets, data-backed pages and
   an application marker written before stop and read after restart. A health
   endpoint alone is insufficient. Test the explicit branch/worktree and environment
   selection the project uses.
5. Verify interrupted startup, refused ownership and recovery preserve data. Record
   what was tested and what remains untested. Qualify an actual backup/restore before
   moving valuable data; software selection alone is not data recovery.
6. Expand to a noncritical internal project, then routine work for that qualified
   project. Keep other projects on v4 until their own acceptance passes. Client
   repositories and shared host services require their separately scoped rollout.

## Know the current boundaries

| Surface | Dogfooding rule |
| --- | --- |
| Apple Silicon macOS | Supported candidate host; provider and app acceptance remain separate |
| Authored native commands | Foreground `up`/`restart`, owner-mediated `down`, saved `ps`, finite logs and noninteractive exec; bounded one-off run refuses mounted members. See the [exact contract](../reference/native-authored-commands.md) |
| Compose-file native frontend | Has a separate [integration contract](native-candidate.md#frontend-integration-status); do not infer parity between frontends |
| Environment changes | Do not assume changing a target, profile or overlay updates an already admitted graph |
| Secrets | Keep keys and private artifacts out of public evidence. The [paired rotation protocol](../security/env-secret-rotation.md) is a proposal/model, not a production rotation command |
| Agent clients | Use the [capability matrix](../reference/agent-client-capabilities.md); discovery, hooks, MCP loading and UI behavior need distinct evidence for each client |
| Performance and retention | Measure matched workloads and retained disk over repeated cycles; do not infer savings from native execution or a single idle sample |
| Other platforms and retired surfaces | See the explicit [unsupported list](prereleases.md#unsupported-platforms-and-surfaces); these are not prerequisites for M5 dogfooding |

An unresolved required application failure keeps that project on v4. Record a
value-free refusal and preserve its owned state for diagnosis. Use ordinary owned
stop commands; do not prune, reset receipts or copy an old candidate's state into
a new version to make a test pass.
