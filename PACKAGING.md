## Packaging plan (non-blocking)

For now, the recommended workflow is **run locally with Bun**:

```bash
bun install
bun dev --help
```

### Local install (dev + binary)

- **Dev (fastest iteration)**:

```bash
bun run install:dev
hack --help
```

- **Binary (release-like)**:

```bash
bun run install:bin
hack --help
```

### Phase 1: compiled Bun executable

We can produce a single executable with:

```bash
bun run build
```

This generates `dist/hack` via `bun build --compile`.

### Bundled assets (gum)

`hack global install` will try to install a bundled `gum` into `~/.hack/bin/gum` if it can find the release tarball(s).

To make that work in packaged distributions, ship the tarballs alongside the binary (or set an assets dir):

- **Preferred layout for a release artifact**:
  - `dist/hack`
  - `binaries/gum/gum_0.17.0_Darwin_arm64.tar.gz`
  - `binaries/gum/gum_0.17.0_Darwin_x86_64.tar.gz`

- **Optional override**:
  - Set `HACK_ASSETS_DIR` to a directory that contains either:
    - `<HACK_ASSETS_DIR>/binaries/gum/<tarball>`
    - `<HACK_ASSETS_DIR>/<tarball>`

If bundled assets aren’t present (or the platform isn’t supported), the CLI will fall back to `gum` on `PATH` (if present) or degrade gracefully.

### Phase 2: distribution

Once the binary + assets story is stable, options include:

- **Homebrew**: a tap formula that installs `dist/hack` (and optionally `binaries/gum/*`) to predictable locations.
- **GitHub Releases**: upload the binary + `binaries/` as a tarball.
- **npm**: publish a thin JS wrapper that downloads the right release artifact (optional; only if we want `npm i -g hack-cli`).
