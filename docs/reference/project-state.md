# Backend-aware project state

Plain `hack projects --json` retains its published top-level object. With
`--observe`, the payload is inside the [machine-output envelope](./machine-readable-output.md)
with `data.schema: "hack.projects.observe.v1"`. The row fields below are shared
by both CLI forms and the daemon payload.

Full and summary `hack projects --json` rows and hackd's `GET /v1/projects`
share these additional fields. Older `status` and `runtime_status` fields remain
for compatibility; consumers of this contract use `state`.

```json
{
  "backend": "compose",
  "state": "running",
  "state_reason": null,
  "started_at": "2026-01-01T00:00:00Z",
  "services": [{"name":"api","state":"running","ready":true,"completed":null,"health":null,"exit_code":null,"started_at":"2026-01-01T00:00:00Z"}]
}
```

`backend` is `compose`, `native` or `unknown`. Project and service `state` is
`running`, `degraded`, `starting`, `stopping`, `stopped`, `failed` or `unknown`.
Profile services without observed containers are not required for project-state
aggregation unless a required service depends on them (transitively;
`required: false` dependencies do not activate them). Their service rows remain
visible. Observed profile containers participate even after they exit. The
listing process's environment is not used to guess a past profile selection.
`paused` and `removing` members remain unknown. Image-provided health checks
can conservatively make a started-role service degraded/not ready even without
a Compose health dependency. Mixed running/terminated replicas are degraded. When no live member remains,
known failure wins over stopped members. Unknown evidence prevents a complete
claim. Successful declared jobs do not degrade other running services.

`ready` and `completed` are nullable booleans. Unknown is not false:

- Compose roles come from current service configuration: `disable: true` and
  `test: ["NONE"]` both disable a health check. An enabled health check or a
  `service_healthy` dependency requires health; a
  `service_completed_successfully` dependency declares a completion role;
  otherwise the role is started. A successful exit alone never declares a job.
- Native roles come from the owned run's retained readiness declarations,
  combined with fresh authenticated member observations. A historical ready
  receipt does not prove current readiness.
- A completion role succeeds only when every member has an observed zero exit.
  Missing exit codes or required health remain null. Mixed replica exit codes
  or health strings are null rather than selecting an arbitrary member.

`health` and `exit_code` come from current observations, never log text. An exit
code is emitted only for a terminated member. Docker inspect selects status,
exit code, start time and health status, excluding environment values, commands,
error text and health-check logs. The daemon's static inspect cache cannot
supply current health/exit/start evidence; fields are null on a cache-only
refresh. Failed reinspection clears prior state evidence while retaining static
identity. Unchanged running IDs remain query-free. Changed states and non-running IDs
are re-inspected during event refreshes, including repeated exited states: a
restart and second exit can reuse the same container ID. This keeps job completion
and failure known without waiting for the periodic full refresh.

`started_at` is the earliest valid observed member start time, or null. It is
never the observation time or a historical readiness time. Native status does
not currently expose start timestamps, so native timestamps remain null.

Registered native projects remain in the listing. A Compose-format project's
backend is chosen by the observing process's runtime selection, not persisted
per project. Without native selection it is observed through Compose and can
report stopped even if that checkout is running on native elsewhere. Hackd uses
its own environment, including when started at login; it does not inherit later
shell selections. Consumers must not interpret a Compose observation as evidence
about a native run. Persisting backend identity is outside this contract. Authored native markers and
explicit native runtime selection choose the native observer. For authored native projects, an absent runtime
selection, unavailable/busy provider, changed provider pin or unconfirmed owner
produces unknown state with `state_reason: "observation-unavailable"`. Raw
provider errors are omitted. An explicitly verified native runtime degradation
reports `degraded` with `state_reason: "native-runtime-degraded"`, without claiming
service readiness. Native observations cover the registered root's
base instance; branch observations remain a separate interface. At most four
native project status reads run at once in one process, across all concurrent
callers (for example parallel `/v1/projects` requests to hackd). Callers that
ask for the same project at the same time share one read; settled results are
not cached.

Observation boundaries from [observe-only listing](../cli.md) are preserved:
`hack projects --json --observe` reads no engine or native provider and leaves
live state unknown. `--observe --runtime` explicitly opts in to runtime contact,
which can start a socket-activated engine. Both bypass hackd and registration
writes. Ordinary JSON listing and daemon listing use live native reads when
native runtime selection is configured; those reads do not start a VM or graph.

![Shared state projection](./project-state.svg)

## Waiting for changes

hackd's `GET /v1/projects` response also carries `state_token`, an opaque
32-character digest of its content. It leaves out values that change without a
state change: `generated_at`, `profiling`, `runtime_checked_at`,
`runtime_last_ok_at` and the elapsed time in Docker's container `status` text.
The status's leading word, health and exit code still count ("Up 12 seconds
(healthy)" is digested as "Up (healthy)"), as do container `state` and the
service state and health fields above. The CLI's `hack projects --json` output
does not include it.

A client can send the token back to wait for a change:

```text
GET /v1/projects?wait=<state_token>&wait_timeout_ms=25000
```

- A different current token answers at once.
- Otherwise hackd recomputes after each runtime refresh (Docker events and its
  30-second periodic refresh) and answers when the token changes, or at
  `wait_timeout_ms` with a fresh build whose token may be unchanged. Ask again
  with the latest token.
