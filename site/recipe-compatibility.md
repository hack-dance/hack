# Recipes on the next.14 site

The v5 runtime corpus is pinned to `v5.0.0-next.14`
(`6df12b828ce4db60faf51e1bccc481621a350811`). Six recipe pages publish directly
from their hashed release snapshots. Five retain editorial corrections from
`4b400ea4d40acbff4ec00e37a3f288c67da55a03`, with explicit `sourceRevision`,
`sourceLabel` and `sourceFile` metadata:

- Overview: example-directory links select the corrected projects.
- Deps service: read-only consumer mounts and the shared-cache trust boundary.
- Dependency directories: the same mount rule and a corrected wrapped link.
- Config examples: matching corrected mounts, including separate monorepo anchors.
- Tunnels: the host-scoped token and the command-reference OAuth pointer.

Those example links name the correction source commit. The corrections are newer
than the runtime pin and use only behavior the tagged release supports.

All eleven pages fit next.14; none needs a newer runtime. This is a source
compatibility audit, not a new execution of their examples. The pages retain
the original authors' execution evidence and platform limits.

## Command and configuration audit

The initial editorial audit used next.13. Commands and flags were checked again
against `docs/reference/cli.md` at the next.14
tag. All thirteen project JSON blocks pass the tag's
`renderProjectConfigSchemaJson` schema in `src/templates.ts`, including the
partial lifecycle block when placed in a project. The schema allows unknown
top-level keys, so reader checks below also matter.

| Page | next.14 surface checked |
| --- | --- |
| Recipes | `run`, `exec`, `host exec`, `doctor`; default Compose framing |
| CLI sign-in | `up -d`, `logs --no-follow`, `env get --service`, `env add --service --secret --local --value-stdin`; `lifecycle.up.before`, `down.after`, hook `name` and `command` |
| Tunnels | `up -d`, `down`, `logs --no-follow --tail`, `env add --service host --secret --local --value-stdin`; `lifecycle.processes`; `init`'s OAuth alias |
| Remote database | `up -d --env`, `exec --env`, `host exec --env --scope`, `down --env`, `env add --env --local --service --secret --value-stdin`; lifecycle `singleton.ports` and `onConflict` |
| Migrations | `up -d --branch --env`, `logs --no-follow`, `run`, `exec`; `lifecycle.up.after`; Compose `service_completed_successfully` handling |
| Environments | `env list` and `env explain --env --service`, `host exec --env --scope`, `logs --branch`, `config set env.defaultOverlay`, `env apply --service`, `env add --local`, `restart` |
| Deps service | `up -d`, `ps`, `restart`, `run`, `down`; one-shot services; dependency-cache labels and explicit platform |
| Dependency directories | `down --prune-caches --yes`, `down --remove-data`, `env add`; disposable-volume and cache labels; native source, workspace and volume limits |
| Cleanup | `down --prune-caches --yes --branch`, `projects prune --project --dry-run`, `doctor --fix`, `projects`, native `down --remove-data` |
| Config examples | `global install`, `exec`, `logs`, `restart`, `up -d`; `$schema`, `name`, `dev_host`, lifecycle hooks and processes |
| Common pitfalls | `run`, `exec`, `restart`, `down`, `env apply --service`, `env add`, `host exec --shell`, `init`, `global install`; overlay and lifecycle ordering |

At the same tag, `src/lib/project-env-config.ts` accepts the managed YAML
`version`, `environment`, `secretsprovider`, `values`, global/service/host scopes
and overlays used here. `src/lib/project.ts` reads `env.defaultOverlay`.
`src/lib/dependency-cache.ts` declares `hack.dependencies.cache-volume`,
`hack.dependencies.lockfiles` and `hack.dependencies.runtime-files` and requires
a resolved platform. `src/lib/disposable-cache-volumes.ts` recognizes
`hack.cache.disposable` and `.next` mounts. The native notes were compared with
the tag's `docs/guides/native-candidate.md`, including `sharedSource`,
`workspaceCache`, the 16-volume limit and data removal.

Compose keys such as `services`, `image`, `command`, `depends_on`, `volumes`,
`healthcheck`, `ports`, `extra_hosts`, `networks` and Caddy labels are Compose or
proxy configuration, not additions to Hack's project schema. Framework commands,
database clients and tunnel/login CLIs are external tools; the recipes distinguish
stand-ins from tools that were not exercised against live accounts.

## Scope and dependency corrections

The recipe source revision above includes read-only dependency mounts for app
consumers and writable mounts only for installers, including the config examples.
Shared caches are limited to equally trusted worktrees; an installer can still
modify a shared volume. The named-tunnel command uses `--service host`, supported
at next.14, to keep the token out of application containers. Projects using this
pattern must have no Compose service named `host`, which would select that
service scope instead.

Focused static checks reject writable dependency consumers and keep source/site
include blocks aligned. A temporary-project CLI test executes the documented
secret-input command with a synthetic value, reads it through the host scope,
and verifies it is absent from the web and global scopes. These checks do not
start containers or a tunnel. The corrected mount variants were not rerun with
Docker; the affected pages distinguish that correction from their original
execution evidence. The runtime pin remains next.14.

## Publication

The allowlist remains explicit. `docs:prepare` renders existing Mermaid blocks
through the pinned Pele renderer. `docs:smoke` checks every published route and
the light/dark SVG responses. It also checks rendered links and anchors on the
recipes and their index, environment and configuration entry points. Environment
recipe links are appended during site preparation, keeping the hashed release
snapshot and its provenance instead of a separate editorial copy.
Snapshot hashes, public-link boundaries, retired
surface checks and the next.14 installer pin remain enforced.
