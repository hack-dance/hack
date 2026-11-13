# Troubleshooting

Run `hack doctor` using the **same CLI, backend and home** as the command that
failed. On the Compose path, use the terminal from [Install](install.md). On
native, use the full `hack-next` path from [Try native](native/start.md).
Read the named finding before using `--fix`; some problems need a decision or
an original key, not an automatic repair.

The rows marked **next.17 source** describe merged code intended for next.17.
They do not change an installed next.16 bundle. See the
[release notes](../guides/v5-release-notes.md) for version boundaries.

| Finding or message | Cause | What to do |
| --- | --- | --- |
| `proxy ports`: “port 443 on loopback is not reaching the Hack proxy” (**next.17 source**, #773) | A hostname resolves to loopback, but its published port does not reach Hack's proxy. Another listener, a VPN's serve feature or the container runtime's HTTPS setting may own the port. | Review visible listeners, `proxy.bind_address` and local DNS overrides. Change the conflicting setting deliberately, then rerun Doctor. Port 80 working does not prove 443 works. Doctor applies no automatic fix. [Routing details](guides/proxy-network-repair.md). |
| `secret integrity`: encrypted store has entries, but its key is missing or does not open it (**next.17 source**, #779) | An old global store remains, but the original key is unavailable. It is an error where the project reads it and a warning elsewhere. | Choose **restore the original key** or **retire the store** if the key is gone for good. Never create a replacement key to open old ciphertext. Retirement keeps the encrypted file and prints how to put it back. See the steps below. |
| `secret integrity`: env layer “could not be read or parsed” (**next.17 source**, #766) | The layer is unreadable, invalid, or outside an allowed path. | Fix its access, syntax or location, then rerun Doctor. Keep the file and original key. If encrypted entries cannot be opened, recover that key; a hidden value in `env list` is not proof of decryption. [Env and keys](../env.md#secret-key-handling). |
| `env-key-weak-permissions` | An old project key has group or other access. | Keep a private backup, then apply the reported `chmod 600` remedy to the named key. Do not move it to an unignored `.old` file in the checkout. The broader hygiene report (#764) is a separate change; check the installed release. |
| Native runtime/provider files are missing or setup is incomplete | The candidate is installed, but its per-version runtime is not prepared. | Run the explicit [native setup step](native/start.md#prepare-the-runtime) for that selected version and home. `up` does not download provider files. For `setup_existing_invalid`, keep existing state and follow [setup recovery](native/setup.md); do not delete the home. |
| Preflight has blockers or reports `runtime review: skipped` / `unavailable` | The Compose project uses an unsupported field, the wrong backend is selected, or the CLI/runtime pair cannot complete review. | Use the native launcher, fix the reported fields and rerun `doctor --native-preflight`. Check `ready` and the runtime review, not just the exit code. Stay on Compose when the feature is required. [Preflight details](native/preflight.md). |
| `E_LIFECYCLE_FAILED` | A project hook failed before startup could finish; its own credentials or command may need repair. | Read the hook's message, fix that project dependency, then retry. Do not bypass the hook just to get a green start. |
| next.16 `E_STARTUP_INCOMPLETE` after a fast one-shot service finished | next.16 can misread a service that exits successfully in under a second. | Inspect `ps` and logs. If this is that known case and the services are up, rerun `up --detach`. The fix is merged for a later prerelease. [Trial record](guides/upgrade-from-v4.md#known-problems-and-the-dogfood-record). |

## A store whose key is lost

Use a candidate containing #779; next.16 does not have `retire-store`. Doctor's
finding names the selected store and registered projects that read it.

1. Prefer restoring the **same original key** from a private backup or another
   machine, at the path Doctor names with mode 600.
2. If the key is gone for good, select the diagnosed project and retire the store:

   ```sh
   hack secrets retire-store --path /absolute/project --allow-unchecked
   ```

   On the Compose path, `hack` must be the Compose-selected v5 CLI, as on page 1.
   Pass `--allow-unchecked` only after confirming no shell for a project selecting
   the store holds its key in `HACK_SECRETS_FILE_KEY`; Hack cannot inspect another
   shell. The flag also acknowledges registered projects it could not check.
   A store a configured key still opens is refused. Without a terminal, `--yes`
   is also needed to confirm the move.

Retirement moves the file to a timestamped directory beside it. It deletes no
entries, leaves the key file alone and prints the restore command. It does not
recover the values. Keep the moved file if you might recover the key later.
[Store details](https://github.com/hack-dance/hack/blob/91c311e4d9540ea3ca32113a61458a26db90c704/docs/env.md#compatibility-notes)
cover the refusal and recovery rules.

If a report needs help, share the version, finding name and the action that failed.
Remove secret values and private paths from logs before sharing them.
