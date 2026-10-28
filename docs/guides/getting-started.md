# Getting started

Hack runs your local project services, environment, secrets, HTTPS routing and logs
from committed `.hack/` configuration. This guide uses the supported Docker Compose
runtime. You do not need a hosted Hack account or an agent integration.

## 1. Install the stable CLI

On macOS with Homebrew:

```bash
brew tap hack-dance/tap
brew install hack-dance/tap/hack
hack version
```

For the release installer and other supported installation options, see the
[repository README](../../README.md#install). Have a running Docker-compatible
engine with Docker Compose available before starting project services. Use
`hack doctor` to inspect missing prerequisites and follow its specific fix.

## 2. Set up local routing

```bash
hack global install
```

This configures shared local routing, DNS and certificate trust. Read its prompts:
DNS and certificate changes affect your host and can require approval. See
[certificate trust](macos-certificate-trust.md) and
[browser connectivity](macos-browser-network.md) if a local URL does not resolve.

## 3. Initialize one project

From a repository you own:

```bash
cd your-project
hack init
```

Review the generated `.hack/` files before starting anything. Keep configuration in
git; keep private keys and local state out of git. For an existing Compose project,
custom domains or agent-assisted setup, follow [project setup](init-project.md).

## 4. Start and inspect

```bash
hack up --detach
hack open
hack ps
hack logs
```

New projects use a configurable local HTTPS domain. Services use the
project's declared routing and environment. If startup fails, inspect the reported
error and `hack doctor`; a browser opening alone does not verify your application.
Run the application's normal checks too.

When finished:

```bash
hack down
```

## Continue with your project

- [Environment and encrypted secrets](../env.md)
- [Lifecycle processes and startup hooks](../lifecycle.md)
- [Sessions](../sessions.md)
- [Worktrees and watchers](development-runtime-safety.md)
- [Optional agent integrations](../integrations.md)
- [CLI reference](../reference/cli.md)

## Exploring v5

The native v5 candidate is experimental and has a separate installation and
project-adoption flow. Installing a prerelease does not migrate a project or prove
runtime parity. Keep your stable environment available and follow
[dogfooding v5 alongside v4](v5-dogfooding.md).
