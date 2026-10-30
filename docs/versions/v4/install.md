# Install

## Prerequisites

Use a machine with a supported Hack release binary and a running Docker-compatible engine with Docker Compose. macOS users can install through Homebrew. Local DNS and certificate trust setup can require native approval. Check the engine before project startup:

```sh
docker info
docker compose version
```

The v4.2.4 README documents this stable-channel installation:

```sh
brew tap hack-dance/tap
brew install hack-dance/tap/hack
hack version
```

Homebrew follows the current stable formula; it does not pin v4.2.4. For a historical binary, inspect the [v4.2.4 release](https://github.com/hack-dance/hack/releases/tag/v4.2.4) and choose the asset for your platform. Verify the installed version before following these archived docs.

Continue with [Getting started](getting-started.md).
