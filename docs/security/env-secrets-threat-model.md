# Env and secrets threat model

This document describes how Hack protects project env values and secret keys on a
developer machine. It lists the assets, the trust boundaries, the threats, the
mitigations that are merged on `next`, and the gaps that are still open. It tracks
Linear issue HACK-1127, with the HACK-2163 audit corrections below. Runtime
claims were audited on 2026-11-13 at `c89f4fd7cc`. HACK-2163's containment,
diagnostic and ignore fixes subsequently merged in #756; the mitigations below
describe those fixes while retaining the remaining custody limits.

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

Attacker model for values and keys at rest (HACK-2165): Hack protects machine-local env
values and keys against accidental collection by Git and against other users of the
machine, and binds each check to the file it actually opens or replaces. A process
already running as the same user is out of scope: it can read the key and every
machine-local file directly, so Hack adds no machinery whose only purpose is to defeat
such a process racing its checks.

## Assets

| Asset | Where it lives | What it protects |
| --- | --- | --- |
| Project env key | `.hack.secret.key` in the checkout, a shared key under the git common dir, the primary checkout's key (linked worktrees), or `HACK_ENV_SECRET_KEY` | Every `secure: v1:...` value in `.hack/hack.env.*.yaml`. The AES-256-GCM key is the SHA-256 of the key text. |
| Encrypted YAML values (`project_key`) | `.hack/hack.env.<overlay>.yaml`, usually committed | Secret values at rest in git. Plaintext scalars in the same files are not encrypted and may still be sensitive. |
| `encrypted_file` store and its key | Store file chosen in config; key from `HACK_SECRETS_FILE_KEY`, `~/.hack/secrets-file.key`, or the keychain service `hack-secrets-backend` | Legacy backend values, including the `cloud` shim. |
| `keychain` store | macOS keychain through `Bun.secrets`, one service per project | Legacy backend values. |
| Values from an external manager (for example 1Password) | The manager's vault, until the user pipes a value into Hack or injects `HACK_ENV_SECRET_KEY` into a process | Hack has no first-party 1Password integration. Custody passes to Hack's stores at the moment of the pipe or injection. |
| Local YAML layers | `.hack/hack.env.local.yaml` and `.hack/hack.env.<overlay>.local.yaml` | May hold plaintext; these are local-only, not safe to commit. New local files use 0600; an existing file keeps its mode. |
| Multiplexer input | `$TMPDIR/hack-mux-env-*/env.json` (the OS temp directory when TMPDIR is unset) | A private plaintext env payload, consumed and removed by the pane wrapper or owned cleanup; it exists on disk before that cleanup. A payload older than 10 minutes is refused and removed by the next staging unless its `env.json` or directory is a path current configuration reads, or that configuration cannot be read; a directory still holding any other file is not removed (HACK-2170, HACK-2181). |
| Background command output | `<HACK_HOME>/commands/<id>/stdout` and `stderr` | Output can contain injected values. Redaction is partial and delayed; withholding a read does not erase disk bytes. |
| Background command arguments | `<HACK_HOME>/commands/<id>/meta.json` and `launch.json` | Automatic env maps are omitted, but caller argv is retained, including with metadata-only capture. Expanded values in argv are not redacted. |
| Lifecycle output | `.hack/.internal/lifecycle/<project>.log` (and `<log>.before-private-*` kept history), and a FIFO in a private `${TMPDIR:-/tmp}/hack-lifecycle.*` directory | Hooks and persistent processes can emit injected values, stored verbatim. The log is private and owner-checked; remaining gaps are listed in gap 16 (HACK-2170). |
| Decrypted values in flight | Process environments of the `docker compose` client, Compose containers, host commands, lifecycle processes and session shells; `.hack/.env` | The resolved plaintext, after decryption. `.hack/.internal/compose.env.override.yml` holds only `${HACK_ENV_...}` references (HACK-1273). |

