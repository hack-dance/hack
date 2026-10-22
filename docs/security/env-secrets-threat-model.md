# Env and secrets threat model

This document describes how Hack protects project env values and secret keys on a
developer machine. It lists the assets, the trust boundaries, the threats, the
mitigations that are merged on `next`, and the gaps that are still open. It tracks
Linear issue HACK-1127.

For day-to-day usage, see [Env & secrets](../env.md). This page does not change any
behavior. Where it names code, the code is the source of truth.

## Scope

In scope:

- the modern YAML env model (`secretsprovider: project_key`) and its project key
- the legacy secret stores still reachable through `hack env backend`: `keychain`,
  `encrypted_file`, and the `cloud` shim that uses `encrypted_file`
- the paths that deliver values: runtime injection into Compose and host commands,
  `hack env materialize`, `hack env get`, sessions, and the MCP server
- secret values that come from an external manager such as 1Password

Out of scope: the retired hosted account, dashboard and ticket flows, and the
unsupported remote, gateway, node and dispatch surfaces. One residual risk in retained
node code is listed under [open gaps](#open-gaps) so that it is not lost.

## Assets

| Asset | Where it lives | What it protects |
| --- | --- | --- |
| Project env key | `.hack.secret.key` in the checkout, a shared key under the git common dir, the primary checkout's key (linked worktrees), or `HACK_ENV_SECRET_KEY` | Every `secure: v1:...` value in `.hack/hack.env.*.yaml`. The AES-256-GCM key is the SHA-256 of the key text. |
| Encrypted YAML values (`project_key`) | `.hack/hack.env.<overlay>.yaml`, usually committed | Secret values at rest in git. Plaintext scalars in the same files are not secret. |
| `encrypted_file` store and its key | Store file chosen in config; key from `HACK_SECRETS_FILE_KEY`, `~/.hack/secrets-file.key`, or the keychain service `hack-secrets-backend` | Legacy backend values, including the `cloud` shim. |
| `keychain` store | macOS keychain through `Bun.secrets`, one service per project | Legacy backend values. |
| Values from an external manager (for example 1Password) | The manager's vault, until the user pipes a value into Hack or injects `HACK_ENV_SECRET_KEY` into a process | Hack has no first-party 1Password integration. Custody passes to Hack's stores at the moment of the pipe or injection. |
| Decrypted values in flight | Process environments of the `docker compose` client, Compose containers, host commands, lifecycle processes and session shells; `.hack/.env` | The resolved plaintext, after decryption. `.hack/.internal/compose.env.override.yml` holds only `${HACK_ENV_...}` references (HACK-1273). |

## Trust boundaries

1. **Host user account.** Hack runs as the developer. Anything else that runs as the
   same user (editors, language servers, project dependencies, agents) can read the
   same files and keychain items the user can. Hack does not try to defend against
   code that already runs as the user. It does try to keep secrets out of places
   that other users, other machines, or later readers can reach: argv, logs, shared
   files, git, and published build output.
2. **Containers.** Compose containers receive values as process environment. Anyone
   who can reach the Docker engine can read them with `docker inspect`. Container
   images and layers must never contain the project key.
3. **Agents and MCP.** An agent acts with the user's rights, but its prompts,
   transcripts and tool output may leave the machine. Hack treats the agent context
   as a sink that must not receive secret values unless the user asks for one.
4. **CI and managed containers.** CI receives the key only as `HACK_ENV_SECRET_KEY`
   from the CI secret store. The key file is never baked into an image.
5. **Repository inputs.** A cloned repository is untrusted input. It may contain
   symlinks, malformed ciphertext, oversized files or a committed key.

## Threats and current mitigations

Each row names the merged change and the file that carries the control. PR numbers
refer to `hack-dance/hack`.

### Leakage through argv, logs and process listings

| Threat | Mitigation on `next` |
| --- | --- |
| A secret passed as a command argument lands in shell history and in `ps` output that other local users can read. | `--value-stdin` on `hack env add` and `hack env set` reads the value from stdin (at most 64 KiB, fixed refusals that never repeat the input). See `src/lib/env-value-stdin.ts` (`readEnvValueFromStdin`, `assertEnvValueStdinUsage`), #308. The hidden prompt stays available in a terminal. |
| A mistyped `KEY=value` argument is echoed back in an error, or turned into a file name or overlay name. | Key, scope and `--env` arguments are validated before any file access, and the refusal text never contains the argument: `src/cli/env-arguments.ts`, `src/cli/env-selection.ts`, `parseEnvConfigSelection` in `src/lib/project.ts`, the shared check in `src/cli/run.ts` (#308). `--project` and `--target` follow the same rule through `src/cli/project-selector.ts` (`parseProjectSelectorOption`, `unknownProjectMessage`, `resolveRegisteredProjectOption`) and the `runCli` check (#318). Proven by `tests/env-key-argument-redaction-cli.test.ts` and `tests/project-target-argument-redaction-cli.test.ts`. |
| Diagnostics print key bytes or absolute paths. | The `hack doctor` env key check uses closed codes and project-relative subjects only: `src/lib/doctor-env-key.ts` (#309). Envelope and key-file failures use one fixed message: `src/lib/private-file.ts`, `src/lib/project-env-config.ts`, `src/lib/secret-store.ts` (#288). |
| Host command records keep arguments or env values. | `hack host exec` and `hack env exec` records are payload-free (see [host command lifetime](../env.md#host-command-lifetime-and-diagnostics)). |
| Tests leak the contributor's real `HOME`, keychain, Docker config or `HACK_*` variables into a spawned CLI. | `tests/helpers/private-cli-env.ts` (`privateCliEnv`) builds the whole child environment, and `tests/cli-spawn-env-isolation.test.ts` fails any source-CLI spawn that copies the runner environment (#319). |

### Symlinks, TOCTOU and file modes

| Threat | Mitigation on `next` |
| --- | --- |
| A repository plants `.hack.secret.key` as a symlink (dangling or not) so that Hack reads or writes a file it should not. | Key reads go through `readBoundedPrivateFile` (`lstat`, `O_NOFOLLOW`, descriptor and path identity checks, 1 MiB bound, fatal UTF-8). New keys are created with `createPrivateFileExclusive` (`O_CREAT|O_EXCL|O_NOFOLLOW`, mode 0600, `fchmod`, `fsync`). Both are in `src/lib/private-file.ts`, used by `resolveProjectEnvKey`, `ensureProjectEnvSecretKey` and `resolveInheritedProjectEnvKey` in `src/lib/project-env-config.ts` (#288). |
| A symlinked `.hack/.env`, overlay file or `.hack` directory redirects a write, or a reader sees a partial file. | `src/lib/private-env-file.ts` (`readPrivateEnvFile`, `writePrivateEnvFileIfChanged`) and `replacePrivateFileAtomic` in `src/lib/private-file.ts`: a private sibling is written and fsynced, then renamed over the target; symlinks and non-regular entries are refused with one fixed message (#302). Used by `src/lib/hack-env.ts` and `materializeProjectEnv`. |
| A world-readable env file or store. | `.hack/.env`, overlays and the `encrypted_file` store are written 0600, and a same-content file with group or other access is tightened (#302). The `hack doctor` env key check reports `env-key-weak-permissions` and `env-key-wrong-owner` (#309). |
| The Compose backend leaves decrypted values at rest in `.hack/.internal/compose.env.override.yml` after `up`, `down`, a failed `up` or an interrupted one. | The override holds only `${HACK_ENV_<digest>_<KEY>}` references; each value reaches `docker compose` through its process environment, so no Compose command writes a value to disk, whatever way it ends (`renderComposeEnvReferenceOverride` in `src/lib/compose-managed-env.ts`). The file keeps its path because Compose records it in each container's `config_files` label. It is written with `replacePrivateFileAtomic` (mode 0600, symlink refused), and a literal value is refused before any write (`writeComposeEnvOverride` in `src/lib/compose-env-at-rest.ts`). A file left by an earlier version is replaced by the next Compose command that renders the override, removed by one that renders none and by `hack down` (before its hooks, remote target and Compose down, so none of them can skip it), and reported by the `hack doctor` "compose env at rest" check by counts only; `hack doctor --fix` removes it. Removal moves the file aside atomically and classifies what it moved, so a value-free file written concurrently is put back rather than deleted (the path is absent for that moment; see gap 4). An aside left by a crash between the move and the delete is reported by the doctor check by count and removed by a later removal, `hack doctor --fix` or a Compose command that renders the override, once it is more than a minute old. Legacy adoption gives the reference values only to its Compose config-hash probe at preview and preparation; a saved recheck runs without values and binds each container's config-hash label to the hash proven at preparation. `hack config adopt` (with or without `--stop`) and its preview refuse a literal override before preparation, because an adoption pins the file's bytes and inode for its life. Recovery acts on an existing preparation, so the store refuses instead: publication (`--recover --stop`) and switch completion (`--recover`) refuse a generation bound to a literal override before any original moves, and name `hack config adopt --recover --rollback` (HACK-1318). Rollback stays allowed. While a prepared, active or pending adoption exists, no removal touches the file (removal would make the adoption unloadable); an adoption that an earlier version made over a literal file therefore keeps its values at rest until `hack config adopt --rollback`, and the doctor check names that next step (see gap 4). The per-service `HACK_ENV_*` values go only to `docker compose` invocations that read the override; the `docker inspect`, `logs` and `events` children for dependency cache progress and reuse get the environment without them (`withoutComposeEnvReferences`). Proven with a stub `docker` by `tests/compose-env-at-rest-cli.test.ts`, `tests/compose-env-at-rest.test.ts`, `tests/compose-env-reference-least-privilege.test.ts`, `tests/doctor-fix-noninteractive.test.ts`, `tests/native-compose-adoption-generation.test.ts` and the sentinel scan `tests/env-secret-sentinel-scan.test.ts` (HACK-1273, HACK-1318). |
| Two writers of the `encrypted_file` store lose an update. | An in-process queue plus a cooperative `<store>.lock` using the owner protocol from `src/lib/projects-registry-lock.ts`; a symlinked store path is refused for writes (`src/lib/secret-store.ts`, #302). |
| Concurrent first users of the `encrypted_file` store each generate a key; the last key file wins and the store, already encrypted under another key, can no longer be decrypted. | The generated key is published with `publishPrivateFileExclusive` (`src/lib/private-file.ts`): a fsynced 0600 sibling is linked into place only when no key file exists, so losers adopt the published key. A store found non-empty after the first key read re-reads the key file before the keychain fallback. Proven across eight worker processes by `tests/secret-key-provisioning-convergence.test.ts`. |
| Concurrent first secrets in the primary checkout and a linked worktree create two different project keys (checkout-local and shared), so values do not decrypt across checkouts; or a reader refuses a key file that another process is still publishing. | When no key exists, `ensureProjectEnvSecretKey` (`src/lib/project-env-config.ts`) creates it under a cooperative lock at `<git common dir>/.hack.secret.key.lock` and repeats the lookup under the lock. Key files are published complete with `publishPrivateFileExclusive`, and a key read that overlaps a publication is retried for about a quarter second while the entry is a regular file. Proven by `tests/secret-key-provisioning-convergence.test.ts`. Hack v4 writers do not take the lock. |

### Malformed or hostile ciphertext

| Threat | Mitigation on `next` |
| --- | --- |
| Truncated tags, oversized ciphertext or non-canonical base64 cause a wrong decision or a crash. | `decryptProjectEnvValue` (`src/lib/project-env-config.ts`) and `parseEncryptedEnvelope`/`decryptStore` (`src/lib/secret-store.ts`) require canonical base64 (`decodeCanonicalBase64` in `src/lib/private-file.ts`), a 12-byte IV and a 16-byte tag, pin `authTagLength: 16`, bound the size before decoding, and fail with one fixed error (#288). |
| Ciphertext is moved to another variable, scope or file and still decrypts. | Not prevented. The current v1 format authenticates no associated data. `tests/aes-gcm-v1-context-binding.test.ts` pins this behavior so that any change is deliberate (#302). See [open gaps](#open-gaps). |
| Ciphertext is moved to another key context: another project, a different `HACK_ENV_SECRET_KEY`, or a store with another key. | Refused with the fixed `Invalid secure env value.` or store error, which contains neither the value nor any key. Cross-context controls in `tests/aes-gcm-v1-context-binding.test.ts` cover each move. The key alone decides: every move that keeps the key is accepted (see [cross-context substitution](#cross-context-substitution-accepted-under-v1)). |

### Public-artifact and git leakage

| Threat | Mitigation on `next` |
| --- | --- |
| The key is committed. | The root `.gitignore` gets a `.hack.secret.key` entry when the key is created. Encryption refuses a git-tracked key, including an inherited primary key, before it is copied (#288). `hack doctor` reports `env-key-tracked` at any depth (#309) and the "generated files" check can untrack a root key with `--fix`. |
| A key copy ships in build output or a static site. | `hack doctor` reports `env-key-public-path` for copies under `public/`, `static/`, `dist/`, `build/`, `out/`, `www/`, `_site/`, `.next/` and `.output/` (#309). |
| A weak, short or repetitive key. | `env-key-wrong-length` and `env-key-low-entropy` (#309). Generated keys are 32 random bytes in base64url. |
| Materialized `.hack/.env` or local overrides are committed. | Hack owns a committed `.hack/.gitignore` block, and `hack doctor` flags tracked generated files (see [ignore rules](../env.md#ignore-rules-committed-hackgitignore)). |
| A secret leaks into a public artifact through a path nobody listed. | `tests/env-secret-sentinel-scan.test.ts` runs in the CI `test` job. It gives a primary checkout and a linked worktree random synthetic secrets through `env add --secret --value-stdin` (shared and `--local`), runs materialize, exec, up (Compose generation), env apply, logs, list, explain and doctor, then commits everything with `git add -A`. It requires zero occurrences of any value or the project key, raw or hex/base64/base64url encoded, in CLI output, recorded child argv, tracked files, every Git object, HACK_HOME, the private HOME and its caches, and generated Compose and runtime files. Plaintext may exist only in `.hack/.env`, and key text only in key files; each must be git-ignored, untracked and mode 0600. `.hack/.internal/compose.env.override.yml` must hold `${HACK_ENV_...}` references and no value, and must also be private and ignored. Values may reach a child's environment only for the exec'd command and `docker compose`. Positive controls prove delivery and that the scanner finds planted encodings in files and Git objects. Docker is a recording shim; no engine, keychain or installed Hack is reached. |
| A dependency vulnerability ships in Hack. | `bun install --frozen-lockfile`, and the read-only `scripts/dependabot-inventory.ts` lists open alerts (#309). Hack does not sandbox project dependencies that run under `hack host exec`; they receive the injected env by design. |

### Agent and MCP exfiltration

| Threat | Mitigation on `next` |
| --- | --- |
| An agent puts a secret in a prompt, an argument or a log. | Canonical agent guidance in `src/agents/instruction-source.ts` says to pipe secrets with `--value-stdin` or use the hidden prompt, to treat `hack env get` and `--show-secrets` as plaintext sinks, and never to repeat their output (#308). The generated plugin bundle and checked-in examples render the same text. |
| An MCP tool returns secret values. | `hack.project.env.keys` and `hack.project.env.explain` in `src/mcp/server.ts` return names and provenance only; `buildEnvKeysArgs` never emits `--show-secrets`, and child stdout and stderr are withheld. |
| A compromised dependency or agent reads the key file. | Out of reach for Hack inside the same user account (boundary 1). File modes and the symlink rules above only stop other users and redirected writes. |

## Open gaps

These gaps are known and not closed on `next`. Each one needs its own change.

1. **Crash-safe key rotation.** Rotation is manual: move the key aside and re-add each
   secret. A crash or a partial run leaves files encrypted under two different keys,
   and Hack has no journal or resume step for this. There is also no command that
   rotates the `encrypted_file` store key.
2. **Independent crypto review.** The KDF (a single SHA-256 of the key text), the
   missing AAD binding and the v1 envelope format are characterized in tests, and
   [the bounded decision record](env-secrets.md) keeps the format unchanged. The
   independent crypto review flagged in #288 (WU14) has not happened. Any format
   change must keep v1 values readable.
3. **Live keychain and 1Password custody receipts.** No test or receipt proves, on a
   real macOS host, that values stored through the `keychain` backend or piped from
   1Password stay only in the expected custody: the keychain item, the encrypted YAML
   or store, and the target process environment. The CLI tests disable the keychain
   fallback (`HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK=1`) and never call 1Password.
4. **Plaintext materializations and the Compose client environment.** `.hack/.env`
   is private (0600, atomic, symlink refusal) and git-ignored, and the sentinel scan
   enforces that. It still holds decrypted values by design, so backups, file sync and
   anything running as the user can read it. `.hack/.internal/compose.env.override.yml`
   no longer holds values (HACK-1273), but the `docker compose` client process now
   carries one `HACK_ENV_*` variable per service and key. Like every injected env, it is
   readable by the same user (for example `ps eww`) for the life of that process. Each
   service gets its own copy of each value, so the size grows with services times keys.
   A project whose resolved values exceed the platform's argument and environment limit
   (about 1 MiB in total on macOS; on Linux also 128 KiB, `MAX_ARG_STRLEN`, for one
   `NAME=value` string such as a large PEM bundle) cannot start through Compose; the
   start fails with `E2BIG`. Existing containers keep their values in `docker inspect`
   (gap 9). A direct `docker compose -f` run of the override outside Hack gets blank
   values. Legacy adoption resolves the values at preview and preparation and checks
   each container's config-hash label against Compose's hash computed with them; a
   saved recheck, which has no key or values, compares the label with the hash saved
   at preparation while the Compose copy, the generated override bytes and the managed
   env revision stay pinned. Removing an earlier version's literal override moves it
   aside first; if a concurrent Hack command had just written a value-free file there,
   that file is put back, but for the moment between the move and the put-back the path
   is absent, so a concurrent Compose command reading it then fails and must be
   retried. An aside left by a crash in that step stays until a later removal finds
   it stale; `hack doctor` reports it by count. An adoption that an earlier Hack
   version made over a literal override keeps that file, values included, until it is
   rolled back: the adoption pins the file, so Hack refuses to remove it and the doctor
   check names rollback, `hack up` and adopting again as the way to drop the values.
   A preparation that an earlier version made over a literal override is never
   published now (HACK-1318); until `hack config adopt --recover --rollback` releases
   its journaled switch, it also keeps the file. Other generated files under `.hack/.internal/` and `.hack/.branch/` are
   written with the process umask; the scan shows they hold no values today.
5. **YAML env file writes.** `writeProjectEnvConfigFile` in
   `src/lib/project-env-config.ts` also uses `writeTextFileIfChanged`, so
   `.hack/hack.env.*.yaml` writes follow a symlink at the file. These files hold
   ciphertext and non-secret plaintext, but a hostile repository could redirect the
   write.
6. **`encrypted_file` key file reads.** Key writes now use the
   `src/lib/private-file.ts` helpers: explicit provisioning replaces the key
   atomically, and first-use generation publishes it exclusively. `readEncryptedFileKey`
   in `src/lib/secret-store.ts` still reads with `readTextFile`, which follows a
   symlink at the key path.
7. **Directory TOCTOU.** The #302 directory checks are path-based `lstat` with
   identity rechecks, not `openat`/`renameat`. A swap of `.hack` between the recheck
   and `rename(2)` is not fully closed. The store lock is cooperative, and v4 writers
   do not honor it.
8. **MCP command output.** `hack.project.run`, `hack.project.exec` and the log tools
   return child output. A command such as `printenv`, or an app that logs its env,
   puts injected values into the agent context. The only gates are the client's
   approval for destructive tools and the agent guidance.
9. **Container env visibility.** Values in container environments are visible to
   anyone with Docker engine access (`docker inspect`). This is inherent to env
   injection.
10. **Retained node code (unsupported).** `src/lib/nodes-registry.ts` stores node
    tokens with `security add-generic-password ... -w <value>`, which puts the value in
    argv for the life of that process. The node surface is unsupported; fix or remove
    it before that surface returns.
11. **Cooperative key-creation lock.** Concurrent project key creation converges only
    among writers that take `<git common dir>/.hack.secret.key.lock`. Hack v4, a
    manually copied key, or a git dir that cannot hold the lock (creation then runs
    unserialized, as before) can still produce divergent keys; `hack doctor` reports
    divergent key files. A crashed lock owner is reclaimed only when its process is
    gone, by the protocol in `src/lib/projects-registry-lock.ts`.
12. **Limits of the sentinel scan.** The scan covers the files, argv and output that
    the listed commands produce with a recording Docker shim. It does not cover a real
    engine (`docker inspect`, container logs, image layers), application output, crash
    reports, session archives, the keychain backend or 1Password, other CLI commands,
    or the native runtime backend. A zero-hit result is evidence for those paths and
    encodings only; it is not a complete-redaction claim.

## Cross-context substitution accepted under v1

Under the v1 formats the key alone decides whether ciphertext opens. The tests in
`tests/aes-gcm-v1-context-binding.test.ts` refuse every move to another key and
pin these moves as accepted. An attacker who can write a repository's env files can
therefore swap or copy authentic ciphertext among them and change which value a
variable receives, without knowing any key:

- between variables and scopes in one file
- between overlays of one project (for example `staging` to `default`)
- between the shared env file and the `--local` override
- from the primary checkout to a linked worktree, which share one key
- between unrelated projects that use the same `HACK_ENV_SECRET_KEY` (for example
  one CI secret for several repositories)
- between `encrypted_file` stores with the same key, whatever their paths
- across formats when the same key text is used for the project key and the
  `encrypted_file` store: a store envelope re-framed as a `v1:` value decrypts to the
  whole store map (the reverse is refused because the plaintext is not a store map)

Mitigations available today: review changes to `.hack/hack.env.*.yaml` like code,
use a different key per repository and per backend, and do not reuse a project key
as `HACK_SECRETS_FILE_KEY`. Binding ciphertext to its context needs a new envelope
version with associated data and a migration contract (see
[the decision record](env-secrets.md)).

## Related

- [Env & secrets](../env.md)
- [CLI reference](../cli.md)
