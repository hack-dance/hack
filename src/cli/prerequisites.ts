export type PrerequisitePolicy = "block" | "guide" | "warn";

export type PrerequisiteCheckId =
  | "docker_cli"
  | "docker_daemon"
  | "global_bootstrap"
  | "global_services"
  | "mux_backend"
  | "tmux_binary"
  | "github_profile"
  | "github_token"
  | "github_gh_cli"
  | "linear_profile"
  | "linear_token"
  | "linear_broker_auth"
  | "linear_oauth_client";

export type PrerequisiteDomain =
  | "docker"
  | "global"
  | "mux"
  | "github"
  | "linear";

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
  {
    id: "github_profile",
    domain: "github",
    summary:
      "A GitHub profile is explicitly selected or resolvable from config",
    detection:
      "Resolve profile selection using command flag, project override, global default, then implicit default.",
    primaryGuidance:
      "Launch `hack x github connect --profile <name>` or choose a profile with `hack x github use --profile <name>`.",
  },
  {
    id: "github_token",
    domain: "github",
    summary: "The selected GitHub profile can resolve a usable token",
    detection:
      "Resolve token from keychain, refresh flow, or env fallback before invoking GitHub API operations.",
    primaryGuidance:
      "Launch `hack x github connect --profile <name>` or rerun `hack x github oauth-connect --profile <name>`.",
  },
  {
    id: "github_gh_cli",
    domain: "github",
    summary: "`gh` is installed for GitHub browser bootstrap",
    detection:
      "Resolve `gh` from PATH before `oauth-connect`; optionally preflight `gh auth status` once the CLI is present.",
    primaryGuidance:
      "Install GitHub CLI and rerun `hack x github oauth-connect`.",
  },
  {
    id: "linear_profile",
    domain: "linear",
    summary:
      "A Linear profile is explicitly selected or resolvable from config",
    detection:
      "Resolve profile selection using command flag, project override, global default, then implicit default.",
    primaryGuidance:
      "Launch `hack linear connect --profile <name>` or choose a profile with `hack linear use --profile <name>`.",
  },
  {
    id: "linear_token",
    domain: "linear",
    summary: "The selected Linear profile can resolve a usable access token",
    detection:
      "Resolve token from keychain, broker refresh, or env fallback before Linear API operations.",
    primaryGuidance:
      "Launch `hack linear connect --profile <name>` or rerun `hack linear oauth-connect --profile <name>`.",
  },
  {
    id: "linear_broker_auth",
    domain: "linear",
    summary:
      "A Hack broker management token is available for broker-owned Linear flows",
    detection:
      "Require the local Hack auth session before broker-owned OAuth bootstrap or token refresh.",
    primaryGuidance: "Launch `hack auth login`.",
  },
  {
    id: "linear_oauth_client",
    domain: "linear",
    summary:
      "Local Linear OAuth client credentials are configured for direct OAuth fallback",
    detection:
      "Require local Linear OAuth client id and secret when using the direct OAuth path instead of the broker.",
    primaryGuidance:
      "Configure the local Linear OAuth env/auth-ref values, then rerun `hack linear oauth-connect`.",
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
    commands: ["up", "down", "restart", "ps", "run", "tui"],
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
  {
    name: "GitHub diagnostics",
    commands: ["x github status", "x github profiles"],
    rules: [
      {
        checkId: "github_profile",
        onMissing: "warn",
        reason:
          "Status-style commands exist to expose missing GitHub configuration, so they should report the gap instead of intercepting it.",
      },
      {
        checkId: "github_token",
        onMissing: "warn",
        reason:
          "Token resolution failures should remain visible in diagnostics output rather than being hidden behind setup interception.",
      },
    ],
  },
  {
    name: "GitHub profile selection",
    commands: ["x github use"],
    rules: [
      {
        checkId: "github_profile",
        onMissing: "guide",
        reason:
          "Changing or removing a profile without a resolvable target should redirect into profile setup.",
      },
    ],
  },
  {
    name: "GitHub OAuth bootstrap",
    commands: ["x github oauth-connect"],
    rules: [
      {
        checkId: "github_gh_cli",
        onMissing: "guide",
        reason:
          "GitHub browser bootstrap is built around the `gh` CLI and should intercept before spawning it.",
      },
    ],
  },
  {
    name: "GitHub API actions",
    commands: ["x github pr-upsert"],
    rules: [
      {
        checkId: "github_profile",
        onMissing: "guide",
        reason:
          "PR automation needs a selected GitHub identity before it can talk to the API.",
      },
      {
        checkId: "github_token",
        onMissing: "guide",
        reason:
          "This is a mutating GitHub API command and should route directly into token setup when auth is missing.",
      },
    ],
  },
  {
    name: "Linear diagnostics",
    commands: ["linear status", "linear profiles"],
    rules: [
      {
        checkId: "linear_profile",
        onMissing: "warn",
        reason:
          "Status-style commands should show unresolved Linear profile state instead of intercepting it.",
      },
      {
        checkId: "linear_token",
        onMissing: "warn",
        reason:
          "Users run these commands specifically to inspect missing token state, so guidance belongs in the output rather than a redirect.",
      },
    ],
  },
  {
    name: "Linear profile selection",
    commands: ["linear use"],
    rules: [
      {
        checkId: "linear_profile",
        onMissing: "guide",
        reason:
          "Changing or removing a profile without a resolvable target should redirect into profile setup.",
      },
    ],
  },
  {
    name: "Linear connect",
    commands: ["linear connect"],
    rules: [
      {
        checkId: "linear_broker_auth",
        onMissing: "guide",
        reason:
          "When connect falls into a broker-owned OAuth flow, it should send the user to Hack account login first.",
        when: "Only when no direct token input is supplied, the command resolves to the broker-owned OAuth path, and local OAuth fallback is not configured.",
      },
      {
        checkId: "linear_oauth_client",
        onMissing: "guide",
        reason:
          "Local direct OAuth should not start until the client id and secret are configured.",
        when: "Only when no direct token input is supplied and the command resolves to the local OAuth fallback path after broker auth is unavailable or skipped.",
      },
    ],
  },
  {
    name: "Linear OAuth bootstrap",
    commands: ["linear oauth-connect"],
    rules: [
      {
        checkId: "linear_broker_auth",
        onMissing: "guide",
        reason:
          "Broker-owned Linear connection flows should launch Hack account login instead of surfacing auth-broker errors.",
        when: "Only when the broker-owned OAuth path is selected and local OAuth fallback is not configured.",
      },
      {
        checkId: "linear_oauth_client",
        onMissing: "guide",
        reason:
          "Direct OAuth fallback should intercept before opening the browser if local credentials are missing.",
        when: "Only when the local OAuth fallback path is selected after broker auth is unavailable or skipped.",
      },
    ],
  },
  {
    name: "Linear broker-backed setup and delivery commands",
    commands: [
      "linear connections",
      "linear seed-local-access",
      "linear deliveries",
      "linear apply-delivery",
      "linear subscriptions",
      "linear set-subscription",
      "linear remove-subscription",
    ],
    rules: [
      {
        checkId: "linear_broker_auth",
        onMissing: "guide",
        reason:
          "These commands are broker-backed and should route into Hack account auth before they attempt broker operations.",
      },
    ],
  },
  {
    name: "Linear API actions",
    commands: ["linear projects", "linear sync-issue", "linear sync-project"],
    rules: [
      {
        checkId: "linear_profile",
        onMissing: "guide",
        reason:
          "These commands depend on a resolved Linear profile or project binding before they can talk to Linear.",
      },
      {
        checkId: "linear_token",
        onMissing: "guide",
        reason:
          "These are action commands and should route directly into connection repair when access tokens are missing.",
      },
    ],
  },
  {
    name: "Linear project binding with remote resolution",
    commands: ["linear project-bind", "linear project-link"],
    rules: [
      {
        checkId: "linear_profile",
        onMissing: "guide",
        reason:
          "Project binding needs a resolved Linear profile whenever it must look up project metadata remotely.",
        when: "Only when the command must resolve project metadata from Linear instead of using a fully specified local binding.",
      },
      {
        checkId: "linear_token",
        onMissing: "guide",
        reason:
          "Remote project lookup should route directly into token repair when Linear API access is missing.",
        when: "Only when the command must resolve project metadata from Linear instead of using a fully specified local binding.",
      },
    ],
  },
  {
    name: "Linear autosync runtime",
    commands: ["linear run-autosync"],
    rules: [
      {
        checkId: "linear_profile",
        onMissing: "guide",
        reason:
          "Autosync processing needs a resolved Linear profile once it begins working against a configured route.",
        when: "Only when a target project route is being processed.",
      },
      {
        checkId: "linear_token",
        onMissing: "guide",
        reason:
          "Autosync should repair missing Linear API access before it starts the sync runtime.",
        when: "Only when the runtime needs to talk to the Linear API for the selected route.",
      },
      {
        checkId: "linear_broker_auth",
        onMissing: "guide",
        reason:
          "Autosync also depends on broker-backed subscription and delivery flows, so broker auth should repair up front.",
      },
    ],
  },
] as const satisfies readonly CommandPrerequisiteContract[];

