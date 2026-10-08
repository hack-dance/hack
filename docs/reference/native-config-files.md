# Native file input planning

The experimental pure compiler accepts named file configs and file secrets.
`config validate` normalizes their declarations, while `config plan` reports
selected file grants using managed-env metadata. Neither operation reads file
material, decrypts values or establishes backend admission.

```json
{
  "configs": { "settings": { "file": "config/settings.bin" } },
  "secrets": { "token": { "env_ref": "TOKEN" } },
  "services": {
    "reader": {
      "image": "example/reader:1",
      "environment": { "TOKEN": { "unset": true } },
      "mounts": [
        { "config": "settings", "target": "/etc/reader/settings", "access": "read-only" },
        { "secret": "token", "target": "/run/secrets/token", "access": "read-only", "mode": "0444" }
      ]
    }
  }
}
```

This fragment belongs in a project with `schema_version: 1` and a project name.
Configs use a project-relative `file`. Secrets use exactly one project-relative
`file` or managed `env_ref`; there is no inline content, template, caller env source,
arbitrary scope, external resource or driver. File paths anchor the verified current
checkout, independently of cwd, `.hack` and `source.root`. A linked worktree selects
its own file rather than inheriting a primary checkout's source file.

Each grant has one source tag, an explicit absolute file target and explicit
`access`. Mode defaults to `0444` and accepts four octal digits from `0000` through
`0777`. Optional numeric `uid` and `gid` preserve ownership intent. The compiler
validates every declaration and workload, including disabled profiles and unused
resources. Unknown names, malformed source choices, invalid paths or permissions,
duplicate normalized targets and file targets overlapping another mount refuse.
The root target `/` cannot serve as a file.

Managed file grants are separate from environment delivery. An `env_ref` binds to
the selected workload's managed baseline using the existing scope, overlay and
verified worktree metadata. An authored env `unset` prevents ordinary env delivery
while preserving that separate file reference. A missing or tombstoned baseline
entry makes the file plan incomplete; a literal or default env value cannot restore
the missing file authority. Empty managed values remain present values; material
delivery must preserve them as zero-byte files without adding a newline.

The public `file_plan` contains references and selected metadata only. Its
`complete` flag and diagnostics are independent of `environment_plan`; `config plan`
fails if either plan is incomplete. Private bytes, decryption results, material paths
and content-derived fingerprints do not belong in this report or its semantic hash.
The CLI negotiates `file_plan_version: 1` before sending authored file intent and
checks that sources, grants, permission intent and managed metadata were preserved.
An older compiler refuses even an empty file namespace.

Execution remains unqualified in this component. Native Compose refuses original
file intent before managed-env acquisition, hooks or engine operations. The native
graph adapter also refuses raw file namespace presence, including empty definitions
and inactive grants, before private value copies. A successful file plan must not be
treated as permission to launch a workload or fall back to another backend.

The proposed first delivery subset is read-only mode `0444` with no UID/GID override;
custom permissions, writable access, one-off `run`, and projects combining builds
with file inputs remain outside that subset. File-backed Compose config/secret
mounts do not implement portable ownership remapping, so emitting ignored attributes
would not satisfy this contract. See the [Compose long-syntax contract](https://docs.docker.com/reference/compose-file/services/#secrets).
Private snapshot ownership, freshness, exact bind
projection, interruption recovery and verified cleanup require separate source and
synthetic engine qualification before delivery is enabled. See the
[Compose renderer boundary](native-compose-renderer.md) and
[generation recovery contract](native-compose-generation.md).
