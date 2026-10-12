# Native Compose resource ownership

`assertNativeComposeOwned` is a read-only preflight for generated native Compose
documents. The command owner calls it under the verified instance lease before
`up`, `restart`, `run`, or `down`, and uses the same Docker engine and context for
the resulting effect. This module does not create, stop, remove, prune, or repair
engine resources.

The caller supplies the exact Compose project and runtime identity, the random
generation IDs from verified current and pending receipts, and the union of their
selected services, jobs, and dependencies. Expected volume names and logical
storage keys, and the default network name, come from the saved immutable generated
documents. The stable random owner token comes from the verified private instance
receipt, and every resource must match its `io.hack.native-config.owner` label. A
reset receipt cannot adopt resources from an earlier owner token. Recorded persistent
storage remains selected even if a later declaration removes its mount.
Caller input is an internal execution contract; authored labels do not authorize
ownership.

The probe selects every project-labelled container, volume, and network, plus
resources occupying exact expected persistent names and normal replica-one names
`PROJECT-SERVICE-1`. One-off containers have generated suffixes and are selected
by their project label. Every selected container must carry version `1`, the exact
runtime identity, a selected generation ID, and a known Compose service label.
Persistent resources must carry version `1`, the exact runtime identity, and the
exact declared name; volumes must also match their logical storage label. Missing
resources are valid during genuinely cold startup. A retained volume must exist
and match its saved `CreatedAt` value in addition to name and ownership labels.
A foreign same-name resource, a stale
generation, an unknown service, a malformed reply, or uncertain inspection refuses.

Docker queries request only structured IDs, names, fixed ownership labels, and
container state, exit code, health status, and one-off status. They never request
`Config.Env`, image values, health logs, or complete inspect objects. Returned
observations contain only validated workload IDs, names, generation IDs and states,
volume names/storage keys/birth timestamps, and network IDs/names. Container names omit Docker's
inspect-only leading slash. Callers can distinguish current and proposed
generations and bind a one-off result to its exact owned name before applying
readiness or cleanup decisions. Failures discard daemon output and diagnostics.

Containers and networks are inspected by full immutable IDs. Docker volumes expose
names rather than immutable engine IDs. The selected inventory is checked again
after inspection, including a second selected-volume inspection that compares
name, storage key and reported creation timestamp. Additions, removals, renames,
project-label conflicts or changed birth metadata refuse. This is not an atomic
engine transaction: another Docker client can change resources after the last
observation. Identical names, labels and timestamps do not establish unique
physical identity or content continuity; an ordinary same-second replacement
may be indistinguishable. A persistent content witness remains a separate gate.
The caller must recheck at its effect boundary and retain explicit recovery for
uncertain outcomes.

Saved `ps` and `logs` use `observeSavedNativeComposeOwned`. This separate read
contract can inspect a receipt-selected CREATED container whose configured
endpoint has no network ID yet. Its owned bridge must exist and pass the same
policy, membership and repeated inventory checks; the container must be absent
from bridge membership. Supplied aliases must equal the configured set. The
read contract does not authorize startup, readiness, `exec`, or ordinary stop.

An interrupted Compose replacement can have a temporary container name prefixed
with its predecessor's 12-character ID while retaining canonical service aliases.
Saved reads and explicit `down --recover` accept that alias set only when the
same scan proves exactly one fully owned predecessor with the canonical name,
same service and another receipt-selected generation. Unknown prefixes and
one-off containers cannot justify this canonical-alias substitution. An empty
alias set needs no substitution and still requires the same owned CREATED
container and bridge proofs. Changed observations refuse. Running containers and external
ingress still require their exact connected endpoint identity. Recovery after an
owned bridge has disappeared accepts only an empty, unbound endpoint ID; a
nonempty ID cannot be attributed to the absent bridge.

The default budget is 15 seconds for the whole probe, with a maximum configurable
probe budget of 60 seconds. Captured stdout is bounded to 8 MiB across all queries;
each query's discarded stderr is bounded to 16 KiB. Inspect arguments are batched
within 16 KiB. These are control-channel budgets, not limits on declared workload
or resource counts. Timeout, cancellation, or budget overflow kills and reaps only
the in-flight probe's owned subprocess group once, including descendants retaining
its pipes. A completed child with closed streams is never signalled by cleanup;
its former process-group ID is no longer an owned target.

The probe owner also issues private, closed failure metadata for admission or
spawn, nonzero child exit, timeout, cancellation, I/O budget, capture and UTF-8
decoding. Only the exact issued error carries this observation; copied errors,
prototypes and arbitrary error properties cannot supply it. Defined probe error
codes, budgets and cleanup obligations remain unchanged; internal capture and
UTF-8 errors now normalize to the fixed `E_NATIVE_COMPOSE_PROBE` refusal. Ordered retained-job
commands translate this metadata and their separate JSON/object boundaries into
fixed redacted reasons; no argv, daemon output, IDs or exit values are retained.

