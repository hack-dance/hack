# Versioned documentation and curation

The site defaults to `/docs/v5`; `/docs/v4` is a separate corpus. The navigation
selector changes the source corpus, and search requires a selected version.
Unknown versions return 404 (search: 400). Existing unversioned document URLs
redirect to their v5 equivalents; the old native-runtime-use URL redirects to
Getting started. Root LLM exports select v5; `/v4/llms*.txt` and `/v5/llms*.txt`
provide explicit agent handoff.

## Source provenance

`scripts/docs/versions.json` pins v4.2.4 to
`91b14bf0abb17602142425de0d02628a3e8a2615` and v5 next.6 to
`44aaf5156426dfcbb1c8a189b8e20531e5b95613`. These are published source snapshots,
not a claim that every newer development capability ships in those releases.
Original Markdown is preserved under `docs/versions/<version>/originals`, with
SHA-256 hashes. A public-file inventory makes link validation reproducible without
fetching historical git objects during a build. GitHub links use the pinned SHA.

Editorial pages under each version are explicit adaptations. Install and Getting
started lead, followed by concepts, task guides, agent handoff and reference. The
whole-project framing is retained from the README editorial sources documented in
`content-decisions.md`. Historic account/remote designs are excluded. Global
settings and contributor guidance are not promoted as core learning paths.
Published original files are staged only from the version manifest; the preserved
originals directory is never recursively published.

## Verification limits and follow-up coverage

Corpus checks validate snapshot hashes, safe paths, same-version links/exports,
entry points and default selection. Typecheck and webpack build validate site
integration. HTTP smoke separately covers all versioned routes, canonicals,
search isolation, exports, redirects and unknown-version behavior. Browser checks
cover visible selection, keyboard/mobile use and direct/reloaded links.

Examples are source-reviewed for their selected version and backend; they are not
claims that cloud applications were executed. Cloud/provider compatibility is
based on official documentation reviewed October 30, 2026. Cursor and boat.dev
remain conditional; Google requires an exact product choice; code.computer was
unavailable to research requests. ECS app hosting is distinct from a development
host. No cloud resources, credentials or provider settings were changed.

The generated command reference is refreshed from next.6. Detailed next.5 field audits are retained with historical provenance; their counts do not qualify next.6 coverage. See `reference-coverage.md` for those historical inventories and open limits.

The published generated CLI reference is curated to the declared public slice: unsupported/retired roots and Internal/Fun/Extensions/Beta groups are omitted, while the hashed historical originals remain intact. The public supplement completes that slice; publication checks reject excluded headings and retain logs/env/branch sections and version-specific setup boundaries.

## Released next.6 publication

V5 now selects released next.6 at `44aaf5156426dfcbb1c8a189b8e20531e5b95613`. The shell bootstrap and standalone manager shipped in PR525; opt-in agent setup and retirement of automatic injection shipped in PR531. The guide retains its route but no longer claims unreleased provenance. Source-reviewed backend selection includes an explicit Compose override, with shared stable-home cautions.

The prior next.5 originals remain intact. New release snapshots live under `docs/versions/v5/originals/next6/` and have independent hashes in the manifest. V4 remains unchanged. The next.1 Python candidate-install recipe is curated as history. Detailed next.5 field audits retain explicit historical per-page provenance rather than being silently relabeled as next.6. See the next.6 release-contract page for changed interfaces and remaining field-coverage limits.

Generation owns ignored content, navigation, version labels and LLM exports. Site source loaders consume those generated collections; there is no separate site/lib version pin. Publication controls admit only the two scoped opt-in examples on the source-labeled setup guide and continue rejecting automatic instruction-management recipes.

Fresh installation and local manager status are evidence for that bounded path only. Cross-version upgrade/rollback, initialized data, native application and installed-client acceptance remain open. No deployment or preview runtime was performed by this docs worker.
