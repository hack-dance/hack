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
after inspection, so additions, removals, renames, and project-label conflicts
refuse. This is not an atomic engine transaction: another Docker client can change
resources after the last observation, or replace a volume under the same name.
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

The closest regression suite is `tests/native-compose-ownership.test.ts`. Its
isolated executable checks accepted resources, collisions, stale generations,
inventory changes, redaction, and actual subprocess overflow/timeout/cancellation.
Docker application readiness and lifecycle acceptance remain command-level gates.
