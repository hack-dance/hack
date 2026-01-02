# Packaging & Distribution

This doc covers how to package `hack` for local testing and public release, plus how the installer
works and where assets live.

## Local workflows (source)

### Dev wrapper (fastest iteration)
```bash
bun install
bun run install:dev
hack --help
```
Installs a small wrapper at `~/.hack/bin/hack` that runs your working tree directly.

### Compiled binary (release-like)
```bash
bun install
bun run install:bin
hack --help
```
Builds `dist/hack` and installs it to `~/.hack/bin/hack`.

### Check which install is active
```bash
bun run install:status
```
Shows whether the current `hack` is a dev wrapper or a compiled binary.

## Release workflow (semantic-release)

```bash
bun install
bun run release:prepare
git push --follow-tags
```

What this does:
- Computes the next version from Conventional Commits.
- Updates `CHANGELOG.md` and `package.json`.
- Creates a `chore(release): <version>` commit and `v<version>` tag.
- Pushing the tag triggers the GitHub Release workflow, which builds artifacts and publishes the
  GitHub Release.

Notes:
- Use `bun run commit` for a Commitizen prompt (commitlint enforces Conventional Commits).
- To force a release, make a Conventional Commit that bumps the right level
  (e.g. `fix:` for patch, `feat:` for minor, `feat!:` or `BREAKING CHANGE:` for major).
- If you want to package locally without tagging, use `bun run build:release`.

## Release build (local packaging)

```bash
bun run build:release
```

Outputs two artifacts:
- `dist/release/hack-<version>-<platform>-<arch>.tar.gz`
- `dist/release/hack-install.sh` (also writes `hack-<version>-install.sh`)

Flags:
- `--out=<dir>`: custom output dir (default: `dist/release`)
- `--version=<x.y.z>`: override package version
- `--skip-tests`: skip `bun test`
- `--no-clean`: keep existing release dir

## Release contents (tarball layout)

```
hack-<version>-release/
  hack
  install.sh
  assets/
    gifs/
      cut.gif
      hacker-mash.gif
    schemas/
      hack.config.schema.json
      hack.branches.schema.json
  binaries/
    gum/
      gum_0.17.0_Darwin_arm64.tar.gz
      gum_0.17.0_Darwin_x86_64.tar.gz
  README.md
  SHA256SUMS
```

Tarball name: `hack-<version>-<platform>-<arch>.tar.gz`

## install.sh behavior

There are two scripts:

- **Top-level install script** (`hack-install.sh`): downloads the tarball for your
  platform, extracts it to a temp dir, runs the inner installer, then cleans up.
- **Inner install script** (inside the tarball): copies the binary + assets into `~/.hack/`,
  offers to update your shell config (`PATH` + `HACK_ASSETS_DIR`), and optionally runs
  `hack global install`.

Defaults:
- Binary: `~/.hack/bin/hack`
- Assets: `~/.hack/assets`

Environment overrides:
- `HACK_INSTALL_BIN`: override install bin dir
- `HACK_INSTALL_ASSETS`: override assets dir
- `HACK_INSTALL_NONINTERACTIVE=1`: skip prompts (defaults to “no” except for chafa/dnsmasq)
- `HACK_INSTALL_TAG`: override release tag (top-level installer)
- `HACK_INSTALL_VERSION`: override version (top-level installer)
- `HACK_RELEASE_BASE_URL`: override download base URL (top-level installer)

Dependency checks (macOS, inside the inner installer):
- `chafa` (used by `hack the planet`)
- `dnsmasq` (required for `*.hack` DNS)
- `mkcert` (only for `hack global cert`)

Gum is **not** installed via brew; the CLI uses the bundled gum tarballs when present.

The inner script can optionally run `hack global install` after setup.

## Assets + discovery

- `HACK_ASSETS_DIR` is used to locate bundled gum tarballs.
- `hack global install` generates schemas into `~/.hack/schemas/` and serves them at
  `https://schemas.hack`.
- `hack the planet` currently resolves GIFs from the repo root or current working directory. The
  release bundle includes GIFs under `assets/gifs/` for convenience.

## Public distribution (recommended)

- Publish release tarballs (per-arch if needed) to GitHub Releases:
  - `hack-<version>-darwin-arm64.tar.gz`
  - `hack-<version>-darwin-x86_64.tar.gz`
- Publish the install script as an asset:
  - `hack-install.sh` (latest-friendly)
- Include `SHA256SUMS`.
- Provide a one-line install snippet that downloads + runs the installer:

```bash
curl -fsSL https://github.com/hack-dance/hack-cli/releases/latest/download/hack-install.sh | bash
```

## Verification checklist

- `hack --help` works after install.
- `hack global install` succeeds on a clean machine.
- `https://logs.hack` and `https://schemas.hack` are reachable.
- `hack the planet --loop`
