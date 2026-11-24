# Targeted native start coverage

The model fixes one ready run with a running and published `web`, a request for
`redis`, its dependency `cache`, and an unused service. It explores every
ordering of create, start, publish, crash and cleanup in this finite instance.
The effects are separate from their journal records. `Reserve` is the one
atomic receipt replacement that enrolls all new resource names. `Create` can
complete before the caller learns the container ID. `Down` uses the same receipt
after an owner failure and can remove every enrolled effect.

| Property | Source and regression |
| --- | --- |
| `SameRun`, `PreserveExisting`, `OnlySelected` | `foreground/service_start.rs` pins the live owner and `extend.rs` verifies the receipt generation under the provider lease. `config::prepare_with_ownership` preserves allocation and labels. The `targeted_ownership_preserves_running_ids_and_recovers_lost_create_reply` fake reads back the old ID and checks the new engine identity against the same plan. |
| `DependencyBeforeCreate`, `PublishAfterStart` | `project/execution.rs` starts the selected closure and observes existing dependencies without starting them. `EarlyPublications::publish` uses one service and its confirmed ID. The seeded scheduler fake verifies dependency order and existing service exclusion. |
| `OwnedEffects`, `CleanStop` | The extension saves all names, then `Session::reserve` saves each effect intent. `cleanup_owned_fenced` stops and removes owned resources from the combined receipt. The lost-create fake authenticates the new container by its recorded name and labels when the returned ID is missing. |

TLC 1.7.4 with Java 17, two workers and a 512 MiB heap explores 52 distinct
states. `negative.cfg` omits the dependency's reservation and fails `OwnedEffects`
at `Create`. `replace-existing.cfg` changes `web`'s ID and fails `PreserveExisting`
at `Reserve`.

The model assumes serialization in the foreground owner, a provider lease for
mutation, atomic journal replacement, and an engine that honors confirmed
identities. It abstracts per-resource acknowledgment fields, provider boot and
route transport, and assumes authorized cleanup can eventually complete. It does
not check filesystem durability, fairness, signal timing, or real VM routing.
The [Pele source](../../../../docs/reference/state-charts/targeted-start.mmd)
uses the same transition names.
