# Native Compose environment files

Design for HACK-2062. The Compose backend keeps its existing behavior.

![Public admission and private delivery paths](environment-files.svg)

[Diagram source](environment-files.mmd).

Native accepts service `env_file` as a path string, a list of path strings or
long-form entries (`path`, optional `required`, optional `format`). `required`
defaults to true; false skips an absent file, never an unreadable or unsafe file.
Omitted or empty `format` follows Compose dotenv syntax; the literal `default`
is not a Compose format. `format: raw` does not unquote
or interpolate values. Unknown options and formats refuse before hooks, image
acquisition or VM work. Repeating a file is allowed and preserves list order.
Files of inactive-profile services are not acquired; their paths remain excluded
from snapshots and live sharing, including missing required paths.
The reviewed runtime active set must agree before private delivery or effects;
an active service with unprepared file inputs refuses.

Paths are literal and relative to the Compose file, within the current canonical
project root. Absolute paths inside that root are accepted. Escaping the root or
following a symlink inside it is refused. Files must be regular, single-link,
owned by the current user, owner-readable and not writable by group or others;
ordinary 0644 checkouts work. Directories inside the root must be owned by the
current user and not writable by group or others. Reads are bounded and recheck
file and directory identities, size, permissions and timestamps. Native changes
no file or permission. Bounds: 256 KiB and 4,096 lines per file; 64 file references
and 1 MiB total source text per preparation. Existing private delivery limits
(32 services, 256 keys and 32 KiB per service, 256 KiB complete stdin) also apply.

The automatic interpolation file is `.env` beside the selected Compose file:
normally `.hack/.env`, matching Hack's Compose project directory. An adjacent
`.env.state.json` marks possible Hack-materialized output; native refuses to use
that `.env`, whether the state is current, stale or unreadable, rather than copy
another selection's materialized values. The operator can use current Hack env
layers and remove obsolete materialized output deliberately. A root `.env` outside
the Compose directory is not read or refused solely for existing. Native does not
search another worktree or overlay dotenv. Every `.env` uses the same guards.

Container precedence, highest first:

1. Hack-managed environment, matching Hack's generated Compose environment override.
2. Explicit service `environment`, including empty values and unresolved bare keys.
3. `env_file`, in list order; the last resolved declaration for a name wins.
4. Image environment defaults for names not otherwise declared.

A bare env-file name inherits from the interpolation context if present; otherwise
it leaves earlier file assignments intact. A bare service environment key resolves
from the interpolation context; when unresolved it removes that key, including an
image default. Native removes the key from normalized `environment`, then carries its name in
explicit normalized metadata and public engine unset entries, separate from private
value delivery. The runtime must echo the exact unset names during review;
ordinary missing private bindings must continue to refuse.

Interpolation lookup order is Hack-managed global values, the caller's allowed
shell variables, then `.env`. Service-scoped managed values win the final service
destination but are not ambient interpolation sources. For env-file expansion,
that project context wins over resolved service `environment`, then current and
earlier file assignments. A current file assignment replaces the previous file's
assignment before the next line is read. `.env` alone injects no container variables.
Service-environment defaults resolve only against the project context: an env-file
`HOST` does not replace `${HOST:-localhost}` with its file value. Defaults that
reference newly file-backed names are frozen before runtime private ownership.
The same rule applies to public command, entrypoint, user, healthcheck test and
extra-host hostname/target defaults: only authored fallback text is frozen, never file
values. Other runtime-bound sources in the same expression refuse rather than
freeze a different value. Public expressions unrelated to file bindings stay intact.
Native already evaluates `extra_hosts` hostnames in both list and map forms;
map keys receive the same private-source admission, and duplicate frozen keys refuse.
Other mapping keys retain Compose's ordinary key semantics.
File-local cloud names can be used by later assignments without reading those
names from the shell.

