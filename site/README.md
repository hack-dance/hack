# hack.foo documentation site

Local, reviewable site for the Hack public docs. Nothing here configures DNS,
credentials, analytics, deployment or a hosting account. `https://hack.foo` is the
intended canonical URL; a successful local build does not mean the site is deployed.

## Develop and verify

Use the repository's pinned Bun 1.4.2. Site dependencies and `site/bun.lock` are
independent of the CLI workspace; do not change the root Bun pin for Next.js.
Next.js also requires a supported Node.js installation (20.9 or newer).

From the repository root:

```bash
bun install --cwd site --frozen-lockfile
bun run docs:prepare
bun run docs:check
bun run docs:typecheck
bun run docs:build
bun run docs:dev
```

The dev server binds to `127.0.0.1:3000`; choose a different port with the Next CLI
when needed. `bun run --cwd site start` serves an existing production build locally.
With the preview running, validate all routes and exports in a second terminal:

```bash
bun run docs:smoke http://127.0.0.1:3000
```

There is no publish or deploy command. Production builds explicitly use Next's
supported webpack builder. Upstream Fumadocs cache-analysis and CSS `::highlight`
optimizer warnings can appear; a passing build does not establish their resolution.

## Canonical source and privacy boundary

Edit Markdown in `docs/`, not `site/content/`. The site follows the existing
schema.stream architecture: canonical Markdown → generated Fumadocs content →
Next.js pages. The implementation and dependency versions are specific to Hack.

`scripts/docs/manifest.ts` is the complete public-source allowlist. There is no
recursive repository or archive discovery. `docs:prepare` regenerates only its
owned ignored `site/content/docs` directory and `site/public/llms*.txt`. Navigation,
search, sitemap and the LLM corpus derive from the same staged documents. New pages
require deliberate manifest review. Private `_docs/`, internal evidence, native
qualification logs and transcript stores must never be added.

Links to allowlisted documents become `/docs/...` routes. Existing tracked public
repository files outside the site remain GitHub links on `next`; these links can
move as that branch changes. Missing/untracked targets, traversal outside the
repository, symlink targets and links into private evidence directories fail the
staging step. Code examples are not rewritten. `docs:check` compares every staged
file against canonical input and checks negative boundary controls. It checks local
link targets, not remote availability or application/runtime acceptance.

## Versions and release claims

Stable Compose setup is the first path. Native v5 and SmolVM candidate documentation
is experimental; install success, unit tests or this site build do not prove native
loaded acceptance or parity. No page should infer a release's availability from a
local checkout or package version alone.

Dependencies were checked against the official npm registry on 2026-10-28. Next
16.4.3 is above the patched 16.4.1 floor in the
[October 14 security update](https://nextjs.org/blog/nextjs-security-update-october-14-2026).
React 19.3.1, Fumadocs core/UI 16.17.8 and MDX 15.4.10 use their current compatible
releases. Recheck official advisories and package peer requirements when updating;
do not reuse another site's older pins, analytics or domain redirects.
