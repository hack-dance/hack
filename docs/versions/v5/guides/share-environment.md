# Share environment and secrets

Read [Environment and secrets](../../env.md) before choosing a backend. Commit
shareable configuration; keep decryption keys and local overrides separate.

```sh
HACK_RUNTIME_BACKEND=compose "$HOME/.hack-next/bin/hack-next" env list
HACK_RUNTIME_BACKEND=compose "$HOME/.hack-next/bin/hack-next" env explain API_URL --service web --target compose
```

Inspect masked values and provenance rather than printing credentials. Scope
values to the intended service/overlay. A linked worktree can inherit the primary
checkout's key; a separate host needs its own approved runtime delivery mechanism.

For encrypted-file storage, possession of the project key grants decryption of
values encrypted with it. Keep an approved backup separate from the repository.
Git access and secret access are different grants. Removing someone's repository
access does not erase keys or values already copied to their machine. Follow the
implemented backend's rotation/revocation procedure; do not assume a universal
`hack` revocation or secret-manager synchronization command exists.

## External secret managers

Use the provider's approved authentication flow and the backend contract in the
matching reference. An illustrative integration reads a single required value
through the provider CLI and sends it directly into a supported hidden/standard-
input path; do not put it in shell arguments, chat, logs or cached files. Exact
write commands and provider support differ by version, so no generic sync command
is implied here. Verify masked metadata, then the app's actual service access.
