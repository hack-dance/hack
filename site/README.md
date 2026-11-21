# hack.foo documentation site

The public docs site for Hack, built with Next.js and Fumadocs. `https://hack.foo`
is the canonical URL. The site publishes two versioned corpora, v4 (stable) and
v5 (prerelease), from pinned snapshots of the repository's `docs/` tree plus
short editorial pages under `docs/versions/<version>/`.

## Develop and verify

The [diagram type audit](diagram-types.md) records the syntax and light/dark
legibility checked at Pele 1.9.0. README pictures use the same renderer but carry
committed SVGs for GitHub; after changing their adjacent `.mmd` sources or the
house theme, run `bun run docs:readme-diagrams`. `docs:check` re-renders and rejects
stale pictures in either theme.

From a linked worktree, pick a unique instance name, such as `docs-preview`.
Run `hack up --branch docs-preview --detach`, then
`hack open docs --branch docs-preview --json` to get its URL. Edit site
components or editorial pages under `docs/versions/` to reload the preview.
Stop it with `hack down --branch docs-preview`. In the main checkout you can
omit `--branch` from all three commands. See [the contributor runtime](../.hack/README.md).

For standalone verification, use the repository's pinned Bun. Site dependencies and `site/bun.lock` are
independent of the CLI workspace; Next.js also needs Node.js 20.9 or newer.

From the repository root:

```bash
bun install --cwd site --frozen-lockfile
bun run docs:prepare      # stage the versioned corpus into site/content and site/public
bun run docs:check        # corpus, link-boundary and framing checks
bun run docs:typecheck
bun run docs:build
```

With a production build served by `bun run --cwd site start`, run the HTTP smoke
in a second terminal:

```bash
bun run docs:smoke http://127.0.0.1:3000
```

It checks every versioned route, canonical URLs, search isolation, the LLM
exports, legacy redirects and unknown-version handling.

## Content model

- `scripts/docs/versions.json` pins each version to a Git revision and lists the
  `docs/` files it publishes. Only listed files are published; there is no
  recursive discovery.
- `docs/versions/<version>/originals/<dir>/` holds byte-exact snapshots of those
  files at the pinned revision, verified by SHA-256 at build time.
- `docs/versions/<version>/*.md` are editorial pages written for the site. An
  editorial page with the same slug as a snapshot replaces it.
- `bun run docs:prepare` rewrites relative links to site routes or pinned GitHub
  URLs, curates the generated CLI reference to the supported surface, and writes
  `/<version>/llms.txt` and `/<version>/llms-full.txt`.

To move v5 to a newer prerelease:

```bash
bun run docs:pin -- --version v5 --ref v5.0.0-next.22 --label "v5 (next.22)" --dir next22
```

Then update the release tag in `docs/versions/v5/install.md`, re-read the
editorial pages against the new release, and run the checks above. The pin script
replaces the previous originals directory.

See [content-decisions.md](content-decisions.md) for the editorial rules and
[reference-coverage.md](reference-coverage.md) for what the field references cover.

## Deploy

The site deploys through Vercel's Git integration from this repository. The Vercel
project is connected to `hack-dance/hack` with these settings, which
[`vercel.json`](vercel.json) repeats so the repository stays the source of truth:

| Setting | Value |
| --- | --- |
| Root directory | `site` |
| Framework preset | Next.js |
| Install command | `bun install --frozen-lockfile` |
| Build command | `cd .. && bun run docs:prepare && bun run --cwd site build` |
| Production branch | `next` while v5 docs live there; `main` after 5.0.0 |

The build stages the corpus from the repository root before `next build`, so
"Include source files outside of the Root Directory" must stay enabled: the build
reads `docs/` and `scripts/docs/`.

Pushes to the production branch deploy to production, and pull requests get preview
deployments. Until the `hack.foo` domain is attached, deployment protection requires
a Vercel login to open the `vercel.app` URLs, so the deployment status on a pull
request is the public signal that a preview built. A successful local build does
not mean the site is deployed.
