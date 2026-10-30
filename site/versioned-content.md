# Versioned documentation and curation

The site defaults to `/docs/v5`; `/docs/v4` is a separate corpus. The navigation
selector changes the source corpus, and search requires a selected version.
Unknown versions return 404 (search: 400). Existing unversioned document URLs
redirect to their v5 equivalents; the old native-runtime-use URL redirects to
Getting started. Root LLM exports select v5; `/v4/llms*.txt` and `/v5/llms*.txt`
provide explicit agent handoff.

## Source provenance

`scripts/docs/versions.json` pins v4.2.4 to
`91b14bf0abb17602142425de0d02628a3e8a2615` and v5 next.5 to
`28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc`. These are published source snapshots,
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

The existing generated command reference has known missing full usage/options
sections for eight deeper public leaves (project owner show; project task
list/inspect; global dns preview/activate/deactivate; env backend status/use).
Parent tables expose their names but do not constitute full flag coverage. Public
config-schema, JSON-result, log-event and MCP contract coverage also needs a
version-specific dedicated reference pass. Do not label this first curation pass
an exhaustive API/type reference. Internal DTOs are not automatically public APIs.