## Where values travel

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="env-secrets-flow.dark.svg">
  <img src="env-secrets-flow.light.svg" alt="Resolved values reach user-child environments after key filtering, mux input files and output stores; parser diagnostics expose only fixed kinds and locations.">
</picture>

[Diagram source](env-secrets-flow.mmd). Paths depend on the command: a child
can print injected values, and a background capture stores output before its
partial scan. A file-backed project key is a decryption input, not an application
value. User-child environments filter key material. Deliberate Hack re-execs
receive keys explicitly and filter their own user children. Env-layer, legacy
contract and store diagnostics report fixed kinds and numeric locations without
source text; see audit items 13 and 14 for their remaining limits.

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
   Metadata-only `env list` defaults and its terminal-only `--show-values` reveal
   reduce accidental exposure in logs and transcripts. They are not access control
   against a local process: a process can open a pseudo-terminal or loop over
   `env get KEY` with the same filesystem and key access.
4. **CI and managed containers.** CI receives the key only as `HACK_ENV_SECRET_KEY`
   from the CI secret store. The key file is never baked into an image.
5. **Repository inputs.** A cloned repository is untrusted input. It may contain
   symlinks, malformed ciphertext, oversized files or a committed key.

## Threats and current mitigations

Each row names the merged change and the file that carries the control. PR numbers
refer to `hack-dance/hack`.

### Leakage through argv, logs and process listings

HACK-2163 hardens three boundaries found in the env audit:

| Threat | Mitigation on `next` |
| --- | --- |
| An inherited project or legacy-store decryption key reaches a host command, lifecycle hook, session shell, background command or Compose interpolation. | `src/lib/child-environment.ts` removes `HACK_ENV_SECRET_KEY`, `HACK_SECRETS_FILE_KEY`, `HACK_GATEWAY_TOKEN`, `HACK_GATEWAY_STATIC_TOKEN` and `HACK_TAILSCALE_AUTH_KEY` from child environments, including explicit overrides. Shell runners and direct spawn sites use it. The native shell adapter retains its stricter `HACK_*` restriction. Deliberate Hack re-execs retain credentials through `hackReexecEnvironment`: daemon launch, native background commands, detached native startup, MCP command children, TUI commands and command dispatchers. `env apply` marks its Hack restart re-exec explicitly, including its terminal supervisor path. Their eventual tool and service children still apply the default filter. `tests/child-environment.test.ts` checks real host and lifecycle children and a real Compose config render with isolated client configuration; `tests/background-command-process.test.ts` checks a detached command. |
| A parser diagnostic quotes an env value into CLI text, JSON, a daemon reply, an MCP result or a log. | Env-layer, legacy-contract, materialization-state and secret-store parse boundaries use `envParseDiagnostic` in `src/lib/env-parse-diagnostic.ts`. It emits a fixed syntax kind and numeric source coordinates, never a parser message or source snippet. The owning error supplies the file path. Bun's JS call-site coordinates are not used as input-file coordinates. `tests/env-parse-diagnostic.test.ts` puts a sentinel on malformed lines and checks resolution, mutation, CLI text and JSON; daemon and store tests cover their shared boundaries. The pinned Bun parser returned generic messages for the audited malformed YAML samples; forwarding raw messages was present, but source-text leakage from those samples was not reproduced. |
| Legacy plaintext `.hack/.env.<overlay>` files are offered for commit, or a daemon writes them for a YAML-layer project. | The managed `.hack/.gitignore` and runtime `info/exclude` rules include `.env.*`; existing maintenance operations refresh the rules. `.env.state.json` remains ignored and is still diagnosed when tracked. Doctor reports tracked or unignored legacy overlays without reading their contents. `POST /v1/env/set` and `POST /v1/env/unset` refuse YAML-layer projects with `yaml_env_mutation_unsupported` before a legacy write or secret-store mutation. `tests/doctor-generated-files.test.ts` and `tests/daemon-env.test.ts` cover the ignore upgrade, tracking detection and daemon refusal. |

