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
| The Compose backend leaves decrypted values at rest in `.hack/.internal/compose.env.override.yml` after `up`, `down`, a failed `up` or an interrupted one. | The override holds only `${HACK_ENV_<digest>_<KEY>}` references; each value reaches `docker compose` through its process environment, so no Compose command writes a value to disk, whatever way it ends (`renderComposeEnvReferenceOverride` in `src/lib/compose-managed-env.ts`). The file keeps its path because Compose records it in each container's `config_files` label. It is written with `replacePrivateFileAtomic` (mode 0600, symlink refused), and a literal value is refused before any write (`writeComposeEnvOverride` in `src/lib/compose-env-at-rest.ts`). A file left by an earlier version is replaced by the next Compose command that renders the override, removed by one that renders none and by `hack down` (first, so a failed hook or a remote target cannot skip it), and reported by the `hack doctor` "compose env at rest" check by counts only; `hack doctor --fix` removes it. Removal moves the file aside atomically and classifies what it moved, so a value-free file written concurrently is put back rather than deleted. Legacy adoption gives the reference values only to its Compose config-hash probe at preview and preparation; a saved recheck runs without values and binds each container's config-hash label to the hash proven at preparation. Proven with a stub `docker` by `tests/compose-env-at-rest-cli.test.ts`, `tests/compose-env-at-rest.test.ts`, `tests/doctor-fix-noninteractive.test.ts` and `tests/native-compose-adoption-generation.test.ts` (HACK-1273). |
| Two writers of the `encrypted_file` store lose an update. | An in-process queue plus a cooperative `<store>.lock` using the owner protocol from `src/lib/projects-registry-lock.ts`; a symlinked store path is refused for writes (`src/lib/secret-store.ts`, #302). |

### Malformed or hostile ciphertext

| Threat | Mitigation on `next` |
| --- | --- |
| Truncated tags, oversized ciphertext or non-canonical base64 cause a wrong decision or a crash. | `decryptProjectEnvValue` (`src/lib/project-env-config.ts`) and `parseEncryptedEnvelope`/`decryptStore` (`src/lib/secret-store.ts`) require canonical base64 (`decodeCanonicalBase64` in `src/lib/private-file.ts`), a 12-byte IV and a 16-byte tag, pin `authTagLength: 16`, bound the size before decoding, and fail with one fixed error (#288). |
| Ciphertext is moved to another variable, scope or file and still decrypts. | Not prevented. The current v1 format authenticates no associated data. `tests/aes-gcm-v1-context-binding.test.ts` pins this behavior so that any change is deliberate (#302). See [open gaps](#open-gaps). |

### Public-artifact and git leakage

| Threat | Mitigation on `next` |
| --- | --- |
| The key is committed. | The root `.gitignore` gets a `.hack.secret.key` entry when the key is created. Encryption refuses a git-tracked key, including an inherited primary key, before it is copied (#288). `hack doctor` reports `env-key-tracked` at any depth (#309) and the "generated files" check can untrack a root key with `--fix`. |
| A key copy ships in build output or a static site. | `hack doctor` reports `env-key-public-path` for copies under `public/`, `static/`, `dist/`, `build/`, `out/`, `www/`, `_site/`, `.next/` and `.output/` (#309). |
| A weak, short or repetitive key. | `env-key-wrong-length` and `env-key-low-entropy` (#309). Generated keys are 32 random bytes in base64url. |
| Materialized `.hack/.env` or local overrides are committed. | Hack owns a committed `.hack/.gitignore` block, and `hack doctor` flags tracked generated files (see [ignore rules](../env.md#ignore-rules-committed-hackgitignore)). |
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
2. **Crypto decision record pending independent review.** The KDF (a single SHA-256
   of the key text), the missing AAD binding, and the v1 envelope format are
   characterized in tests but have no written decision record. #288 was flagged for an
   independent crypto review (WU14) that has not happened yet. Any format change must
   keep v1 values readable.
3. **Live keychain and 1Password custody receipts.** No test or receipt proves, on a
   real macOS host, that values stored through the `keychain` backend or piped from
   1Password stay only in the expected custody: the keychain item, the encrypted YAML
   or store, and the target process environment. The CLI tests disable the keychain
   fallback (`HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK=1`) and never call 1Password.
4. **Compose client environment.** The Compose override no longer holds values
   (HACK-1273), but the `docker compose` client process now carries one
   `HACK_ENV_*` variable per service and key. Like every injected env, it is
   readable by the same user (for example `ps eww`) for the life of that process.
   Each service gets its own copy of each value, so the size grows with services
   times keys. A project whose resolved values exceed the platform's argument and
   environment limit (about 1 MiB in total on macOS; on Linux also 128 KiB for one
   `NAME=value` string) cannot start through Compose. Existing containers keep their
   values in `docker inspect` (gap 9). A direct `docker compose -f` run of the
   override outside Hack gets blank values. Legacy adoption resolves the values at
   preview and preparation and checks each container's config-hash label against
   Compose's hash computed with them; a saved recheck, which has no key or values,
   compares the label with the hash saved at preparation while the Compose copy, the
   generated override bytes and the managed env revision stay pinned.
5. **YAML env file writes.** `writeProjectEnvConfigFile` in
   `src/lib/project-env-config.ts` also uses `writeTextFileIfChanged`, so
   `.hack/hack.env.*.yaml` writes follow a symlink at the file. These files hold
   ciphertext and non-secret plaintext, but a hostile repository could redirect the
   write.
6. **`encrypted_file` key file hygiene.** `readEncryptedFileKey` and
   `writeEncryptedFileKey` in `src/lib/secret-store.ts` read with `readTextFile` and
   write with `writeFile` plus `chmod`. They do not use the `src/lib/private-file.ts`
   helpers, so they follow symlinks and do not create the key exclusively.
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

## Related

- [Env & secrets](../env.md)
- [CLI reference](../cli.md)
