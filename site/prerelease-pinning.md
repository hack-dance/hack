# Keep the site pin current

The site serves immutable release snapshots. A new prerelease can be published
while the manifest still names the previous one, even when every current site
build passes. Installer rewriting makes each page match the manifest; it cannot
decide whether the manifest is still the latest published release.

## Read-only freshness check

Fetch the release tags, then pipe GitHub's published release metadata to the
checker with the Bun version pinned in `package.json`:

```sh
(
  set -euo pipefail
  git fetch origin --tags
  gh api --paginate --slurp repos/hack-dance/hack/releases \
    | bun scripts/docs/check-prerelease-pin.ts
)
```

The checker selects the highest numeric `v5.0.0-next.N` that is published,
non-draft and marked prerelease. It checks both the manifest label and the
resolved tag commit. Missing metadata, an unresolved tag, a stale or future pin,
or a mismatched commit fails. It writes no file and makes no API request itself.
The checker currently accepts prerelease pins only; a stable `v5.0.0` label fails
closed until the checker is extended for the stable channel.

When it fails for a stale pin, use the existing `docs:pin` command, update the
install page and live installer examples, review the explicit page allowlist and
editorial compatibility, and run the docs gates before one re-pin PR against
`next`. Never move a published tag or edit immutable snapshot bytes.

## Proposed workflow integration

The workflow integration is a proposal; this PR changes no workflow file.
The PR body gives the workflow owner the exact integration plan.

GitHub runs scheduled workflows from the repository's default branch, `main`.
The workflow file must land on `main`; a file merged only to `next` will not run
on a schedule. Its checkout must select `ref: next` with `fetch-depth: 0` and
release tags. The checker script lives on `next` and runs from that checkout.

Vercel production builds the site from `next` during the v5 prerelease, as
documented in [the deployment settings](README.md#deploy). The job therefore
checks the manifest on the branch that serves the site. When production moves
to `main` after 5.0.0, update the checkout and stable-channel policy together.

Run this inexpensive Linux check every six hours and through manual dispatch.
It needs repository read access only. Keep it separate from pull-request/runtime
CI and macOS jobs. A failure signals documentation lag; it does not undo a
release or deploy the site.

The schedule works independently of release-event delivery, including releases
created by `GITHUB_TOKEN`. A later successful check clears the signal after a
reviewed re-pin PR merges. Keep the existing snapshot hashes, installer guards,
curated navigation and human review. The workflow owner can add an immediate
post-publish check later; automatic re-pin PR creation can also be added without
bypassing those gates.
