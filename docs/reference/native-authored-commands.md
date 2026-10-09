# Experimental authored configuration with the native runtime

An explicit `HACK_RUNTIME_BACKEND=native` selection delegates an authored
`.hack/hack.project.json` project to the separate native foreground owner. The
current command slice supports whole-project foreground `up` on macOS with an
absolute `HACK_NATIVE_BINARY` and private canonical `HACK_NATIVE_HOME`. It requires
the caller's separately prepared native provider pool and matching runtime binary.
It does not install or select a runtime automatically. An omitted backend continues
to use the [Compose command owner](native-compose-commands.md).

```sh
HACK_RUNTIME_BACKEND=native \
HACK_NATIVE_BINARY=/absolute/candidate/hack-native \
HACK_NATIVE_HOME=/absolute/private/candidate-home \
./dist/hack --path /absolute/project up
```

The native planner admits image-only workloads, exec readiness, initializer jobs
and dependencies with the ordinary project network and outbound mode. Source
root must remain `.`; source acquisition, mounts, storage, authored networks, file inputs, routing, endpoints
and host effects remain outside this bounded frontend. Unsupported intent must
refuse before managed value resolution and provider work. Early typed input
capability refusals retain `E_NATIVE_PROJECT_UNSUPPORTED` without exposing
compiler diagnostics or creating native source/start/run authority. `--detach`,
`--json`, service subsets and other lifecycle operations refuse before input
acquisition. `--branch` supplies an explicit native namespace; its omission uses
the canonical project namespace without inferring a Git branch. Profile and env
selection keep their compiler contracts. `--env base` bypasses inherited overlays
with an explicit base selection; omitting `--env` retains the authored/local default.

Startup shares the configured `HACK_COMPOSE_STARTUP_TIMEOUT_MS` budget across
input preparation and native review, with a native maximum of 300000 milliseconds.
Startup refusals identify a fixed owning stage and, when available, a closed
compiler or native error code. They omit arbitrary errors, child output, paths and
values. These diagnostics do not grant retry or cleanup authority.
Readiness requires authenticated current observations and unchanged input before
publication. The foreground owner remains attached until owned shutdown finishes;
Ctrl-C requests that shutdown. Exact durable Removed evidence retires the tagged
native run and startup intent. Unknown, changed or live cleanup retains the attempt
and refuses replay; a missing ready mapping does not authorize a fresh start.

`down --recover` explicitly retires a complete stored native generation whose
foreground publisher and frontend admission owner are both dead on the same host
boot. New version 4 native publications use the kernel boot-session UUID, which
remains independent of calendar clock correction. Recovery requires the exact stored Ready,
startup intent and private source envelope, and the original guest incarnation.
Live owners, older version 2 dead publications, partial startup, pending writes,
changed files and rebooted guests refuse. Env/profile changes, service subsets and
`--json` are unsupported for this operation. It neither recompiles authored input
nor acquires managed values or starts a provider.
Omit `--profile` to recover the stored generation; explicit empty or named profile
overrides both refuse.

The closed version 3 publication and version 1 recovery selector remain supported
with their original calendar boot qualifier; clock drift conservatively refuses
that legacy recovery. New version 4 owners use version 2 UUID selectors. Missing,
malformed or unavailable UUIDs refuse; no old record is migrated or given inferred
session authority. PID birth/executable, peer, inode, gate and run-lock checks remain.

Recovery commits a distinct private intent before calling the Rust cleanup owner.
The original raw selectors and resource inventory remain fixed through retries;
current cleanup phases may advance. Before retiring each frontend file, the owner
inspects the exact native receipt and requires all resources Removed with null
observations. A committed retirement phase alone permits the corresponding file's
expected absence. Pending writes and replacements remain retained refusals. The
recovery lease blocks ordinary startup throughout this work. Completed frontend
history is archived under fresh startup admission before a later generation can
start; incomplete history never permits automatic takeover. Persistent data stays
retained, and no recovery operation reboots the guest or allocates new resources.

Dead recovery lease takeover retains its private directory and commits the exact
next owner file before replacing the old owner. A recorded candidate may be pending
or already published after interruption; both forms must match the saved inode and
bytes before a fresh lease is issued. Separate committed release flags authorize
only the corresponding owner/directory absence. An unrecorded pending candidate
and an interrupted completed-history hardlink archive remain retained refusals;
this operation does not repair arbitrary partial lock or file publications.

The native receipt and source paths are distinct from strict Compose v1 artifacts.
No native hash substitutes for a normalized Compose hash. Source and fake-driver
checks do not qualify an installed frontend, a live provider, the full authored
corpus, actual dead-owner recovery or resource overhead; those remain separate gates.
