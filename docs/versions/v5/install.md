# Install

## Prerequisites

The next.6 native prerelease supports Apple Silicon macOS only. The shell bootstrap
uses system tools including curl, shasum and codesign. The installer and standalone
manager need neither Python nor a separately installed Bun. The native DNS helper
is separate; this is not a claim that every native helper is Python-free.

Download and inspect the shell asset from the released next.6 tag:

```sh
curl --fail --location --proto '=https' --tlsv1.2 \
  https://github.com/hack-dance/hack/releases/download/v5.0.0-next.6/hack-next-install.sh \
  --output hack-next-install.sh
# Inspect the downloaded script before executing it.
sh hack-next-install.sh
```

The bootstrap pins its standalone manager checksum and release version; it does
not discover a mutable latest release. Its default installation root is
`~/.hack-next`. It installs the explicit launcher below without replacing an
existing stable install or PATH entry:

```sh
"$HOME/.hack-next/bin/hack-next" --version
```

Installation does not install the native provider, boot a VM, enroll a project,
migrate data, activate DNS or trust, or load an agent client integration. Complete
[Native preparation](../guides/native-candidate.md) before native application work.

## Choose the backend explicitly

The released launcher defaults to native execution with version-private CLI and
native homes. Unlike next.5, next.6 also accepts an explicit Compose selection:

```sh
HACK_RUNTIME_BACKEND=compose "$HOME/.hack-next/bin/hack-next" --version
```

This selects the bundle's CLI on Compose, clears native binary/home selections,
and retains the caller's `HACK_HOME` and global configuration (default `~/.hack`).
Compose requires an existing Docker-compatible engine, Compose and separately
prepared routing. It shares stable project/configuration state: do not run stable
v4 and the candidate concurrently against the same home, including their daemons.
The [candidate guide](../guides/candidate-install.md) links the exact source contract.
Choose v4 in Docs version for the stable Compose workflow; its examples do not
establish native command support.

## Evidence and open acceptance

The fresh public next.6 bootstrap and local manager status were verified in an
isolated installation. That check did not execute the native payload or MCP backend.
Cross-version upgrade and rollback, initialized-data preservation, native application
acceptance and installed-client loading remain open. Manager operations existing in
source do not close those acceptance gates. See [release contracts](reference/next6-contracts.md).