export const COMMANDS_THAT_INVOKE_PREREQUISITE_CHECKS = [
  ...new Set(
    COMMAND_PREREQUISITE_CONTRACTS.flatMap((contract) => contract.commands)
  ),
] as const;

export const COMMANDS_WITH_LOCAL_PREREQUISITE_HANDLING = [
  {
    command: "x github connect",
    reason:
      "GitHub connect is already the primary repair/bootstrap path, so it should keep command-local validation instead of redirecting into shared interception.",
  },
  {
    command: "linear setup",
    reason:
      "Linear setup is a local project wiring command that can run before auth or profile state exists, so it should stay outside the shared interception matrix.",
  },
  {
    command: "x github disconnect",
    reason:
      "Disconnect only removes stored local auth material and should keep command-local validation.",
  },
  {
    command: "linear disconnect",
    reason:
      "Disconnect only removes stored local auth material and should keep command-local validation.",
  },
  {
    command: "linear assignee-mappings",
    reason:
      "Assignee mapping inspection should continue to rely on command-local validation rather than shared prerequisite interception.",
  },
  {
    command: "linear set-assignee-mapping",
    reason:
      "Assignee mapping updates are local config mutations and should continue to rely on command-local validation.",
  },
  {
    command: "linear remove-assignee-mapping",
    reason:
      "Assignee mapping cleanup is local config mutation state and should not be hidden behind shared setup guidance.",
  },
  {
    command: "linear project-unlink",
    reason:
      "Project unlink is local cleanup state and should not be hidden behind shared setup guidance.",
  },
] as const satisfies readonly LocalPrerequisiteHandling[];

function normalizePrerequisiteCommand(input: {
  readonly command: string;
}): string {
  if (!input.command.startsWith("x linear")) {
    return input.command;
  }

  return input.command.slice(2);
}

export function getCommandPrerequisiteContracts(input: {
  readonly command: string;
}): readonly CommandPrerequisiteContract[] {
  const command = normalizePrerequisiteCommand({ command: input.command });
  return COMMAND_PREREQUISITE_CONTRACTS.filter((contract) =>
    contract.commands.includes(command)
  );
}

export function getLocalPrerequisiteHandling(input: {
  readonly command: string;
}): LocalPrerequisiteHandling | null {
  const command = normalizePrerequisiteCommand({ command: input.command });
  return (
    COMMANDS_WITH_LOCAL_PREREQUISITE_HANDLING.find(
      (entry) => entry.command === command
    ) ?? null
  );
}
