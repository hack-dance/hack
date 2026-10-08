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
Readiness requires authenticated current observations and unchanged input before
publication. The foreground owner remains attached until owned shutdown finishes;
Ctrl-C requests that shutdown. Exact durable Removed evidence retires the tagged
native run and startup intent. Unknown, changed or live cleanup retains the attempt
and refuses replay; a missing ready mapping does not authorize a fresh start.

`down --recover` explicitly retires a complete stored native generation whose
foreground publisher and frontend admission owner are both dead on the same host
boot. It requires the current version 3 native publication, the exact stored Ready,
startup intent and private source envelope, and the original guest incarnation.
Live owners, older version 2 dead publications, partial startup, pending writes,
changed files and rebooted guests refuse. Env/profile changes, service subsets and
`--json` are unsupported for this operation. It neither recompiles authored input
nor acquires managed values or starts a provider.

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

The native receipt and source paths are distinct from strict Compose v1 artifacts.
No native hash substitutes for a normalized Compose hash. Source and fake-driver
checks do not qualify an installed frontend, a live provider, the full authored
corpus, actual version 3 dead-owner recovery or resource overhead; those remain separate gates.
