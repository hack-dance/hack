/** Public site inputs are opt-in. Never replace this list with a repository glob. */
export const documents = [
  ["docs/README.md", "index", "Documentation"],
  [
    "docs/guides/getting-started.md",
    "guides/getting-started",
    "Getting started",
  ],
  ["docs/core.md", "core", "Core concepts"],
  ["docs/guides/init-project.md", "guides/init-project", "Project setup"],
  ["docs/env.md", "env", "Environment and secrets"],
  ["docs/lifecycle.md", "lifecycle", "Lifecycle"],
  ["docs/sessions.md", "sessions", "Sessions"],
  [
    "docs/guides/development-runtime-safety.md",
    "guides/development-runtime-safety",
    "Worktrees and watchers",
  ],
  [
    "docs/guides/global-settings.md",
    "guides/global-settings",
    "Global settings",
  ],
  [
    "docs/guides/macos-browser-network.md",
    "guides/macos-browser-network",
    "macOS connectivity",
  ],
  [
    "docs/guides/macos-certificate-trust.md",
    "guides/macos-certificate-trust",
    "Certificate trust",
  ],
  [
    "docs/guides/codex-managed-environments.md",
    "guides/codex-managed-environments",
    "Managed environments",
  ],
  [
    "docs/guides/agent-first-setup.md",
    "guides/agent-first-setup",
    "Agent setup",
  ],
  ["docs/integrations.md", "integrations", "Agent integrations"],
  ["docs/agent-guidance.md", "agent-guidance", "Agent guidance"],
  ["docs/cli.md", "cli", "CLI overview"],
  ["docs/reference/cli.md", "reference/cli", "Command reference"],
  ["docs/architecture.md", "architecture", "Architecture"],
  ["docs/reference.md", "reference", "Reference index"],
  [
    "docs/guides/v5-dogfooding.md",
    "guides/v5-dogfooding",
    "Experimental v5 dogfooding",
  ],
  ["docs/guides/prereleases.md", "guides/prereleases", "Prerelease channels"],
  [
    "docs/guides/candidate-install.md",
    "guides/candidate-install",
    "Candidate installation",
  ],
  [
    "docs/guides/native-candidate.md",
    "guides/native-candidate",
    "Native candidate limits",
  ],
  [
    "docs/reference/native-config-import.md",
    "reference/native-config-import",
    "Native config import",
  ],
  [
    "docs/reference/native-authored-commands.md",
    "reference/native-authored-commands",
    "Native authored commands",
  ],
] as const;
