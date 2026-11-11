# Pending v5 next.14 re-pin

This draft prepares an explicit allowlist for `v5.0.0-next.14`. The tag does not
exist yet. The active release revision, label and install commands still name
next.13. New manifest entries have empty hashes and absent `originals/next14/`
snapshots on purpose: the existing snapshot checks block a build until the real
tag supplies every source. Do not merge this draft or substitute a branch tip
for the release tag.

## Pages selected

The comparison is `git diff --stat v5.0.0-next.13..origin/next -- docs/`.
The same curation as the previous re-pin applies: publish supported user-facing
guides explicitly, retain existing routes, preserve originals and their hashes,
and review editorial overrides separately.

| Source | Site route | Status before the tag |
| --- | --- | --- |
| `docs/native/README.md` | `native/overview` | Existing editorial route; add release original |
| `docs/native/try-it.md` | `native/try-it` | Existing editorial route; add release original |
| `docs/native/limits.md` | `native/limits` | Existing editorial route; add release original |
| `docs/native/reference.md` | `native/reference` | Existing editorial route; add release original |
| `docs/recipes/README.md` | `recipes/overview` | Existing editorial route; add release original |
| `docs/recipes/cli-sign-in.md` | `recipes/cli-sign-in` | Existing editorial route; add release original |
| `docs/recipes/tunnels.md` | `recipes/tunnels` | Existing editorial route; add release original |
| `docs/recipes/remote-database.md` | `recipes/remote-database` | Existing editorial route; add release original |
| `docs/recipes/migrations.md` | `recipes/migrations` | Existing editorial route; add release original |
| `docs/recipes/environments.md` | `recipes/environments` | Existing editorial route; add release original |
| `docs/recipes/deps-service.md` | `recipes/deps-service` | Existing editorial route; add release original |
| `docs/recipes/dependency-directories.md` | `recipes/dependency-directories` | Existing editorial route; add release original |
| `docs/recipes/cleanup.md` | `recipes/cleanup` | Existing editorial route; add release original |
| `docs/recipes/config-examples.md` | `recipes/config-examples` | Existing editorial route; add release original |
| `docs/recipes/common-pitfalls.md` | `recipes/common-pitfalls` | Existing editorial route; add release original |
| `docs/guides/linux-setup.md` | `guides/linux-setup` | Awaiting upstream merge and release tag |
| `docs/guides/linux-certificate-trust.md` | `guides/linux-certificate-trust` | Awaiting upstream merge and release tag |

The new Linux pages appear in Guides through the manifest, and are linked from
Install and the docs index. Recipes and native pages retain their section order.
Standalone diagrams about implementation qualification or CI are not new user
guides. Versioned editorial copies and generated originals are not counted again
as canonical additions. Already-published pages are refreshed by the pin script.

## Finish only after the tag exists

1. Fetch tags and `origin/next`. Merge `origin/next` normally if it has moved;
   preserve any overlapping changes. Confirm both Linux sources are in the tag.
   Repeat the docs comparison through the tag and curate any further additions
   or renames explicitly. Never replace the manifest with a glob.
2. Run the existing script:

   ```sh
   bun run docs:pin -- --version v5 --ref v5.0.0-next.14 --label "v5 (next.14)" --dir next14
   ```

3. Update `docs/versions/v5/install.md` to the next.14 bootstrap tag. Review all
   editorial pages against the tagged release, especially Native → Try it,
   limits, upgrade and environment guidance. Remove editorial forks where the
   tagged source now supplies the same content, as in the next.13 re-pin.
   Keep deliberate editorial framing and explicit source provenance where needed.
4. Run `docs:check`, `docs:typecheck`, `docs:build`, loopback `docs:smoke`,
   Gitleaks, root `typecheck`, `check` and `privacy:check` with the pinned Bun.
   Count daemon processes before and after; stop the owned HTTP server.
   Full tests remain a hosted CI gate on a host without a C toolchain.
5. Obtain a clean review of the final head, handle bot threads, require hosted
   `docs site` and `test`, then mark the PR ready. Merge and production deployment
   remain separate actions.