- Use the same query parameters as the request that produced the token.
- `wait_timeout_ms` defaults to 25000 and must be 1000–55000. A malformed
  `wait` or timeout returns `400` (`invalid_wait`, `invalid_wait_timeout_ms`,
  `wait_timeout_requires_wait`).
- At most 16 requests wait at once; beyond that a request is answered
  immediately, as without `wait`.
- Registry-only changes, such as a new registration, show up at the next refresh
  or at the timeout. Waiting ends when the client disconnects.

hackd's socket keeps idle connections for up to 70 seconds, so a wait is not
cut off at Bun's default 10 seconds. The unsupported gateway route does not wait.

## Branch instance identity

Full rows (not summary rows) describe each branch instance explicitly, so a
client does not derive it from Compose project names, Caddy labels or paths.
Each `branch_runtime[]` entry keeps `branch` (the slug in the Compose project
name `<project>--<slug>`) and `runtime`, and adds:

| Field | Meaning |
| --- | --- |
| `backend` | `compose`. |
| `branch_name` | The name the instance was started with: the `hack up --branch` / `hack restart --branch` argument, or a linked worktree's git branch. `null` when it was not recorded (for example an instance started by an older Hack). |
| `branch_name_source` | `recorded` (written by `up`/`restart` to the owning checkout's `.hack/.internal/branch-usage.json`), `worktree_registration` (the registered linked worktree's git branch, when it maps to the same slug), or `null`. |
| `checkout` | `{root, project_dir, kind}` of the checkout that owns the instance, by the same rule `hack projects prune` uses: the container working directory is the registered checkout (`kind: primary`) or one of its registered linked worktrees (`kind: worktree`). `null` when it is neither. |
| `checkout_verified` | Whether the registered primary or a current linked Git checkout owns this runtime. A historical worktree path can still identify an observation when Git can no longer verify the checkout. |
| `hosts` | Hosts per service, from the running containers' Caddy site labels (`caddy`, `caddy_<n>`), parsed as the CLI parses them; wildcard, template and port entries are left out. |
| `hosts_source` | `runtime_labels`; `config` when no container carries a site label (the owning checkout's Compose labels, qualified for the branch); `unavailable` for authored native instances. |
| `url` | The URL `hack open --branch <branch>` opens with no target in the owning checkout. Its `open.prefer` selects the host, then Hack qualifies the host with the branch. The URL is `null` for unverified Compose owners, missing checkout configuration, unavailable preferred aliases, and authored native instances. |
| `url_host` | `dev` or `alias`: which project host `url` uses. |

Full rows also include `branch_copies[]`, the configured Hack branches,
linked Git worktrees and locally recorded branch instances for a
Compose project. Each entry has `branch`, `branch_name`, `checkout`, `url`,
`defined_services` and `recorded`. The URL uses the checkout's configuration
and the same open preference as `hack open`. When Compose can target a
copy, `compose_project` names that stack. Base copies honor
`COMPOSE_PROJECT_NAME` from the shell or checkout dotenv. Branch copies
interpolate their checkout's Compose `name` for the branch prefix independently
of that base override. Full rows and
branch entries set `compose_project_unresolved: true` when the effective
name lookup fails.
A worktree configured with
`worktree.auto_branch=false` has a null branch, a base URL, and a `runtime`
when it owns the base stack. An unaddressable worktree has a null branch and
URL. Match branch observations by branch and owning checkout, then use
`runtime_ok` to distinguish a missing runtime from an unavailable observation.
Container IDs are full Docker IDs. When available, the container's `started_at`
identifies the observed execution and retains Docker's timestamp precision.

The row also has `open_url` and `open_url_host`, the same for the base
instance (`hack open` with no branch).

`open_url` is `null` when the registered `.hack` directory is missing.

`native_branch_runtime[]` lists native branch instances with the same fields
plus `backend: "native"`, `store` and `state: "recorded"`. An entry means the
checkout holds a saved run mapping for that branch, which `hack down` uses; it
is not proof that the instance is running (`hack ps --branch <branch>`
observes that).

- `store: runtime`: the native backend on a project with `hack.config.json`
  (`.hack/.internal/native-runs`). `branch` is the slug; `hosts` and `url`
  come from configuration as for Compose (`hosts_source: config`).
- `store: authored`: an authored project (`.hack/hack.project.json`,
  `.hack/.internal/native-authored-runs`). Its mapping keys the instance by
  the `--branch` value as given, so `branch` and `branch_name` are that value
  and are what `--branch` accepts. `hack open` there reads the saved native
  routing, which this read does not open, so `url` is `null` and `hosts` is
  empty (`hosts_source: unavailable`); run `hack open --branch <branch>` for
  the URL.

The recorded name is best effort: two `up` runs that write the same checkout's
`branch-usage.json` at once can drop one name until that instance's next `up`.
A new mapping or recorded name appears with the next runtime refresh, like a
registry change (see waiting above).

Cost: these fields come from file reads only, with no process spawned and no
Docker call: the owning checkout's config, one small `branch-usage.json` read
per instance, and for native instances two directory listings per checkout.
With 20 registered projects, each with two linked worktrees, two Compose branch
instances and one native mapping, building all rows took about 10 ms instead of
about 4.5 ms (local measurement, warm file cache).
