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

The pinned generated reference is supplemented by explicit command/output,
configuration-field and MCP-field references for each version. v4 has 84 public
leaves. The pinned v5 source inventory has 92; its recommended publication selection
has 84 after eight retiring agent-management leaves are excluded; the supplements add
three and six deeper leaf sections respectively. Initial flag display differences
were generic value placeholders, not missing registered flags. The v5 authored
schema reference lists all 168 project/local property declarations. See
`reference-coverage.md` for counts, exclusions and limits. Owned diagnostic, provisioning, telemetry, project and env report fields are
covered separately. Raw engine rows, dynamic application maps, shared error.detail
and the explicitly opaque compiler plan boundary remain open; these
pages do not turn private protocols into public APIs or claim runtime/cloud/client
qualification from source review.

The published generated CLI reference is curated to the declared public slice: unsupported/retired roots and Internal/Fun/Extensions/Beta groups are omitted, while the hashed historical originals remain intact. The public supplement completes that slice; publication checks reject excluded headings and retain logs/env/branch sections and version-specific setup boundaries.

## Explicit-agent v5 publication choice

The recommended v5 setup is CLI plus versioned docs, with separately selected
skills or MCP. Editorial overrides replace the pinned integrations, agent-first,
project-setup, core and CLI-overview tutorials. The new integrations page links
the reviewed next.5 native marketplace and manifests, names the exact seven
skills, and distinguishes local source registration from client installation.
The official OpenAI packaging guide supplies the local marketplace registration
command and client-directory route; no client loading was performed here.

Next.5 is not a hook-free artifact: its Codex manifest selects skills, whose text
still includes guidance-maintenance recommendations; Claude selects primer hooks
and Cursor selects rules. Core removal is a separate, pending dependency. The
short historical compatibility page records shipped availability and source
links without a runnable repair/export tutorial.

Eight agent-management leaves and init's optional handoff flag are intentionally
omitted from the recommended v5 command reference and LLM corpus. Setup-sync
report types are also excluded from that slice. V4 and every hashed original
remain intact; this editorial choice does not assert runtime removal in next.5.
Env injection, lifecycle definition freshness and runtime ownership are unrelated
and remain documented.

Publication checks exercise both versions, reject retiring command/flag/tutorial
patterns in staged v5 pages and full LLM exports, preserve unrelated runtime
language, and require the explicit plugin/MCP artifact boundaries. All original
manifest hashes are checked even when an editorial override replaces a page.

The agent-setup-v5-branch guide is an explicit per-page source exception: unreleased PR531 at af71a8407d14a0dd27f7073a43010fff3a4bd219. Its title, footer and LLM index/export identify that source. Default v5 runtime/reference content stays pinned to released next.5; v4 and all original snapshot hashes remain unchanged. Only the two reviewed opt-in setup examples are allowed on this guide; retiring automatic instruction management remains excluded. This adds no release, installed-client or runtime acceptance claim.
