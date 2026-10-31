# hack.foo documentation site

Local, reviewable site for the Hack public docs. Nothing here configures DNS,
credentials, analytics, deployment or a hosting account. `https://hack.foo` is the
intended canonical URL; a successful local build does not mean the site is deployed.

## Develop and verify

For a Hack-routed preview, run from the repository root:

```bash
hack up docs --profile docs --branch docs-preview --detach
hack open docs --branch docs-preview
```

This opt-in service runs the pinned Bun and Node tools in a container, installs
the frozen site lockfile, builds with webpack, and serves the production build.
Dependencies and Next build output
live in branch-owned volumes. Hack supplies local HTTPS routing; no host port or
public deployment is created. Inspect startup with
`hack logs docs --profile docs --branch docs-preview --compose --no-follow`.
Stop this preview with `hack down --profile docs --branch docs-preview`.
The service is capped at two CPUs and 6 GB memory, with a 3 GB Node heap.
Restart the service after source changes to rebuild the preview. This avoids
development-server compilation and HMR overhead while reviewing the whole corpus.

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

## Sources, versions and curation

Read [versioned-content.md](versioned-content.md) for source refs, original snapshot
hashes, editorial adaptations, navigation and verification boundaries.
`scripts/docs/versions.json` is the version-specific publication allowlist.
Only its entries feed Fumadocs/search/LLM exports; no recursive archive discovery
is used. `docs:prepare` owns ignored generated content and exports. Edit the
explicit editorial source for the desired version, preserve original snapshots,
and run corpus, type, build and live smoke checks.

The homepage design remains independent of version selection. `/docs` defaults to
v5; the docs navigation selects v4 or v5. Versioned source snapshots describe their
pinned revision, not every current development change. No successful site build
establishes runtime acceptance or public deployment.
