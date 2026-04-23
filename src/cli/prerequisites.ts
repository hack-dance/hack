export type PrerequisitePolicy = "block" | "guide" | "warn";

export type PrerequisiteCheckId =
  | "docker_cli"
  | "docker_daemon"
  | "global_bootstrap"
  | "global_services"
  | "mux_backend"
  | "tmux_binary";

export type PrerequisiteDomain = "docker" | "global" | "mux";

/**
 * Stable metadata for a missing-prerequisite check.
 */
export type PrerequisiteCheckDefinition = {
  readonly id: PrerequisiteCheckId;
  readonly domain: PrerequisiteDomain;
  readonly summary: string;
  readonly detection: string;
  readonly primaryGuidance: string;
};

/**
 * A concrete prerequisite rule for a user-facing command.
 */
export type CommandPrerequisiteRule = {
  readonly checkId: PrerequisiteCheckId;
  readonly onMissing: PrerequisitePolicy;
  readonly reason: string;
  readonly when?: string;
};

/**
 * A user-facing command or conditional command variant that should invoke checks.
 */
export type CommandPrerequisiteContract = {
  readonly name: string;
  readonly commands: readonly string[];
  readonly rules: readonly CommandPrerequisiteRule[];
};

/**
 * A user-facing command that is intentionally handled outside the shared
 * prerequisite interception matrix.
 */
export type LocalPrerequisiteHandling = {
  readonly command: string;
  readonly reason: string;
};

export const PREREQUISITE_CHECKS = [
  {
    id: "docker_cli",
    domain: "docker",
    summary: "Docker CLI is installed and on PATH",
    detection:
      "Resolve `docker` from PATH before any Docker-backed command path.",
    primaryGuidance:
      "Install Docker Desktop or OrbStack before retrying the command.",
  },
  {
    id: "docker_daemon",
    domain: "docker",
    summary: "Docker engine is reachable",
    detection:
      "Run `docker info`; distinguish an installed CLI from a stopped or unreachable daemon.",
    primaryGuidance:
      "Offer to start the detected backend when possible, otherwise point to `hack global install` or the platform Docker app/service.",
  },
  {
    id: "global_bootstrap",
    domain: "global",
    summary:
      "`hack global install` has generated the managed ~/.hack stack files",
    detection:
      "Require generated compose/config/schema artifacts under `~/.hack` before commands that operate on the global stack.",
    primaryGuidance: "Launch `hack global install`.",
  },
  {
    id: "global_services",
    domain: "global",
    summary:
      "Global routing, logging, and Caddy-managed services are reachable",
    detection:
      "Check Caddy/CoreDNS/Loki reachability when a command relies on `*.hack`, internal DNS, Loki-backed logs, or Caddy-managed CA export.",
    primaryGuidance:
      "Launch `hack global up` when bootstrap exists, otherwise fall back to `hack global install`.",
  },
  {
    id: "mux_backend",
    domain: "mux",
    summary:
      "The configured `sessions.mux` backend resolves to an installed tmux or zellij binary",
    detection:
      "Read `sessions.mux`, then verify the selected backend in PATH; in `auto`, accept either tmux or zellij.",
    primaryGuidance:
      "Install tmux or zellij, or change `sessions.mux` to a valid value.",
  },
  {
    id: "tmux_binary",
    domain: "mux",
    summary: "tmux is available for tmux-only session features",
    detection:
      "Resolve `tmux` from PATH before tmux-specific commands like pane inspection or capture.",
    primaryGuidance:
      "Install tmux directly. After tmux is available, `hack setup tmux` can configure the picker keybinding.",
  },
] as const satisfies readonly PrerequisiteCheckDefinition[];

