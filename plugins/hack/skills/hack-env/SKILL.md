---
name: hack-env
description: >
  Inspect and change Hack-managed env values, overlays and worktree-local overrides without
  exposing secret values. Trigger when asked to explain where an env value comes from; list, get
  or set an env value; select or compare env overlays; write a worktree-local env override; run a
  host command with managed env; or refresh a service after an env change.
---

# Hack env

## Env composition

- Layer order: `.hack/hack.env.default.yaml`, the selected `.hack/hack.env.<overlay>.yaml`, then worktree-local `.hack/hack.env.local.yaml` and `.hack/hack.env.<overlay>.local.yaml`; service values override `global`, and host commands apply `host` values last.
- `hack.env*.local.yaml` files are local-only, can contain plaintext and must not be committed. Check existing file permissions and Git tracking; ignore rules do not untrack a file already in Git.
- `hack env list` masks only entries stored as secrets (for example with `--secret`); plaintext values, including values migrated from a v4 `.hack/.env`, are shown. Prefer variable names and `hack env explain` when checking configuration without exposing values.
- Omit `--env` to use the configured default overlay; `--env base` (or `default`/`none`) selects base layers only, the same on every command. An overlay name grants no production authority and no network or instance isolation.
- Use `hack env explain <KEY> --env <overlay> --service <service>` for provenance without the value; `hack env get <KEY>` and `hack secrets get <name>` print plaintext. Use them only when the value itself is explicitly needed, and treat their output as secret.
- Store a secret by piping it: `<secret-source> | hack env add <KEY> --service <service> --secret --value-stdin` (or the hidden prompt in a terminal); never pass secret values as command arguments, where shell history and process listings expose them.
- Running containers keep the env they were created with; after an env change, refresh with `hack env apply --service <service>` or `hack restart`.
- Accepted flags, injection timing and refresh path per command: the command and delivery matrix in Hack's env guide (`docs/env.md` in the Hack repository).

## Env commands

- `hack env list --env <overlay> --service <service>` shows resolved values, masking only entries stored with `--secret`; plain values migrated from v4 are shown. `--json` changes the format, not the disclosure.
- `hack env set <key> <value> --local` writes a non-secret value to the worktree-local override file for the selected overlay; drop `--local` only when the request covers the shared, committed overlay.
- `hack env exec --env <overlay> --service <service> -- <cmd...>` runs one host command with the resolved env injected; use `hack env exec --env <overlay> --shell '<command>'` when `$VAR` must expand inside the child shell, and add `--timeout <seconds>` to bound a non-TTY job.
- `hack env apply --env <overlay> --service <service>` recreates that one service so it picks up changed values.

## Env safety

- A secret value never goes in command arguments or agent prompts. Store one with `hack env set <key> --secret` and no value, which the user runs in their own terminal and answers at its hidden prompt.
- `hack env get`, `hack secrets get` and `hack env list --show-secrets` print plaintext: run them only when the user asks for the value itself, never to check that a key exists, and do not repeat their output in replies, logs or files.
