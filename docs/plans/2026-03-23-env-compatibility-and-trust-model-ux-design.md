# Env Compatibility And Trust-Model UX Design

## Context

Portable env management needs a clearer story without breaking the existing `.env`-style local
workflow that Hack users already rely on.

## Compatibility plan

1. Preserve `.hack/.env` as the plaintext compatibility target for non-secret values.
2. Preserve the configured secret backend as the local compatibility target for secret values.
3. Keep `.hack/hack.env.json` as committed metadata only, never as a value store.
4. Treat future portable env artifacts as a canonical layer that materializes back into the same
   local compatibility targets instead of bypassing them.
5. Make backend and trust-model state explicit in `hack env list` and `hack env backend status`
   so users can tell whether they are in local-only, encrypted-local, or provider-shim mode.

## UX language

- **Plaintext**: value stored in `.hack/.env` for local compatibility. This is readable on the local
  machine and should remain gitignored by convention.
- **Encrypted**: value stored through the configured secret backend, such as the OS keychain or an
  encrypted local file.
- **Cloud backend**: provider-targeted backend intent with local encrypted custody today. It is not
  automatic remote publication of project env values yet.
- **Portable state**: whether project env values are configured for cross-machine encrypted bundle
  workflows. Current default remains local-only.

## CLI status expectations

`hack env list` should surface:

- committed contract path and its no-values guarantee
- plaintext compatibility file status
- ambient `process.env` fallback status
- active secret backend plus whether it is native or shimmed
- compatibility materialization rule: plaintext -> `.hack/.env`, secrets -> configured backend
- portable state and trust-model message

`hack env backend status` should surface:

- active backend
- storage mode
- trust model
- portability implication
- reminder that non-secret values remain `.env`-compatible via `.hack/.env`

## Non-goals

- Do not make portable env the default.
- Do not imply remote storage or sharing from backend names alone.
- Do not collapse secret values into `.hack/.env` for convenience.
