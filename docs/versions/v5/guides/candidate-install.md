# Install a native prerelease beside stable Hack

v5 prereleases ship for Apple Silicon macOS as immutable `5.0.0-next.N` bundles.
The shell bootstrap on each release installs a standalone manager and the selected
bundle into a private `~/.hack-next` channel. It does not replace Homebrew `hack`,
edit your PATH or shell profile, convert projects, move volumes, enable DNS or
trust, or start a VM. [Install](../install.md) has the download and run steps.

Run the candidate explicitly:

```sh
"$HOME/.hack-next/bin/hack-next" --version
"$HOME/.hack-next/bin/hack-next" ps --path /absolute/project
```

## Backends and homes

`hack-next` selects the native backend by default, with version-private native and
CLI homes, so candidate state never mixes with stable state. Set
`HACK_RUNTIME_BACKEND=compose` to run the same verified bundle on Compose against
your ordinary Hack home. Any other value refuses before the candidate starts.

On Compose, stable `hack` and the candidate share project and configuration state.
Never run both at once against the same home, including their daemons. Before a
Compose run: `hack global up`, any stable `hack doctor` or `hack doctor --fix`, then
`hack daemon stop`, and confirm `pgrep -fl "hack daemon start"` prints nothing.

## Upgrade and roll back

Each release is a new immutable version directory with its own homes. Selecting a
different retained bundle switches software, not data: an older candidate that
refuses state written by a newer one is not a successful rollback. Stop and verify
ownership of active workloads before changing versions, and keep stable v4
available until each project's own workflow passes on the candidate.

Every invocation re-verifies the retained bundle bytes, receipts and macOS code
signatures and refuses on any mismatch. The
[prerelease channel guide](../../guides/prereleases.md) covers versioning,
platform support and publication gates in full.
