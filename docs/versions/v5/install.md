# Install

## Prerequisites

The native prerelease needs Apple Silicon macOS, Python 3.9 or newer, and macOS codesign. Provider installation, routing and project adoption are separate steps. Compose execution additionally needs a running Docker-compatible engine with Compose. A cloud sandbox must supply its own supported runtime; installing the CLI alone does not provide one.

Follow [candidate installation](../guides/candidate-install.md) to download and inspect an installer from an explicit published tag. The documented example installs next.1; do not assume a newer bundle's contents from that example. Select the exact published version you intend to use and read its bundled documentation.

The candidate is invoked explicitly:

```sh
"$HOME/.hack-next/bin/hack-next" --version
```

It uses the native backend by default. It leaves the stable Homebrew executable in place. Follow [Getting started](getting-started.md) to choose a runtime path.