| Threat | Mitigation on `next` |
| --- | --- |
| A secret passed as a command argument lands in shell history and in `ps` output that other local users can read. | `--value-stdin` on `hack env add` and `hack env set` reads the value from stdin (at most 64 KiB, read to end of input within a 30-second deadline, fixed refusals that never repeat the input). The stdin deadline is proven by `tests/env-value-stdin-bounds-cli.test.ts`. OS keychain calls have a 60-second deadline with a closed refusal (`src/lib/native-keychain.ts`); `tests/native-keychain.test.ts` proves the deadline with a call that never settles. The end-to-end keychain case in `tests/env-value-stdin-bounds-cli.test.ts` runs only on Linux hosts with libsecret installed and is skipped elsewhere, so hosted CI may not run it. See `src/lib/env-value-stdin.ts` (`readEnvValueFromStdin`, `assertEnvValueStdinUsage`), #308. The hidden prompt stays available in a terminal. |
| A mistyped `KEY=value` argument is echoed back in an error, or turned into a file name or overlay name. | Key, scope and `--env` arguments are validated before any file access, and the refusal text never contains the argument: `src/cli/env-arguments.ts`, `src/cli/env-selection.ts`, `parseEnvConfigSelection` in `src/lib/project.ts`, the shared check in `src/cli/run.ts` (#308). `--project` and `--target` follow the same rule through `src/cli/project-selector.ts` (`parseProjectSelectorOption`, `unknownProjectMessage`, `resolveRegisteredProjectOption`) and the `runCli` check (#318). Proven by `tests/env-key-argument-redaction-cli.test.ts` and `tests/project-target-argument-redaction-cli.test.ts`. |
| Diagnostics print key bytes or absolute paths. | The `hack doctor` env key check uses closed codes and project-relative subjects only: `src/lib/doctor-env-key.ts` (#309). Envelope and key-file failures use one fixed message: `src/lib/private-file.ts`, `src/lib/project-env-config.ts`, `src/lib/secret-store.ts` (#288). |
| Host command records keep arguments or env values. | `hack host exec` and `hack env exec` records are payload-free (see [host command lifetime](../env.md#host-command-lifetime-and-diagnostics)). |
| Tests leak the contributor's real `HOME`, keychain, Docker config or `HACK_*` variables into a spawned CLI. | `tests/helpers/private-cli-env.ts` (`privateCliEnv`) builds the whole child environment, and `tests/cli-spawn-env-isolation.test.ts` fails any source-CLI spawn that copies the runner environment (#319). |

### Symlinks, TOCTOU and file modes

| Threat | Mitigation on `next` |
| --- | --- |
| A repository's contract names a variable exported in the developer's shell, so the migration saves it to disk. | `migrateLegacyProjectEnv` refuses, naming the key only, when a `plain_env` value resolves from the process environment (HACK-1688). A value in a regular `.hack/.env` migrates to the gitignored machine-local layer, never a tracked one (HACK-1712). |
| A repository plants `.hack.secret.key` as a symlink (dangling or not) so that Hack reads or writes a file it should not. | Key reads go through `readBoundedPrivateFile` (`lstat`, `O_NOFOLLOW`, descriptor and path identity checks, 1 MiB bound, fatal UTF-8). New keys are created with `createPrivateFileExclusive` (`O_CREAT|O_EXCL|O_NOFOLLOW`, mode 0600, `fchmod`, `fsync`). Both are in `src/lib/private-file.ts`, used by `resolveProjectEnvKey`, `ensureProjectEnvSecretKey` and `resolveInheritedProjectEnvKey` in `src/lib/project-env-config.ts` (#288). |
| A symlinked `.hack/.env`, overlay file or `.hack` directory redirects a write, or a reader sees a partial file. | `src/lib/private-env-file.ts` (`readPrivateEnvFile`, `writePrivateEnvFileIfChanged`) and `replacePrivateFileAtomic` in `src/lib/private-file.ts`: a private staging file is written and fsynced, then renamed over the target; symlinks and non-regular entries are refused with one fixed message (#302). Used by mutation paths in `src/lib/hack-env.ts` and `materializeProjectEnv`. Dotenv reads in `src/lib/hack-env.ts` use the no-follow private-file reader (#762; gap 18). Staging copies of these files and of keys live in `.hack-staging/` next to the target, a private (0700) directory whose `.gitignore` of `*` keeps git from listing a copy a crash leaves. Writers never remove anything there, since a file configured at a staging-shaped path could be live; `hack doctor --fix` removes copies older than 10 minutes and never a path current resolution reads: configured stores and keys, the shared key and the project inputs legacy cleanup also keeps (`projectEnvLiveInputPaths`), each as given and resolved; the same holds for stale terminal-session payloads. Just before each unlink the configuration is resolved again and the target must be live in neither it nor the inspected one; if either cannot be resolved nothing is removed. The automatic pre-staging mux sweep (HACK-2170) makes the same decision through the same code (`removalAllowed` in `src/lib/live-inputs.ts`): before each removal it resolves the configuration from the current directory, keeps a payload whose `env.json` or directory is a path current resolution reads, lies in a retired store or cannot be resolved, and removes nothing when that configuration cannot be read; inside a native project, whose legacy project discovery refuses, it therefore removes nothing and `hack doctor --fix` remains the cleanup (`src/lib/private-staging.ts`, `src/lib/secrets-hygiene.ts`, `src/mux/private-environment.ts`, HACK-2165, HACK-2181). |
| A world-readable env file or store. | `.hack/.env`, overlays and the `encrypted_file` store are written 0600, and a same-content file with group or other access is tightened (#302). Machine-local layers are created 0600, and a write, even one that changes nothing, drops the group and other bits of an existing one; commands that read layers warn about a loose one (HACK-2165). The `hack doctor` env key check reports `env-key-weak-permissions` and `env-key-wrong-owner` (#309), and its "secrets hygiene" section reports loose, linked, tracked or unignored secret-bearing files, staging leftovers, stale terminal-session payloads and a store whose key is missing; `--fix` tightens modes, adds ignore entries and removes Hack's own leftovers, never a store, key or user file (`src/lib/secrets-hygiene.ts`, HACK-2165). |
| The Compose backend leaves decrypted values at rest in `.hack/.internal/compose.env.override.yml` after `up`, `down`, a failed `up` or an interrupted one. | The override holds only `${HACK_ENV_<digest>_<KEY>}` references; each value reaches `docker compose` through its process environment, so the generated override does not persist resolved values (command output can still contain them) (`renderComposeEnvReferenceOverride` in `src/lib/compose-managed-env.ts`). The file keeps its path because Compose records it in each container's `config_files` label. It is written with `replacePrivateFileAtomic` (mode 0600, symlink refused), and a literal value is refused before any write (`writeComposeEnvOverride` in `src/lib/compose-env-at-rest.ts`). A file left by an earlier version is replaced by the next Compose command that renders the override, removed by one that renders none and by `hack down` (before its hooks, remote target and Compose down, so none of them can skip it), and reported by the `hack doctor` "compose env at rest" check by counts only; `hack doctor --fix` removes it. Removal moves the file aside atomically and classifies what it moved, so a value-free file written concurrently is put back rather than deleted (the path is absent for that moment; see gap 4). An aside left by a crash between the move and the delete is reported by the doctor check by count and removed by a later removal, `hack doctor --fix` or a Compose command that renders the override, once it is more than a minute old. The doctor check, every removal and the aside sweep apply the writer's no-follow check to `.hack` and `.hack/.internal` first (and recheck them before each move or delete): a symlinked or non-directory `.hack` or `.hack/.internal`, or a symlinked or non-regular override, is a closed, value-free refusal, and nothing behind it is listed, read, moved or deleted (HACK-1316). Legacy adoption gives the reference values only to its Compose config-hash probe at preview and preparation; a saved recheck runs without values and binds each container's config-hash label to the hash proven at preparation. `hack config adopt` (with or without `--stop`) and its preview refuse a literal override before preparation, because an adoption pins the file's bytes and inode for its life. Recovery acts on an existing preparation, so the store refuses instead: publication (`--recover --stop`) and switch completion (`--recover`) refuse a generation bound to a literal override before any original moves, and name `hack config adopt --recover --rollback` (HACK-1318). Rollback stays allowed. While a prepared, active or pending adoption exists, no removal touches the file (removal would make the adoption unloadable); an adoption that an earlier version made over a literal file therefore keeps its values at rest until `hack config adopt --rollback`, and the doctor check names that next step (see gap 4). The `HACK_ENV_*` references, shared for global scope and distinct for service overrides, go only to `docker compose` invocations that read the override; the `docker inspect`, `logs` and `events` children for dependency cache progress and reuse get the environment without them (`withoutComposeEnvReferences`). Proven with a stub `docker` by `tests/compose-env-at-rest-cli.test.ts`, `tests/compose-env-at-rest.test.ts`, `tests/compose-env-reference-least-privilege.test.ts`, `tests/doctor-fix-noninteractive.test.ts`, `tests/native-compose-adoption-generation-managed.test.ts`, `tests/native-compose-adoption-generation-recovery.test.ts` and the sentinel scan `tests/env-secret-sentinel-scan.test.ts` (HACK-1273, HACK-1318). |
| Two writers of the `encrypted_file` store lose an update. | An in-process queue plus a cooperative `<store>.lock` using the owner protocol from `src/lib/projects-registry-lock.ts`; a symlinked store path is refused for writes (`src/lib/secret-store.ts`, #302). |
| Concurrent first users of the `encrypted_file` store each generate a key; the last key file wins and the store, already encrypted under another key, can no longer be decrypted. | The generated key is published with `publishPrivateFileExclusive` (`src/lib/private-file.ts`): a fsynced 0600 staging file (in `.hack-staging/` next to the key) is linked into place only when no key file exists, so losers adopt the published key. A store found non-empty after the first key read re-reads the key file before the keychain fallback. Proven across eight worker processes by `tests/secret-key-provisioning-convergence.test.ts`. The process-global cache and explicit provisioning are covered separately (gap 17, narrowed by #766). |
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
| The key is committed. | The root `.gitignore` gets a `.hack.secret.key` entry before the key is created, so a failed entry write leaves no key; an existing checkout-local key git does not ignore is repaired or refused before a `--secret` write uses it, and `hack doctor` reports it as `env-key-unignored` (HACK-1375). Encryption refuses a git-tracked key, including an inherited primary key, before it is copied (#288). `hack doctor` reports `env-key-tracked` at any depth (#309) and the "generated files" check can untrack a root key with `--fix`. |
| A key copy ships in build output or a static site. | `hack doctor` reports `env-key-public-path` for copies under `public/`, `static/`, `dist/`, `build/`, `out/`, `www/`, `_site/`, `.next/` and `.output/` (#309). |
| A weak, short or repetitive key. | `env-key-wrong-length` and `env-key-low-entropy` (#309). Generated keys are 32 random bytes in base64url. |
| Materialized `.hack/.env` or local overrides are committed. | Managed ignores cover `.env`, `.env.*` and local YAML names, with exceptions for templates. Existing tracked files remain tracked; Doctor reports shared legacy overlays and directs migration without automatically removing them from the index. Check actual tracking and permissions; ignore rules do not erase Git history or other copies (`src/templates.ts`, `src/lib/project-env-config.ts`; see audit item 15). |
| A secret leaks into a public artifact through a path nobody listed. | `tests/env-secret-sentinel-scan.test.ts` exercises encrypted-entry workflows with a recording Docker shim, a primary checkout and a worktree. Its fixture permits plaintext in a private `.hack/.env` and checks output, argv and Git artifacts. That is bounded evidence for those inputs, not a product-wide claim that plaintext exists only there. Plain local YAML, mux temporary payloads, application output and background stores need their own custody review. See open gap 12. |
| A dependency vulnerability ships in Hack. | `bun install --frozen-lockfile`, and the read-only `scripts/dependabot-inventory.ts` lists open alerts (#309). Hack does not sandbox project dependencies that run under `hack host exec`; they receive the injected env by design. |

### Agent and MCP exfiltration

| Threat | Mitigation on `next` |
| --- | --- |
| An agent puts a secret in a prompt, an argument or a log. | Canonical guidance in `src/agents/instruction-source.ts` directs stdin/hidden-prompt input, identifies plaintext value commands and secret-bearing logs/MCP/background reads, and keeps local YAML out of Git. Generated plugins and repository examples render that text. Guidance is not output filtering. |
| An MCP tool returns secret values. | `hack.project.env.keys` and `hack.project.env.explain` in `src/mcp/server.ts` return names and provenance only; `buildEnvKeysArgs` never emits `--show-secrets`, and child stdout and stderr are withheld. |
| A compromised dependency or agent reads the key file. | Out of reach for Hack inside the same user account (boundary 1). File modes and the symlink rules above only stop other users and redirected writes. |

## Open gaps

These gaps are open at the audit revision above. Each needs a merged fix; a
planned branch or a passing documentation check is not a mitigation.

1. **Crash-safe key rotation.** Rotation is manual: preserve the old key in private
   storage outside the worktree, then re-add each secret. Do not leave a
   `.hack.secret.key.old` copy in the worktree: that name is not ignored by the
   managed rules (`src/templates.ts`). Preserve a recoverable key/ciphertext
   generation before changing the active key. A crash or a partial run leaves
   files encrypted under two different keys,
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
   carries `HACK_ENV_*` references shared by services whose winning scope is global.
   Service-scoped overrides keep distinct references. The renderer uses scope metadata,
   with a separate reference if inconsistent input gives a service a different value
   (`src/lib/compose-managed-env.ts`). Global values also reach Compose under their own
   names for interpolation. These values are readable by the same user for the life of
   the process. Hack preflights the merged shell and managed environment, reserving
   space for arguments, before writing the override or launching Compose. An oversized
   environment is refused with `E_ENV_TOO_LARGE` and byte counts, not names or values
   (`src/lib/spawn-env-limit.ts`). See the maintained
   [Compose delivery and size contract](../env.md#runtime-behavior).
   Existing containers keep their values in `docker inspect`
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
   its journaled switch, it also keeps the file. Lifecycle logs (`.hack/.internal/lifecycle/*.log`) are
   the exception: they hold hook and lifecycle output verbatim and unredacted, so they are
   written private (directory 0700, files 0600, owner-checked, never through a symlink;
   an older broadly readable log is moved aside privately (`<log>.before-private-<time>`) and a
   new private log started before appending, so an
   already-open reader of the old file sees no new output) and persistent output passes through a
   0600 FIFO in a private `mktemp -d` directory. Staged terminal-multiplexer environments
   (`$TMPDIR/hack-mux-env-*/env.json`, 0600 in a 0700 directory) are refused after 10 minutes
   and removed by the next staging if no session ran them. Remaining gaps: a persistent
   session's shell appends with `>>`, so a same-user process that replaces the log during
   the session can redirect or recreate it (the next Hack record makes it private again), and
   ancestors of `.hack/.internal/` are not checked for other writers. Other generated files under
   `.hack/.internal/` and `.hack/.branch/` are written with the process umask; they are
   not value-free by definition, and the sentinel fixture does not prove otherwise (gap 16).
5. **YAML env layer TOCTOU (narrowed, HACK-1685).** Base and overlay YAML layers,
   including local layers and init scaffold writes, may follow links only when the whole chain resolves inside
   `realpath(projectRoot)`. Component-aware resolution handles relative targets,
   chains, symlinked roots and missing targets; segment-aware containment refuses
   sibling-prefix escapes. Outside targets, dangling outside links, loops and failed
   inspections produce closed, value-free errors. Mutation discovery and commands
   check before value stdin, and readers check before decryption or hydration output.
   `writeProjectEnvConfigFile` uses `writeTextFileAtomicIfChanged` in
   `src/lib/fs.ts`: allowed links keep their link and writes rename over their real
   target. The writer rechecks the original layer and captured destination before
   staging and commit, including after a concurrent link swap. These checks are
   path-based, not descriptor-relative `openat`/`renameat`: an ancestor directory
   swapped after the last check can still redirect an operation. This residual race
   remains open; ordinary outside-link redirection is refused. In-project dangling
   links are refused by `hack env set`, `hack env unset` and strict reads; `hack env add`
   replaces them.
6. **`encrypted_file` key file reads.** Key writes now use the
   `src/lib/private-file.ts` helpers: explicit provisioning replaces the key
   atomically, and first-use generation publishes it exclusively. `readEncryptedFileKey`
   in `src/lib/secret-store.ts` still reads with `readTextFile`, which follows a
   symlink at the key path.
7. **Directory TOCTOU.** The #302 directory checks are path-based `lstat` with
   identity rechecks, not `openat`/`renameat`. A swap of `.hack` between the recheck
   and `rename(2)` is not fully closed. The store lock is cooperative, and v4 writers
   do not honor it.
8. **MCP command output and logs.** `hack.project.run`, `hack.project.exec` and the log tools
   return child output. A command such as `printenv`, or an app that logs its env,
   puts injected values into the agent context. `hack logs`, background-command
   reads and `hack secrets get` can disclose values too. The env keys/explain
   tools' withholding rule does not apply to arbitrary command output. Client
   approvals and guidance are not a general redaction boundary.
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

13. **Mitigated: project keys inherited by child processes (HACK-2163).**
    Shared child-environment filtering removes Hack key material, including
    `HACK_ENV_SECRET_KEY` and `HACK_SECRETS_FILE_KEY`, from ordinary children and
    the Compose client. Deliberate Hack re-execs retain keys and filter their own
    user children. Already-running multiplexer servers can retain their earlier
    environment; filtering a new child does not erase previously copied keys.
14. **Mitigated: parser diagnostics reflecting values (HACK-2163).** Env-layer,
    legacy contract and secret-store diagnostics use fixed error kinds and numeric
    locations rather than raw parser messages. CLI, JSON and daemon regressions
    check sentinel omission. Do not extend that contract to arbitrary application
    output or unrelated parsers.
15. **Mitigated: legacy dotenv copies offered for commit (HACK-2163).** Managed
    rules ignore `.env.*` with template exceptions. Doctor reports tracked or
    unignored overlays and directs migration; it does not automatically untrack
    shared overlays or templates. Ignore rules cannot remove already-tracked
    plaintext from Git history or another copy.
16. **Narrowed: lifecycle log and FIFO custody (HACK-2170).** Hooks and persistent
    processes copy unredacted output to `.hack/.internal/lifecycle/<project>.log`.
    The directory is now 0700 and the log 0600, owner-checked and never written by
    Hack through a symlink; an older broadly readable log is moved aside privately
    and a new log started; a log that cannot be written changes only persistence.
    Persistent output crosses a 0600 FIFO in a `mktemp -d` directory, and the
    process is not started if either cannot be created. Remaining: a persistent
    session's shell appends with `>>`, so a same-user replacement during the
    session is followed until Hack's next record; ancestors of `.hack/.internal/`
    are not checked for other writers; staged multiplexer payloads are removed by
    the next staging or `hack doctor --fix` (which also reports them), not by an
    independent reaper.
17. **Narrowed: secret-store and key integrity (HACK-2169, #766).** Unreadable or
    malformed stores refuse mutation instead of becoming an empty store. Configured
    file-key lookup does not borrow a cached key from another path; provisioning
    refuses to replace a different existing key. An environment-only project key
    is retained without creating a shadowing file key. Shared key-writer locks
    serialize provisioning and cleanup. These are preservation checks, not a
    rotation or recovery mechanism for keys already lost.
18. **Narrowed: local-layer symlinks, Git privacy and modes (HACK-2165, #762,
    #764).** Machine-local writes refuse linked or tracked destinations, unknown
    tracking inside a checkout and ineffective ignore rules. Legacy dotenv
    inspection uses no-follow reads. Machine-local layers are created 0600, an
    existing loose one is tightened by the next write or `hack doctor --fix`, and
    commands that read layers warn about a loose one (#764). Local naming and
    ignores still do not prove private historical permissions or erase earlier
    copies; only permission bits are checked (macOS extended ACLs are not), so
    inspect Doctor's findings and retain the remaining filesystem-race limits
    described above. Git is found the way git finds it: a `.git` entry at or
    above the path, or `GIT_DIR` in Hack's environment (both fail closed when git
    cannot answer). A work tree used only through `--git-dir`/`--work-tree`
    flags or an alias (a bare dotfiles repository, say) leaves neither, so Hack,
    like plain `git`, cannot see it and neither refuses a write there nor reports
    one; keep stores and keys out of such a tree, or ignore them in it.
19. **Mitigated: stale migration cleanup decisions (HACK-2171).** Cleanup carries
    content and file-identity receipts from before migration, then rechecks them
    and current scoped delivery under writer locks after consent. Each unlink
    rechecks its target. Refusals preserve remaining files and report confirmed
    removals; automatic cleanup warns and continues the original command. Writers
    outside Hack's cooperative locks can still race the final unlink. The daemon
    also reports unconfirmed secret deletion as HTTP 500 `partial_failure`,
    retaining the completed dotenv result instead of claiming success.

### Plaintext on disk outside materialization

Local YAML can hold plain values, including values migrated from a v4 dotenv
file. `writeProjectEnvConfigFile` creates new local layers mode 0600 and drops the
group and other bits of an existing one on every write, even one that changes
nothing (`src/lib/project-env-config.ts`); `hack doctor --fix` does the same for
layers no write has touched since. Until then an older layer keeps the mode it
was created with, and commands that read it warn. A local filename is not proof
of encryption.

`stageMuxEnvironment` writes resolved values to `$TMPDIR/hack-mux-env-*/env.json`
with mode 0600; the pane wrapper consumes and removes that payload
(`src/mux/private-environment.ts`). During its lifetime, the same user and a
backup or temp-file collector can read it. A payload older than 10 minutes is
refused by the wrapper, and each new staging sweeps this user's stale private
payloads (an ownership-aware check, not a blanket temp-directory deletion),
keeping a payload whose `env.json` or directory is a path current
configuration reads; if the configuration cannot be read that sweep removes
nothing (HACK-2181). A payload left by a crash stays until
the next staging; there is no independent reaper, but `hack doctor` reports it
and `hack doctor --fix` removes it (HACK-2165).

Background output reaches `<HACK_HOME>/commands/<id>/stdout` and `stderr` before
the supervisor scans it (`src/lib/background-command/journal.ts`,
`src/lib/background-command/supervisor.ts`). Values below six UTF-8 bytes are
never redacted. If the supervisor dies, unscanned bytes can remain plaintext for
the whole retention period or longer until a sweep; reads withholding those
bytes do not delete them. Native background output has no redaction. See
[background output custody](../guides/background-commands.md#stored-output-retention-and-redaction).

Background metadata is not an env-value-free store: `meta.json` and `launch.json`
retain caller argv, and `commands show` returns it, even with `--capture metadata`
(`src/lib/background-command/launch.ts`, `src/lib/background-command/store.ts`,
`src/lib/background-command/reader.ts`). Output redaction does not sanitize argv.
Foreground MCP command audit records also retain formatted command arguments
(`src/mcp/server.ts`). Keep sensitive values out of arguments; managed env
injection does not require putting them there.

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
