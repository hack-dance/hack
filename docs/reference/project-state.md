# Backend-aware project state

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

- Compose roles come from current service configuration: a health check or a
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
native project status reads run concurrently.

Observation boundaries from [observe-only listing](../cli.md) are preserved:
`hack projects --json --observe` reads no engine or native provider and leaves
live state unknown. `--observe --runtime` explicitly opts in to runtime contact,
which can start a socket-activated engine. Both bypass hackd and registration
writes. Ordinary JSON listing and daemon listing use live native reads when
native runtime selection is configured; those reads do not start a VM or graph.

![Shared state projection](./project-state.svg)
