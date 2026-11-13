# Versioned documentation

The site defaults to `/docs/v5`; `/docs/v4` is a separate corpus. The sidebar's
version selector switches corpus, and search is scoped to the selected version.
Unknown versions return 404 (search: 400). Old unversioned document URLs redirect
to their v5 equivalents. Root `/llms.txt` and `/llms-full.txt` select v5;
`/v4/llms*.txt` and `/v5/llms*.txt` are explicit.

## Provenance

`scripts/docs/versions.json` pins each version. Every published snapshot carries
its SHA-256 and a footer linking the original file at the pinned revision. GitHub
links use the pinned SHA. The public-file inventory in the manifest lets link
validation run without fetching historical Git objects.

Links to tracked files use pinned GitHub `blob` URLs; directory links use `tree`
URLs only when the inventory contains a file below that exact directory. Unknown
paths and partial directory-name prefixes are rejected. Editorial links to a site
slug keep resolving when a release snapshot replaces the editorial page.

Snapshots are taken before their release tag exists, so installation examples can
name the previous prerelease. Staging aligns the bootstrap, manager and checksum
artifact URLs and the `V=5.0.0-next.N` shell variable with the corpus pin. The
original snapshot bytes and hashes remain unchanged. Both `docs:check` and the
HTTP smoke reject installer artifact URLs for any other release tag.

The next.15 pin includes proxy-network repair in Architecture and native preflight
in the command and native references. Two versioned editorial entry pages expose
those features in navigation: Proxy network repair and Native preflight. Both
name their next.15 source explicitly. The eleven recipes and four native overview
pages have release snapshots; five recipes retain explicitly attributed link
corrections. The runtime examples already contain their mount and token-scope
fixes at this tag. Linux DNS, Linux certificate trust and daemon guides remain
outside this corpus because this tag does not contain them.

Editorial pages state their own provenance: the pinned revision by default, or an
explicit `sourceRevision` and `sourceLabel` when a page was written against a
different source, as the next.5 field audits were.

## Checks

`docs:check` validates snapshot hashes, path containment, same-version links and
exports, entry points, the v5 Compose-default framing, the retired-automation
guard and the install page's pinned release tag. `docs:typecheck` and `docs:build`
validate site integration. `docs:smoke` exercises a running build over HTTP.
