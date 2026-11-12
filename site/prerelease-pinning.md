# Keep the site pin current

The site serves immutable release snapshots. A new prerelease can be published
while the manifest still names the previous one, even when every current site
build passes. Installer rewriting makes each page match the manifest; it cannot
decide whether the manifest is still the latest published release.

## Read-only freshness check

Fetch the release tags, then pipe GitHub's published release metadata to the
checker with the Bun version pinned in `package.json`:

```sh
set -euo pipefail
git fetch origin --tags
gh api --paginate --slurp repos/hack-dance/hack/releases \
  | bun scripts/docs/check-prerelease-pin.ts
```

The checker selects the highest numeric `v5.0.0-next.N` that is published,
non-draft and marked prerelease. It checks both the manifest label and the
resolved tag commit. Missing metadata, an unresolved tag, a stale or future pin,
or a mismatched commit fails. It writes no file and makes no API request itself.

When it fails for a stale pin, use the existing `docs:pin` command, update the
install page and live installer examples, review the explicit page allowlist and
editorial compatibility, and run the docs gates before one re-pin PR against
`next`. Never move a published tag or edit immutable snapshot bytes.

## Proposed workflow integration

The workflow integration is a proposal; this PR changes no workflow file.
The PR body gives the workflow owner the exact integration plan.

Run this inexpensive Linux check every six hours and through manual dispatch,
using fresh `next` and release tags. It needs repository read access only. Keep it
separate from pull-request/runtime CI and macOS jobs. A failure signals
documentation lag; it does not undo a release or deploy the site.

The schedule works independently of release-event delivery, including releases
created by `GITHUB_TOKEN`. A later successful check clears the signal after a
reviewed re-pin PR merges. Keep the existing snapshot hashes, installer guards,
curated navigation and human review. The workflow owner can add an immediate
post-publish check later; automatic re-pin PR creation can also be added without
bypassing those gates.