Support includes export prefixes, `=` and `:` separators in default format,
comments, single-quoted literals, double-quoted escapes, multiline quoted values,
`$NAME`, `${NAME}`, defaults (`-`, `:-`), alternatives (`+`, `:+`), required references
(`?`, `:?`), nesting to four levels, and `$$`. An unset `${NAME}` yields empty with a
names-only notice; required-reference errors omit the authored error word. Raw
format follows the separately qualified Compose raw parser. Hack key material and
`HACK_*` cannot enter containers via files or shell references. Authored public
runtime-metadata literals keep their existing behavior. Cloud credential
names are not read from the shell; explicit literal file entries remain available
unless the selected credential adapter owns that service's name. Compose control
names (`COMPOSE_FILE`, `COMPOSE_PROFILES`, `COMPOSE_PROJECT_NAME`, `COMPOSE_ENV_FILES`,
`COMPOSE_DISABLE_ENV_FILE`)
in `.env` refuse with names only rather than silently change the selected project.

The approved first unit resolves file values only in service `environment` and
env-file values. If a public field references a name defined by `.env`, managed
global env or allowed shell input, it refuses before effects, even if the reference
has a default. It must never silently select a different fallback. Public fields
include images, commands, ports, labels, mounts, users, healthchecks and builds.
The lead approved this privacy boundary: materializing such values would otherwise
put them in plans, argv or receipts.

Start and `doctor --native-preflight` use the same parser, lookup, permissions and
normalizer, including the same allow-listed shell environment and managed values.
Preflight may therefore need the same project decryption key as start. It returns
only names and paths. Missing required files, malformed input, unsafe reads and
unsupported public interpolation produce closed diagnostics with service, field
and source path only. Optional absent files produce no blocker. Parser excerpts,
interpolated error words and raw OS diagnostics never leave the boundary.

The normalized document removes `env_file` and replaces file-derived environment
values with bare name declarations. Values remain in memory outside managed-env
fingerprints, then travel through the bounded private stdin envelope and the
expiring guest allocation/launcher. They never enter CLI argv, public JSON, plans,
plan identities, receipts, logs or generated files. Original env-file declarations
remain source exclusions in Rust even when normalization removes them, including
absent optional targets, inactive-service files, raw inputs
and duplicate paths. Exclusions compare paths with Unicode canonical normalization
and case folding, so host path aliases cannot enter snapshot archives or live source updates.
Ambiguous matching directory entries refuse, and environment inputs cannot own
source ignore-rule files through an alias. `.env*` remain excluded by the existing source policy. Tests
must cover snapshot and live-share exclusion when an optional file appears later.

Private delivery retains its existing limitations: it cannot use automatic
restart policies, and fresh values need a new incarnation. A file-value-only edit
has no public fingerprint; the operator must run `hack restart` to deliver it to
an existing run. Literal/default-only expressions that consult no private source
stay on the existing public path and retain their restart behavior and identity.
Fresh `hack exec` resolves the selected service's file values again using the
same allowed caller context and delivers them privately to that exec process.
These fresh values may differ from the running container's startup values.

Native builds read raw host contexts. Start and preflight therefore refuse a
native build whose context, Dockerfile or Dockerfile-specific ignore input
overlaps any declared env-file path or the selected automatic `.env` path.
Optional absent and inactive-service declarations remain protected; authored
ignore rules do not lift this refusal. ASCII paths compare without case, and
non-ASCII components are treated as potentially aliased whenever disjointness
cannot be proved. Use separate build inputs, a prebuilt image, or Compose for
overlapping projects. Disjoint contexts and ordinary builds with no env-file or
dotenv input retain their behavior. Fresh selected-service exec does not build.
Managed-env stale checks remain advisory and do not read ephemeral file inputs;
file-value-only changes are not detected by their managed fingerprints.

Unused Compose `x-*` extensions are ignored; Hack-consumed `x-hack-*` fields
still receive admission checks. Exact AWS/ADC mounts recognized by the credential
adapters keep their private adapter path and are never expanded into public plans.
Unreadable reserved bare names remain runtime/adapter-owned, rather than becoming
explicit image-default removals.

Out of scope: override/include/extends support, CLI `--env-file`, dotenv selection
of Compose files or profiles, shell execution/command substitution, public-field
interpolation without an explicit future public-data contract, external files,
automatic permission repair, Compose-backend changes and automatic secret-value
change detection. Tests use sentinel values and recorded Docker Compose v5.6.1 /
compose-go v2.16.1 results, alongside the documented [environment-file rules](https://compose-spec.github.io/compose-spec/05-services.html#env_file)
and [interpolation rules](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/).
Actual guest delivery is qualified separately on a Mac.
