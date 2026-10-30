# Install

## Prerequisites

The native prerelease needs Apple Silicon macOS, Python 3.9 or newer, and macOS codesign. Provider installation, routing and project adoption are separate steps. Compose execution additionally needs a running Docker-compatible engine with Compose. A cloud sandbox must supply its own supported runtime; installing the CLI alone does not provide one.

Download and inspect the installer from the selected published source tag:

```sh
curl --fail --location --proto '=https' --tlsv1.2 \
  https://raw.githubusercontent.com/hack-dance/hack/v5.0.0-next.5/scripts/install-prerelease.py \
  --output hack-next-install.py
# Inspect the downloaded script before executing it.
python3 hack-next-install.py install --version 5.0.0-next.5
```

Read [candidate installation](../guides/candidate-install.md) for verification,
retained versions and provider preparation. This installs the selected bundle;
it does not create an application environment.

The candidate is invoked explicitly:

```sh
"$HOME/.hack-next/bin/hack-next" --version
```

It uses the native backend by default. It leaves the stable Homebrew executable in place. Follow [Getting started](getting-started.md) to choose a runtime path.

## Set up local Compose routing

Before starting a Compose project on a new development host:

```sh
HACK_RUNTIME_BACKEND=compose "$HOME/.hack-next/bin/hack-next" global install
```

Read the prompts. This configures shared local routing, DNS and certificate
trust and can require native approval. Confirm the Docker-compatible engine is
running. Do not expect a remote host's local names or trust to appear on your
laptop automatically. Follow the matching project guide if setup reports a
missing prerequisite. This documentation does not perform these host changes.
