# Local disk footprint

The Compose backend writes project state on the host and container data through the
selected Docker engine. That engine may store its data on Linux, inside a desktop VM
on macOS, or on another machine. The native backend also has host-side runtime state
and stores engine data inside its provider disks. Count guest files and engine
objects as attribution within those disks when measuring host space.

## Measure the selected native home

Run `hack native disk-usage` for host file totals, or add `--json` for the
same measurements in a script. Use `hack doctor --disk` for the same totals in
a standalone diagnostic report. The command leaves a stopped pool stopped.
Allocated bytes are file blocks reported by the filesystem. Hard links are counted
once, while APFS clones may share some of the reported blocks. A partial scan is
marked incomplete. Guest data already lives in the host backing disks and is
included there. The report does not estimate how many blocks a cleanup would free.

## State managed by Hack

| Location | Writer and owner | Growth bound | Cleanup and interrupted operations |
| --- | --- | --- | --- |
| Hack home configuration and project registry | [Config path selection](../../src/lib/config-paths.ts) and [project registry](../../src/lib/projects-registry.ts). The selected Hack home owns these files. | No fixed project count. | `hack projects prune` removes eligible stale registrations. A registration can remain after its checkout goes away. Configuration persists across runs. |
| Worktree `.hack/.internal` | [Project runtime](../../src/lib/project.ts), [lifecycle ownership](../../src/lib/lifecycle-runtime.ts) and [native local-directory records](../../src/lib/local-directories-project.ts). Each checkout owns its own generated state. | No aggregate quota. | Stop and recovery use the recorded state to release owned resources. An interrupted operation can leave generated overrides and lifecycle records. Removing the checkout does not itself stop resources in the engine. |
| Worktree `.hack/.branch` | [Branch output](../../src/lib/native-compose-adoption-branch.ts) and [runtime projection](../../src/lib/native-compose-adoption-projection.ts). Generated files are keyed by branch or instance. | No aggregate quota found. | Branch-specific operations replace their own outputs. An interrupted operation can leave the last published files. |
| Activity log | [Activity writer](../../src/lib/activity-log.ts) in the selected Hack home. | Rotates at 1 MiB and keeps a previous file. | Rotation replaces old history. An interrupted append can leave an incomplete last entry. |
| Native provider artifacts and archives | [Provider setup](../../packages/runtime-core/src/provider/setup.rs) and [artifact repair](../../packages/runtime-core/src/provider/artifact.rs) under the native state root. | Artifact-specific verification limits. No aggregate retention limit found. | Setup stages and publishes a verified tree. Archives can be retained for repair. An interrupted setup may leave staging output. |
| Native VM disks and pool receipts | [Provider lifecycle](../../packages/runtime-core/src/provider/lifecycle.rs) under `run/smolvm`. The owner receipt records disk identity and boot state. | Disk sizes follow the pool configuration. Allocated bytes vary with use. | Down preserves the disks. An unclean exit can leave sockets, a pending receipt and persistent data needed for recovery. |
| Native memory peaks and admission record | [Memory peak history](../../packages/runtime-core/src/provider/lifecycle/guest_memory_peak.rs) and [opening admission](../../packages/runtime-core/src/provider/admission/opening.rs). | Five peak records per pool. A pool's opening sample is replaced. | History rotation drops older samples. A crash can lose an unsaved observation. |
| Native step store | [Store publication](../../packages/runtime-core/src/store/disk.rs) and [content-addressed objects](../../packages/runtime-core/src/store/cas.rs). | 16 MiB per CAS object. No aggregate bound found. | Invalid entries are rejected on lookup. Publication stages content before rename. An interruption can leave a staged write. |
| Native build receipts, locks and client scratch | [Image build](../../packages/runtime-core/src/provider/image_build.rs) under `run/image-builds`, keyed by namespace and build inputs. | 64 KiB per receipt. No history count bound found. | Build reports and cleanup use the receipt. Interrupted attempts can leave scratch, receipts and locks. |
| Installed bundles and update staging | [Release install](../../src/lib/release-install.ts) and [self-update](../../src/lib/self-update.ts). The selected installation owns its executable and assets. | Per-release checks. No aggregate installed-version bound established. | Normal update removes its staging and resolved backup. A process exit can leave staging or the earlier installation needed for recovery. |

## Engine-owned storage

| Resource | Writer and owner | Growth bound | Cleanup and interrupted operations |
| --- | --- | --- | --- |
| Compose containers, images, volumes and networks | Selected Compose engine. Hack supplies the project selection. External resources and shared image layers can have additional owners. | Engine policy and available space. | Compose down handles selected containers and networks. [Explicit cache pruning](../../src/lib/disposable-cache-volumes.ts) checks eligibility before removing volumes. Persistent volumes and images can outlive the project. |
| Native images and BuildKit cache | [Image import](../../packages/runtime-core/src/provider/image_load.rs), [build](../../packages/runtime-core/src/provider/image_build.rs) and [reclaim](../../packages/runtime-core/src/provider/image_build/reclaim.rs) in the guest engine. | Best-effort post-build cache target of 4 GiB. The target bounds private build cache unused by any retained image, including the current and previous images. No aggregate image bound found. | Image reclamation uses retained references. Failed or interrupted pruning can leave extra engine data. |
| Native graph containers, persistent volumes, networks and graph receipts | [Graph runtime](../../packages/runtime-core/src/provider/graph/mod.rs), with host journals and guest resources. | No aggregate graph or retained-volume bound. | Down and recovery retain data by default. A crash can leave resources attached to prior receipts. |

## Temporary paths

