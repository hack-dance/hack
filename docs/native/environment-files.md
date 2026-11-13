# Native Compose environment files

Design for HACK-2062. The Compose backend keeps its existing behavior.

Native accepts service `env_file` as a path string, a list of path strings or
long-form entries (`path`, optional `required`, optional `format`). `required`
defaults to true; false skips an absent file, but never an unreadable or unsafe
file. The default format uses Compose dotenv quoting, comments and interpolation;
`format: raw` preserves value text, including quotes and dollar signs. Unknown
options and formats refuse before hooks, image acquisition or VM work.

Files are resolved relative to the Compose file, within the current project root.
Absolute paths inside that root are accepted; escaping the root is refused. Every
path component inside the root is checked without following symlinks. Files must
be regular, single-link, owned by the current user, owner-readable and grant no
group or other permissions. Directories must be owned by the current user and not
group/other-writable. Reads are bounded and recheck file and directory identities,
size and timestamps. Native does not change permissions or migrate files.

Container precedence, highest first:

1. Hack-managed environment, matching Hack's generated Compose environment override.
2. Explicit service `environment`, including empty values.
3. `env_file`, read in list order; the last declaration for a name wins.
4. Image environment defaults for names not otherwise declared.

Interpolation uses the caller's allowed shell variables before the Compose
project directory's `.env`. Native's Compose project directory is the directory
of its selected Compose file. It does not search a primary worktree or load a
second root `.env`, and `.env` alone does not inject variables into containers.
Within an env file, earlier entries are available to later entries; service env
files may also refer to values established by earlier files. Managed values win
the final service destination; service-scoped managed values are not an ambient
interpolation source. Hack key material and adapter-owned credential names cannot
be copied from the caller's shell or files around the managed delivery boundary.

The first unit resolves references only in service `environment` and env-file
values. It supports `$NAME`, `${NAME}`, defaults (`-`, `:-`), alternatives (`+`,
`:+`), required references (`?`, `:?`), nesting and `$$`. Required-reference errors
never echo the authored error word. `.env` references in public fields (images,
commands, ports, labels, mounts and builds) remain unsupported: materializing such
values would put private data in plans, argv or receipts. Paths must be literal.
Unresolved bare declarations that require removal of an image ENV entry refuse
rather than silently becoming an empty value. Explicit empty assignments work.

Start and `doctor --native-preflight` call the same file parser, permission checks
and environment normalizer. Preflight reads these inputs only for validation and
names; it returns no values. Missing required files, malformed input and unsafe
reads produce closed diagnostics with the service, field and source path only.
Optional missing files produce no blocker. Parser excerpts, interpolated error
words and operating-system error text are never included.

All file-derived service values become bare name declarations in the normalized
Compose document. Values stay in memory outside the managed-env fingerprint and
travel through the existing bounded private stdin envelope, then the expiring
guest environment allocation and launcher. They never enter CLI argv, public JSON,
plans, plan identities, receipts, logs or generated files. Changing file values
without changing declarations must leave normalized Compose and its plan identity
unchanged. Preflight never writes the values to its temporary review document.
Existing private-delivery service/key/byte limits apply before effects.

Out of scope: Compose override/include/extends support, CLI `--env-file`, dotenv
selection of Compose files or profiles, command substitution, shell execution,
interpolation in public fields, arbitrary external files, changes to Compose
backend semantics, and automatic permission repair. Tests compare precedence with
[Compose's environment-file rules](https://compose-spec.github.io/compose-spec/05-services.html#env_file)
and [interpolation rules](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/),
with sentinel values checked against public output, diagnostics, normalized
plans and identity inputs. Actual guest delivery is qualified separately on a Mac.
