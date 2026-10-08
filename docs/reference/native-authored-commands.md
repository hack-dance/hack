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

The native planner admits image workloads, exec readiness, initializer jobs
and dependencies with the ordinary project network and outbound mode. It also
admits one read-only project source mount per selected workload, using the existing
`host-mounted` source mode and root `.`. The provider pool must already contain
the exact explicitly approved unfiltered live project share. That existing
virtiofs share grants the guest writable access to the whole tree; only the
individual workload bind is read-only. This command does not enroll the share or
change pool mounts. Host edits remain visible. A selected
directory allows descendant edits; a selected regular file allows in-place edits
but refuses replacement of its inode. Selected path/ancestor aliases, identity
or permission changes refuse, while exact owned shutdown remains possible after
the host source is moved or deleted and preserves host data.

Writable/other mounts, source acquisition, storage, authored networks, file inputs,
routing, endpoints and host effects remain outside this bounded frontend. Unsupported intent must
refuse before managed value resolution and provider work. Early typed input
capability refusals retain `E_NATIVE_PROJECT_UNSUPPORTED` without exposing
compiler diagnostics or creating native source/start/run authority. `--detach`,
`--json`, service subsets, recovery and other lifecycle operations refuse before input
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

The native receipt and source paths are distinct from strict Compose v1 artifacts.
Image-only graph receipts remain v2; source-bearing graph receipts use a closed v3
binding, distinct from the existing foreground publication-owner v3. Ready/control
envelopes remain v2. Dead-owner recovery of source-bearing receipts is not admitted
by the separately qualified image-only recovery path. No native hash substitutes
for a normalized Compose hash. Source and fake-driver
checks do not qualify an installed frontend, a live provider, the full authored
corpus, interrupted recovery or resource overhead; those remain separate gates.
