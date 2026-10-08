# Private native Compose rendering

`src/lib/native-compose-renderer.ts` provides a pure translation component for
the experimental native configuration path. It does not enable native `up`,
adoption, runtime recovery, routing, or host lifecycle execution by itself. The
[native compiler](native-config-compiler.md) remains the authored acceptance owner.

`renderNativeCompose` takes a successful compiler plan, its complete environment
plan, a caller-verified absolute project checkout root, a distinct stable
`runtimeIdentity`, a persisted private-store `ownerToken`, an owner-generated
`generationIdentity`, and explicit managed
baseline values for every selected workload. The CLI transport's plan record is
accepted without casting it to a generated type. The renderer validates closed
field coverage and versions before returning one private Compose JSON document.
Unknown fields, nulls, inconsistent namespaces, incomplete bindings, missing values
and unsupported requirements refuse with a fixed `NativeComposeRenderError` code.
An error never contains a partial document or echoes an input value.

Call `assertNativeComposeSupported` with those same plan, metadata, path and
identity inputs before requesting private baseline values. It runs the final
renderer’s shared validators, including support refusals and exact metadata
binding checks. It returns no document and substitutes no placeholder values.
Final rendering revalidates the inputs and additionally checks delivered value
coverage and baseline presence. Preflight is not a freshness receipt; the
execution owner still fences source and environment generations before apply.

The default renderer refuses nonempty host declarations. The command owner can
set `beforeHooksOwned: true` for its validated and journaled finite `host.up.before`
and `host.up.after` execution. The flag retains its original name. This admits that
bounded host contract without placing host commands or
host environment values in the Compose document. Shared effective-binding checks
serve both guest rendering and the hook owner; each supplies its selected baseline
and allowed endpoint policy. Down phases and persistent processes still
refuse. The flag itself provides no execution or freshness proof.

The component performs no filesystem or process operations, engine requests,
environment lookup, decryption, hook execution, or registry/cache inspection. Its
result contains private runtime values. Do not log it, publish it, include it in
portable semantic hashes, or write it into the authored configuration directory.

## Supported translation

| Native intent | Generated Compose representation |
| --- | --- |
| Image or basic build | Preserve exactly one source; build context anchors to the verified checkout root and Dockerfile stays relative to that context. |
| Pull policy | Preserve canonical `always`, `never`, `missing` for images or `build` for builds; no inferred default or tag/cache rewrite. |
| Omitted command and entrypoint | Both fields remain omitted, preserving image defaults. |
| Explicit exec command | Ordered argv list, including empty later arguments. |
| Explicit shell command | Ordered `/bin/sh`, `-c`, shell-source argv; a compatible Linux image must provide `/bin/sh`. No image shell is guessed. |
| Explicit shell entrypoint | Add fixed fourth argv `hack-native-entrypoint` as shell `$0`, preserving all appended command arguments in `$@`. |
| Explicit entrypoint with explicit command | Ordered argv, with an empty entrypoint array retained to clear the image entrypoint. |
| Init, shutdown, restart | Preserve explicit false, canonical signal, exact duration, and restart mode/retry count; omitted settings remain omitted. |
| Working directory | Preserve the normalized absolute container path. |
| Profiles | Preserve workload profiles; return the exact selected profiles separately for the execution owner. |
| Bind mounts | Long syntax with absolute checkout-anchored source, explicit access, and `create_host_path: false`; missing sources must not cause implicit directory creation. |
| Persistent worktree storage | Named volumes with stable instance/storage identity; no generation token in data identity. |
| Owned bridge networks | Stable instance/network names, bridge driver and explicit internal policy; allocate selected attachments only. |
| Workload network attachments | Preserve explicit attachment and alias maps; omission retains the outbound default bridge. |
| Service-started dependency | `service_started`. |
| Service-ready dependency | `service_healthy`, requiring an explicit supported exec readiness check on the target. |
| Successful job dependency | `service_completed_successfully`; jobs share the generated Compose services namespace. |
| Exec readiness | `CMD` plus ordered argv; explicit shell source becomes `CMD /bin/sh -c`. |
| Literal, default, managed reference, unset | Deliver exactly the compiler's effective destination bindings; absent destinations stay absent and empty strings stay present. |
| HTTP/HTTPS service endpoint | Explicit `protocol://service-name:port` using project-scoped Compose service DNS. |
| HTTP/HTTPS external binding | Explicit `protocol://hostname:port`; external loopback retains its container-context meaning and is not translated into a host gateway. |

`source.root` is reported as a lexically anchored `sourceRoot` for the execution
owner. It does not create an implicit source mount. Authored bind and build paths
anchor to the verified project checkout, never the generated file's directory,
`.hack`, invocation CWD, or another source path.