Topology refusals additionally retain a private fixed predicate label on the
exact owner-issued error: network member shape or ID, member/container endpoint
agreement, workload policy or endpoint keyset, and created or live endpoint
membership. Recorded-query replay reports this label alongside the existing
broad reason. It identifies the first refused check on those saved replies;
it does not reconstruct the original caller mode, timing or external cause.
No inspect values are exposed, and admission, scan order and deadlines are
unchanged.

The closest regression suite is `tests/native-compose-ownership.test.ts`. Its
isolated executable checks accepted resources, collisions, stale generations,
inventory changes, redaction, and actual subprocess overflow/timeout/cancellation.
Docker application readiness and lifecycle acceptance remain command-level gates.

## Ingress daemon identity transport

`observeNativeComposeIngress` still reads and compares the daemon ID before and
again after inspecting the shared proxy and network. For an explicit local
`DOCKER_HOST=unix:///...` selection, those two ID reads use fresh, nonpooled
Unix HTTP connections to `GET /info`. The response is bounded and parsed as
untrusted JSON; only the public daemon ID is returned. Other system-info fields,
Docker configuration values and transport diagnostics are discarded. No daemon
identity is cached, and no ownership or readiness observation is removed.

Context, TLS, explicit API-version and custom-header selections retain Docker's
existing CLI transport. The same applies to ambiguous or symlinked client-config
paths, unreadable or malformed configuration, nonempty configured `HttpHeaders`,
or input beyond the 1 MiB config admission budget. Missing configuration or strict
JSON with absent or empty headers is eligible. Config admission uses the selected
`DOCKER_CONFIG` directory or `$HOME/.docker`, binds named path identities and the
exact content hash, and never forwards or exposes authentication values.

The direct observer rechecks its selection, executable, config and socket bindings
before and after every request. Replaced sockets, named symlinks, executables,
configuration or selection sources refuse. Unrelated sibling creation does not
invalidate an unchanged directory. A direct observer that has been admitted never
falls back to the CLI after a failure. Ambient HTTP proxy variables do not change
the Unix destination. Its deadline and cumulative 8 MiB response limit remain
control-channel budgets; cancellation or failure closes only its owned connection.

Storage-witness fences in the Docker carrier repeat the engine-ID read hundreds
of times per command, so they use the same direct transport through
command-scoped admission instead of a fixed observer. Each fence still makes one
fresh read. The first fence under one exact binding (the selection values,
`docker` executable, config and socket identities above) is the existing Docker
CLI read and must equal one direct `GET /info`; only an equal ID admits that
binding for the rest of the command. A different or failed admission read keeps
the CLI for that binding, a changed binding is admitted through the CLI again,
and an admitted direct failure refuses without fallback.

Because each admission is checked against the CLI's own read, storage fences
also accept Docker context selections, which is how Docker Desktop and OrbStack
select their engine. The endpoint is resolved in the Docker CLI's order: a
nonempty `DOCKER_HOST`, then `DOCKER_CONTEXT`, then the client config's
`currentContext` (field names matched without case, like the CLI's decoder),
then the `default` context at `unix:///var/run/docker.sock`. A named context is
read from `contexts/meta/<sha256 of the name>/meta.json` under the config
directory; its `docker` endpoint must be a plain `unix:///` host with no TLS
option, no unknown or duplicate field, and no entry at the context's
`contexts/tls/<sha256>` path. That TLS path is only checked for absence by name;
key material is never opened or listed. Missing, malformed, linked, TCP, SSH,
TLS or header-bearing contexts, and `DOCKER_HOST` together with
`DOCKER_CONTEXT`, keep the CLI. The binding adds the context store entry's path
identities and content digest and the absent TLS path, so any change to the
config, that entry, the socket path or the CLI executable is admitted through
the CLI again. The ingress and VM-file observers, which are trusted without a
CLI comparison, still accept only an explicit Unix `DOCKER_HOST`.

Real Unix-server controls live in `tests/native-compose-engine-identity.test.ts`
and `tests/docker-context.test.ts` (with `HACK_TEST_DOCKER_CLI=1`, it also runs
the installed Docker CLI against two fake Unix engines for every selection);
existing CLI-transport and proxy ownership controls remain in
`tests/native-compose-ingress.test.ts`. These tests establish the bounded transport
and refusal behavior. Actual Docker compatibility and performance require separate
current-artifact fixture and matched measurements.
