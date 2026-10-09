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

Writable source mounts, source acquisition, file inputs and routing
remain outside this bounded frontend. The existing
closed two-owned-bridge graph capability keeps its separate receipt and refuses
source/storage intersections. Finite typed host lifecycle hooks use the supervised
frontend owner described below. Unsupported intent must
refuse before managed value resolution and provider work. Early typed input
capability refusals retain `E_NATIVE_PROJECT_UNSUPPORTED` without exposing
compiler diagnostics or creating native source/start/run authority. `--detach`,
`--json`, service subsets and other lifecycle operations except owner-mediated
`down` refuse before input acquisition. `--branch` supplies an explicit native namespace; its omission uses
the canonical project namespace without inferring a Git branch. Profile and env
selection keep their compiler contracts. `--env base` bypasses inherited overlays
with an explicit base selection; omitting `--env` retains the authored/local default.

The separate persistent-storage capability requires the runtime's pinned sibling
witness tool and retains its own ownership and recovery checks. It cannot be combined
with the supervised host-process capability below.

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
Image-only graph receipts remain v2; source-bearing graph receipts use a closed v3
binding, distinct from the existing foreground publication-owner v3. Ready/control
envelopes remain v2. Dead-owner recovery of source-bearing receipts is not admitted
by the separately qualified image-only recovery path. No native hash substitutes
for a normalized Compose hash. Source and fake-driver
checks do not qualify an installed frontend, a live provider, the full authored
corpus, actual dead-owner recovery or resource overhead; those remain separate gates.

## Finite host lifecycle hooks

The experimental foreground frontend admits typed `host.up.before`, `host.up.after`,
`host.down.before` and `host.down.after` commands. Every phase and selected host
environment binding is checked before the first hook. Unsupported workload capabilities still refuse; no intent is
stripped to make the graph acceptable. Normal standalone `graph native plan`, `run`
and `serve` continue to refuse host intent. The frontend alone uses an explicit
version 3 private source envelope and immutable finite-hook permit. Existing graph
receipts and source version 2 keep their meanings.

`up.before` runs after pure native capability review. The frontend then reacquires
input and managed environment selection and performs a fresh native review before
starting workloads. Hook selection, project, source/worktree policy and selected
profiles and authored semantic identity must remain identical. Managed bindings are
reacquired without authorizing a changed workload declaration. `up.after` runs after authenticated native readiness;
current readiness and inputs are checked again before publishing frontend readiness.
The original configured startup budget includes both phases. Commands retain ordered
exec/shell, cwd, environment target, unset and inherited-terminal semantics through
the existing supervised shell owner.

For a ready finite-hook generation, ordinary whole-project `down` contacts the live
foreground owner using a private per-run capability. Ctrl-C makes the same stop
request. `down.before` must succeed before native shutdown starts; a failed phase
leaves the supervisor and runtime live and cannot be replayed. A second interrupt
explicitly cancels the finite hook and requests exact native cleanup. `down.after`
runs only after authenticated native Removed and successful `down.before`. Down
hooks have no new arbitrary duration ceiling; the shell owner supervises cancellation
and process-group settlement. A down client timeout does not replay or cancel the
foreground operation. Detached startup, service subsets and restart remain unsupported.
Known nonzero `down.after` completion reports failure after retiring the stopped
generation. Unknown completion keeps the frontend bindings and hook intent together;
it cannot silently make a new generation eligible.

A distinct private hook owner records intent before each phase, captured child groups
and known completion after child exit and group absence. Commands, values and raw
errors are never journalled. Unknown completion blocks a new generation. Explicit
dead-owner recovery performs no hooks or credential acquisition: the existing native
owner first proves exact Removed, and only fully completed, unchanged hook records
may retire. An interrupted host phase, pre-ready hook-only attempt or ambiguous child
retains evidence and requires separate resolution; no automatic hook replay or
inferred completion is supplied.

Portable controls and synthetic runtime acceptance are distinct from live provider
acceptance. Full NC05 corpus acceptance is still required.

## Supervised host processes

The native foreground frontend also admits normalized `host.processes` with startup
`up` and exit `stop_on_down`, using the same Hack lifecycle mux controller as the
ordinary CLI. Processes start after successful `up.before` and remain owned through
workload readiness. After exact native Removed, the frontend stops its captured
process groups before `down.after` and retires their owner only after known stop.
Startup keeps the configured startup deadline; a running process has no added
duration ceiling. This slice requires tmux because its existing backend supplies
the captured group identity needed for stop; zellij remains unsupported here.

An explicit private source-version5 permit binds the frontend owner, run, project,
branch, semantic selection and process-owner/ready documents. Ordinary standalone
native graph commands still refuse host intent. Source version3 finite hooks and
native receipt versions2–5 retain their meanings. This capability refuses live-source,
persistent-storage and owned-topology intersections before effects.

Commands, cwd and managed values reach the supervised client through a private
one-use local socket. The mux command contains only the internal client and opaque
socket path; managed values are not placed in argv, mux environment or journals.
Compiler-verified HTTP(S) host-binding references resolve to loopback only for host
context, or to an explicit external hostname. Workload/guest, routed and TCP
references remain unsupported until their delivery owners are integrated.

Dead-owner recovery first proves the exact native Removed result, then uses the
saved complete process metadata and current controller token to stop only the
captured groups. A missing session requires those groups already absent; a PID
alone never authorizes a signal. Changed metadata, foreign tokens or an interrupted
launch without a complete ready/state pair retain evidence and cannot replay the
process or hooks. Portable real-child controls do not qualify the retained Event
Agent's tunnels, guest access or routing; live corpus acceptance remains open.