Managed baseline values are supplied as a selected-workload map, then key/value
maps, by the existing environment owner. They are never read from `process.env`.
Managed references read the immutable baseline even if a different authored entry
overwrites or removes that source destination. The renderer checks exact workload
coverage, destination directives, scope ownership, and supplied baseline presence;
it does not reproduce encrypted storage selection or key handling.

Every generated Compose string value escapes dollars once. `${NAME}`, `$NAME`,
literal dollars, shell source, private values and dollar-bearing host paths remain
literal at Compose's interpolation boundary. Keys are closed or validated names.
The returned `document` and `json` contain the same escaped representation. The
execution owner must use normal Compose interpolation rather than requesting
`--no-interpolate`, which would change this encoding's interpretation.

## Ownership and remaining refusals

The caller supplies a stable Compose-compatible `runtimeIdentity` and random
32-character lowercase hexadecimal `ownerToken` and `generationIdentity`. The
owner token belongs to the persisted private store; it changes if that store is
recreated. Neither token is a credential or derived from secret values or input
fingerprints. The renderer adds
these fixed service labels:

- `io.hack.native-config.version=1`
- `io.hack.native-config.instance=<runtimeIdentity>`
- `io.hack.native-config.owner=<ownerToken>`
- `io.hack.native-config.generation=<generationIdentity>`
- `io.hack.native-config.workload=service|job`, from the selected authored namespace

The workload discriminator is container-only. A service may also have restart
mode `no`; execution must use this discriminator when distinguishing a running
service from a successfully completed job.

Persistent volumes and owned networks receive version, instance and owner labels.
Volumes additionally receive `io.hack.native-config.storage=<logical-name>`.
Volume names encode both component lengths to prevent ambiguous concatenation
between different worktrees. Changing the generation changes container labels,
while stable volume and network identity remain unchanged. There are no arbitrary
caller labels, Compose extension maps, includes, env files, or override documents.
A recreated private store retains those stable names but changes every resource’s
owner label. The execution owner must reject resources carrying an older owner
token rather than adopting them merely because their names and instance match.

The execution owner must pass the exact project name and selected profiles
explicitly, use exactly this generated file, prevent ambient file/flag selection,
publish it with private permissions and a generation fence, and retain data on
down. This component does not create or remove resources or grant cleanup authority.

The first component refuses:

- An explicit entrypoint with an omitted command. Compose suppresses an image's
  default command for a non-null entrypoint; resolving that combination requires
  separate image-default qualification. This is partial entrypoint support.
- HTTP or TCP readiness, without inventing curl, wget, netcat or another image tool.
- Nonempty host hooks or host environment delivery without the bounded up-hook
  owner; down phases and persistent processes remain unsupported. Empty
  host declarations have no execution effect.
- Authored routing/open settings and route endpoint delivery, pending a routing owner.
- Typed host/gateway endpoints, pending backend-specific address qualification.
- TCP endpoints, pending an explicit address-versus-URI derivation contract.
- Unknown native fields or unsupported runtime options, rather than dropping them.

No new CPU, memory, PID, port or egress restriction is synthesized.
The generated default Compose network preserves ordinary project-scoped resolution
and outbound connectivity. Runtime availability and reachability remain apply-time
checks.

An explicit workload attachment map replaces the implicit default selection. Each
owned custom network preserves its authored `internal` policy and aliases, with
names distinct across worktree instances. A routed service additionally joins
the separately verified ingress; that network is never an authored declaration.
Disconnected direct-service endpoint bindings refuse before private value delivery.

## Verification boundary

Focused tests use independent expected Compose representations and redacted
refusals. Opt-in tests invoke actual configuration normalization only:

```sh
HACK_TEST_COMPOSE_CONFIG=1 bun test tests/native-compose-renderer.test.ts tests/native-compose-renderer-config.test.ts
```

The configuration tests include a negative control that expands an unescaped host
variable, plus dollar-bearing commands, values and paths. Compose may re-escape
dollars when serializing its normalized model; this output is a reusable Compose
document, not proof of values delivered to a running container. Without the opt-in,
the five external configuration checks are explicitly skipped. They never start,
pull or build a workload. Runtime lifecycle, actual private delivery, readiness,
retained data, and recovery need separate end-to-end qualification.

The mappings follow the official [Compose services](https://docs.docker.com/reference/compose-file/services/),
[interpolation](https://docs.docker.com/reference/compose-file/interpolation/), and
[volume](https://docs.docker.com/reference/compose-file/volumes/) contracts.