| Location | Owner | Growth bound | Cleanup and interrupted operations |
| --- | --- | --- | --- |
| `hkgf-*` | Foreground graph [transport](../../packages/runtime-core/src/provider/graph/foreground/transport.rs), one root per run. | No aggregate bound. | Retirement preserves evidence used by recovery. A dead publisher can leave its directories and lock records. |
| `hkro-*` | Graph [relay startup](../../packages/runtime-core/src/provider/graph/startup/runtime.rs), scoped to boot and run generation. | No aggregate bound. | Retirement can leave control and lifecycle records. Old host-pin recovery still reads the recorded root. |
| `hkl-*` | Native [pool owner](../../packages/runtime-core/src/provider/state.rs) records the provider HOME alias. | One recorded alias per pool. No bound on dangling aliases across deleted pools. | Restart and recovery validate the link and its target. Deleting the pool state can leave a dangling alias. |
| `hka-*` | Managed [hostname authority](../../packages/runtime-core/src/provider/hostname_authority/managed.rs), keyed by owner token and UID. | No aggregate bound. | Authority shutdown clears its endpoint and identity record. The directory can remain. |
| Release and native setup staging | [Self-update](../../src/lib/self-update.ts) and [provider setup](../../packages/runtime-core/src/provider/setup.rs). | Bounded per input where the writer applies a download limit. No aggregate bound. | Normal completion runs staging cleanup. An abrupt exit can leave partial downloads and extracted files. |

## Additional host storage

Use `hack-local runtime disk-usage --scope image-archives --json` to measure
the native host image archive store separately from other provider artifacts.
The report includes file sizes and allocated bytes. It does not identify which
archives can be removed.

| Location | Writer and owner | Growth bound | Cleanup and interrupted operations |
| --- | --- | --- | --- |
| Prerelease channel `versions/<version>` | [Channel installer](../../scripts/installer/channel.ts). A receipt binds each bundle and its per-version CLI and native homes. | The selection reader accepts at most 256 registered versions. This is a validation limit. Retained versions can contain their own VM disks. | Installer recovery preserves published versions and their homes. An interrupted install can leave an unselected version for validation. |
| Daemon files and service logs | [Daemon paths](../../src/daemon/paths.ts) and [daemon logger](../../src/daemon/logger.ts). The owner is the selected home or the host service manager for its own journal. | The daemon writer caps its own regular, singly linked file at 5 MiB. Service stdout and stderr have separate destinations and retention. | A crash can leave a PID file or socket. The presence of either is insufficient proof of a running daemon. |
| Managed synchronization tool | [Tool installer](../../src/lib/mutagen.ts) writes the executable and agent bundle under the selected Hack home. | Fixed installed paths. Download staging can accumulate after interruption. | Normal installation removes the temporary download directory. Installed tools remain available across project stops. |
| Dependency cache metadata and volumes | [Dependency cache writer](../../src/lib/dependency-cache.ts) keeps project metadata in `.hack/.internal`. The selected engine stores the actual volume. | No aggregate byte limit established for the volumes. | Explicit eligible cache pruning goes through the [volume removal path](../../src/lib/disposable-cache-volumes.ts). Cache metadata and volumes can survive a crashed run. |
| Native image-import receipts | [Image import](../../packages/runtime-core/src/provider/image_load.rs) writes managed records under `run/image-loads`. | No aggregate retention limit established. | The import protocol uses these records to identify validated and interrupted imports. |
| Native preflight, start, build and HTTPS scratch | [Preflight](../../src/backends/native-preflight.ts), [start](../../src/backends/native-project-start.ts), [build](../../src/backends/native-project-builds.ts), [HTTPS](../../src/backends/native-project-https.ts) and its [lease server](../../src/backends/native-https-owner-server.ts) allocate private temp paths. | No shared age or count cap established. | Command and owner cleanup scope files to the active operation. A killed process can leave its temp path and any staged inputs or lease evidence. |
| Native container and source-job logs | The guest engine writes logs using the [graph container configuration](../../packages/runtime-core/src/provider/graph/config.rs) and [source-job configuration](../../packages/runtime-core/src/provider/source_job.rs). | Default graph logs and source-job logs request 1 MiB and one file per container. Container count still affects the total. Compose services follow their selected engine and Compose logging policy. | The engine cleans logs when the corresponding container is removed. Retained or interrupted container cleanup can leave its logs. |
| Native dependency cache and quarantine records | [Cache binding](../../packages/runtime-core/src/provider/graph/dependency_cache.rs), [initializer cache](../../packages/runtime-core/src/provider/graph/initializer_cache.rs) and [quarantine](../../packages/runtime-core/src/provider/graph/cache_quarantine.rs) track cache volumes and their eligible users. | No aggregate byte or retained-generation limit established. | Cache reuse relies on recorded identity. Quarantine and its recovery journal can survive interrupted cleanup. |
| Native hostname configuration and certificate-admission state | [Host DNS publication](../../src/lib/native-domain-dns-host.ts), [CA repair](../../src/lib/native-ca-doctor.ts) and [certificate admission](../../packages/runtime-core/src/provider/hostname_authority/certificates.rs) manage host files and a pool admission record. | No aggregate retention bound established across configured names and pools. | Updates and repair reconcile selected files. A crash can leave staged publication files. Host trust and resolver state remain separate from project and container storage. |

The size of a persistent volume, imported image or sparse disk depends on workload.
Use allocated bytes for filesystem files and deduplicate shared layers before
estimating what removal would free. A retained object becomes a cleanup candidate
only after its ownership and remaining references can be established.