export const COMMAND_PREREQUISITE_CONTRACTS = [
  {
    name: "Global bootstrap",
    commands: ["global install"],
    rules: [
      {
        checkId: "docker_cli",
        onMissing: "guide",
        reason:
          "Global bootstrap cannot create or start the managed stack without Docker.",
      },
      {
        checkId: "docker_daemon",
        onMissing: "guide",
        reason:
          "This command should intercept into backend start guidance instead of failing on `docker info`.",
      },
      {
        checkId: "mux_backend",
        onMissing: "warn",
        reason:
          "Global bootstrap should complete even if session management will be degraded afterward.",
      },
    ],
  },
  {
    name: "Global stack lifecycle",
    commands: [
      "global up",
      "global status",
      "global logs",
      "global logs-reset",
    ],
    rules: [
      {
        checkId: "global_bootstrap",
        onMissing: "guide",
        reason:
          "These commands operate on the generated global stack and should redirect to install when the stack was never bootstrapped.",
      },
      {
        checkId: "docker_cli",
        onMissing: "guide",
        reason: "The global stack is Docker-managed.",
      },
      {
        checkId: "docker_daemon",
        onMissing: "guide",
        reason:
          "These commands should guide users into starting Docker rather than surfacing raw engine errors.",
      },
    ],
  },
  {
    name: "Global stack teardown",
    commands: ["global down"],
    rules: [
      {
        checkId: "docker_cli",
        onMissing: "guide",
        reason:
          "Tearing down an existing global stack still uses Docker-managed resources.",
        when: "Only when the managed global stack has already been bootstrapped; otherwise the command should remain idempotent.",
      },
      {
        checkId: "docker_daemon",
        onMissing: "guide",
        reason:
          "Stopping an existing global stack should guide users into starting Docker rather than surfacing raw engine errors.",
        when: "Only when the managed global stack has already been bootstrapped; otherwise the command should remain idempotent.",
      },
    ],
  },
  {
    name: "Global CA export and trust",
    commands: ["global ca", "global trust"],
    rules: [
      {
        checkId: "global_bootstrap",
        onMissing: "guide",
        reason:
          "CA export and trust flows depend on the managed global stack having been installed at least once.",
      },
      {
        checkId: "docker_cli",
        onMissing: "guide",
        reason:
          "These commands extract the Caddy-managed certificate authority from Docker-managed global services.",
      },
      {
        checkId: "docker_daemon",
        onMissing: "guide",
        reason:
          "CA export and trust should repair Docker availability before attempting to inspect or copy certificates.",
      },
      {
        checkId: "global_services",
        onMissing: "guide",
        reason:
          "The Caddy-managed global services need to be running before Hack can export or trust the generated CA.",
      },
    ],
  },
  {
    name: "Project runtime lifecycle",
    commands: ["up", "down", "restart", "ps", "run", "tui", "projects prune"],
    rules: [
      {
        checkId: "docker_cli",
        onMissing: "guide",
        reason:
          "These commands are fundamentally Docker-backed project operations.",
      },
      {
        checkId: "docker_daemon",
        onMissing: "guide",
        reason:
          "The preferred first-run behavior is guided Docker startup rather than a hard failure.",
      },
    ],
  },
  {
    name: "Project inventory diagnostics",
    commands: ["status", "projects"],
    rules: [
      {
        checkId: "docker_cli",
        onMissing: "warn",
        reason:
          "Project inventory commands can still show registered state even when Docker is unavailable, so they should surface degraded runtime status instead of redirecting.",
      },
      {
        checkId: "docker_daemon",
        onMissing: "warn",
        reason:
          "These commands already report runtime unavailability inline and should preserve that diagnostic behavior.",
      },
    ],
  },
  {
    name: "Project lifecycle host processes",
    commands: ["up", "restart"],
    rules: [
      {
        checkId: "mux_backend",
        onMissing: "guide",
        reason:
          "Lifecycle host processes use the configured mux backend and should fail fast with an actionable setup path.",
        when: "Only when the project config defines lifecycle host processes or pre-start hooks that require a mux session.",
      },
    ],
  },
  {
    name: "Project DNS and routed open",
    commands: ["open"],
    rules: [
      {
        checkId: "global_services",
        onMissing: "guide",
        reason:
          "Opening `https://<project>.hack` without Caddy/CoreDNS reachability is usually a setup gap, not a user error.",
      },
    ],
  },
  {
    name: "Project logs with fallback",
    commands: ["logs"],
    rules: [
      {
        checkId: "docker_cli",
        onMissing: "guide",
        reason:
          "The compose log backend remains the local fallback and still needs Docker available.",
      },
      {
        checkId: "docker_daemon",
        onMissing: "guide",
        reason:
          "Without a reachable daemon there is no compose fallback path for logs.",
      },
      {
        checkId: "global_services",
        onMissing: "warn",
        reason:
          "Default logs can degrade to compose output, so missing Loki/Caddy should warn instead of blocking.",
        when: "Only for the default logs path when the command is allowed to fall back from Loki to compose logs.",
      },
    ],
  },
  {
    name: "Project logs without fallback",
    commands: ["logs --loki", "logs --query"],
    rules: [
      {
        checkId: "global_services",
        onMissing: "guide",
        reason:
          "An explicit Loki request should not silently fall back; it should route into global logging setup.",
      },
    ],
  },
  {
    name: "Project logs with compose-only backend",
    commands: ["logs --compose"],
    rules: [
      {
        checkId: "docker_cli",
        onMissing: "guide",
        reason:
          "An explicit compose log request bypasses Loki entirely and still depends on Docker-backed logs.",
      },
      {
        checkId: "docker_daemon",
        onMissing: "guide",
        reason:
          "Without a reachable daemon there is no compose log backend available for an explicit `--compose` request.",
      },
    ],
  },
  {
    name: "Session commands",
    commands: [
      "session",
      "session list",
      "session start",
      "session attach",
      "session exec",
      "session stop",
      "ssh",
    ],
    rules: [
      {
        checkId: "tmux_binary",
        onMissing: "guide",
        reason:
          "The current session and SSH flows shell out to tmux directly, so they should repair tmux availability before continuing.",
      },
    ],
  },
  {
    name: "tmux-only session commands",
    commands: [
      "session panes",
      "session capture",
      "session tail",
      "setup tmux",
    ],
    rules: [
      {
        checkId: "tmux_binary",
        onMissing: "guide",
        reason:
          "These commands are tmux-specific and should launch tmux setup guidance instead of failing later.",
      },
    ],
  },
] as const satisfies readonly CommandPrerequisiteContract[];

export const COMMANDS_THAT_INVOKE_PREREQUISITE_CHECKS = [
  ...new Set(
    COMMAND_PREREQUISITE_CONTRACTS.flatMap((contract) => contract.commands)
  ),
] as const;

export const COMMANDS_WITH_LOCAL_PREREQUISITE_HANDLING: readonly LocalPrerequisiteHandling[] =
  [];

export function getCommandPrerequisiteContracts(input: {
  readonly command: string;
}): readonly CommandPrerequisiteContract[] {
  return COMMAND_PREREQUISITE_CONTRACTS.filter((contract) =>
    contract.commands.some((candidate) => candidate === input.command)
  );
}

export function getLocalPrerequisiteHandling(input: {
  readonly command: string;
}): LocalPrerequisiteHandling | null {
  return (
    COMMANDS_WITH_LOCAL_PREREQUISITE_HANDLING.find(
      (entry) => entry.command === input.command
    ) ?? null
  );
}
