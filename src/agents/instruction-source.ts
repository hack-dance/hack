/**
 * Single source of truth for hack CLI agent instructions.
 *
 * Every generated agent-facing instruction surface (AGENTS.md/CLAUDE.md
 * snippet, Codex skill, Cursor rules, session primer) renders from the
 * sections defined here. Surface-specific framing (frontmatter, markers,
 * top-level headings) stays in each renderer; the canonical section titles
 * and bullets live here so content can never drift between surfaces.
 */

export type InstructionSurface = "docs" | "skill" | "rules" | "primer";

export type InstructionHeadingStyle = "markdown" | "plain";

export type InstructionSection = {
  readonly id: string;
  readonly title: string;
  readonly bullets: readonly string[];
  readonly surfaces: readonly InstructionSurface[];
};

const ALL_SURFACES = ["docs", "skill", "rules", "primer"] as const;

/**
 * Canonical instruction sections in render order.
 *
 * The `surfaces` tags select which rendered outputs include a section:
 * - `docs`: AGENTS.md / CLAUDE.md marker-wrapped snippet (full content).
 * - `skill`: Codex SKILL.md (full content).
 * - `rules`: Cursor `.mdc` rules (lean operational subset).
 * - `primer`: `hack agent prime` session primer (concise subset).
 */
export const INSTRUCTION_SECTIONS: readonly InstructionSection[] = [
  {
    id: "product-boundary",
    title: "Product boundary",
    surfaces: ALL_SURFACES,
    bullets: [
      "Supported v3 surface: project init, up/down/restart, open, logs, env, host exec/shell, sessions, doctor, and daemon.",
      "Removed surfaces: hosted auth/account/org/team flows, web dashboard, built-in GitHub workflows, and built-in Linear sync.",
      "Experimental and unsupported: remote/gateway/node/dispatch commands. They are hidden from default help (list with `hack help --all`) and warn on use; do not use them unless explicitly requested.",
    ],
  },
  {
    id: "operating-rules",
    title: "Operating rules",
    surfaces: ALL_SURFACES,
    bullets: [
      "Prefer `hack` over raw `docker` / `docker compose` for project workflows.",
      "Do not start/stop services from Docker Desktop UI for `hack`-managed projects.",
      "Treat `.hack/.internal` and `.hack/.branch` as hack-managed artifacts; do not hand-edit generated files there.",
      "Use `--json` for machine-readable output when available; `hack up/down/restart/doctor --json` emit an `{ok, data | error: {code, message}}` envelope with stable E_* error codes.",
      "Scripted/agent runs: pass `--no-interactive` (or set `HACK_NO_INTERACTIVE=1`) so commands never block on prompts — they apply documented defaults or fail fast with E_INTERACTIVE_REQUIRED.",
      "Use MCP only when shell access is unavailable.",
      "If runtime state looks wrong, run `hack doctor`, then `hack doctor --fix` before manual repair.",
    ],
  },
  {
    id: "core-objects",
    title: "Core objects",
    surfaces: ["docs", "skill"],
    bullets: [
      "Project: a repo with `.hack/` config + compose file.",
      "Service: a compose service (e.g. api, web, worker).",
      "Instance: a running project; branch instances are separate copies started with `--branch`.",
    ],
  },
  {
    id: "config",
    title: "Config + schema",
    surfaces: ["docs", "skill", "primer"],
    bullets: [
      "Project config: `.hack/hack.config.json`",
      "Global config: `~/.hack/hack.config.json`",
      "Schema URL: `https://schemas.hack/hack.config.schema.json`",
      "Prefer CLI writes: `hack config get <path>`, `hack config set <path> <value>`, `hack config set --global <path> <value>`",
    ],
  },
  {
    id: "routing",
    title: "Hostname routing + Caddy labels",
    surfaces: ["docs", "skill", "primer"],
    bullets: [
      "Primary host comes from `dev_host` (default: `<project>.hack`).",
      "Subdomain pattern is `<sub>.<dev_host>` (for example: `api.myapp.hack`).",
      "OAuth alias (when enabled) also routes `<dev_host>.<tld>` and `<sub>.<dev_host>.<tld>` (default tld: `gy`).",
      "Not every compose service is routable: only services with Caddy labels and on `hack-dev` are exposed.",
      "Required labels for HTTP services: `caddy`, `caddy.reverse_proxy`, `caddy.tls=internal`.",
      "Quick checks: `hack open`, `hack open <sub>`, `hack open --json`.",
    ],
  },
  {
    id: "tls",
    title: "TLS + valid-hostname constraints",
    surfaces: ["docs", "skill", "primer"],
    bullets: [
      "`hack` uses Caddy internal PKI for HTTPS on routed hosts; trust CA with `hack global trust`.",
      "Containers get a combined public+local trust bundle (SSL_CERT_FILE etc.) once `hack global trust` has run; public TLS (package registries, external APIs) keeps working alongside `*.hack` trust.",
      "If the combined bundle is missing, only Node gets `*.hack` trust (NODE_EXTRA_CA_CERTS); OpenSSL-based tools keep public roots — run `hack global trust` to enable both.",
      "`.hack` is local-first and great for dev, but it is not a public suffix.",
      "Use OAuth alias hosts (for example `*.hack.gy`) when providers require public-suffix-style callback domains.",
      "Alias hosts are still local-dev routes unless you add an external tunnel/remote ingress path.",
    ],
  },
  {
    id: "managed-files",
    title: "Project files (managed vs generated)",
    surfaces: ["docs", "skill", "rules"],
    bullets: [
      "Source-of-truth files: `.hack/docker-compose.yml`, `.hack/hack.config.json`, `.hack/hack.env.default.yaml`, and optional `.hack/hack.env.<overlay>.yaml`.",
      "Worktree-local env override files: `.hack/hack.env.local.yaml` and `.hack/hack.env.<overlay>.local.yaml`.",
      "Local-only files: `.hack.secret.key`, optional `.hack/.env` compatibility output, `.hack/.env.state.json`, and `.hack/.internal/` (runtime/local machine state; keep gitignored).",
      "Generated (do not hand-edit): `.hack/.internal/compose.override.yml`, `.hack/.internal/compose.env.override.yml`, `.hack/.branch/compose.<branch>.override.yml`.",
      "Managed via CLI: `.hack/.internal/extra-hosts.json` (use `hack internal extra-hosts ...` commands).",
      "Lifecycle runtime files: `.hack/.internal/lifecycle/state.json`, `.hack/.internal/lifecycle/*.log`.",
      "Ignore rules: hack owns a committed `.hack/.gitignore` (self-healing on init/up) covering machine-local generated files (`.internal/`, `.branch/`, `.env`, `.env.state.json`, `hack.env*.local.yaml`, `tickets/`); keep it committed, and if generated files leaked into git, `hack doctor --fix` untracks them (files stay on disk).",
    ],
  },
  {
    id: "worktrees",
    title: "Linked git worktrees",
    surfaces: ALL_SURFACES,
    bullets: [
      "Secret key inherits from the primary checkout automatically through the shared git common dir; set `HACK_ENV_SECRET_KEY` for CI or detached environments.",
      "`hack up` in a linked worktree defaults to a branch instance named after the worktree's git branch; a detached linked worktree requires an explicit `--branch`, unless config `worktree.auto_branch=false` explicitly opts into the base instance.",
      "`hack doctor` flags divergent secret keys and dev_host collisions across checkouts.",
    ],
  },
  {
    id: "networking",
    title: "Advanced networking (extra_hosts + local proxies/tunnels)",
    surfaces: ["docs", "skill"],
    bullets: [
      "Static host mappings: set `internal.extra_hosts` in `.hack/hack.config.json`.",
      "Dynamic host mappings: `hack internal extra-hosts set <hostname> <target>` / `unset` / `list`.",
      "For host-local proxies/tunnels, prefer `host-gateway` as target when possible.",
      "After mapping changes or proxy IP churn: `hack restart` and then `hack doctor`.",
    ],
  },
  {
    id: "workflow",
    title: "Standard workflow",
    surfaces: ALL_SURFACES,
    bullets: [
      "If `.hack/` is missing: `hack init`",
      "Start services: `hack up --detach` (or `hack up -d`)",
      "Check status: `hack ps` or `hack status`",
      "Open app URL: `hack open --json`",
      "Restart: `hack restart`",
      "Stop services: `hack down`",
    ],
  },
  {
    id: "running-things",
    title: "Running things (decision guide)",
    surfaces: ALL_SURFACES,
    bullets: [
      "One-off command in a fresh service container (deps started as needed): `hack run <service> <cmd...>`.",
      "Command inside an already-running service container: `hack exec <service> -- <cmd...>`.",
      "Host script that needs hack-stored env: `hack host exec --env <overlay> --scope <service> -- <cmd...>` — this is THE way to run repo scripts; never read .env files directly.",
      "Interactive host shell with injected env: `hack host shell --env <overlay> --scope <service>`.",
      "Call a service over HTTP (from the host or between containers): use its Caddy hostname `https://<sub>.<dev_host>`; discover routable URLs with `hack open --json`.",
    ],
  },
  {
    id: "logs",
    title: "Logs (default is compose)",
    surfaces: ["docs", "skill", "primer"],
    bullets: [
      "Fast tail: `hack logs --pretty`",
      "Per-service tail: `hack logs <service>`",
      "Machine snapshot: `hack logs --json --no-follow`",
      "Loki history/query: `hack logs --loki --since 2h --pretty` or `hack logs --loki --query '{project=\"<name>\"}'`",
      "Force compose backend: `hack logs --compose`",
      "Global infra logs: `hack global logs caddy --no-follow --tail 200`",
    ],
  },
  {
    id: "lifecycle",
    title: "Lifecycle + startup",
    surfaces: ALL_SURFACES,
    bullets: [
      "Put host setup in `.hack/hack.config.json` under `startup`/`lifecycle` (not ad-hoc terminal tabs).",
      "Use `lifecycle.up.before` for pre-start hooks and `lifecycle.processes` for long-running host tasks.",
      'For fixed-port host helpers such as SSM tunnels or local proxies, set `singleton.ports` and usually `onConflict: "adopt"` so Hack reuses a healthy existing listener instead of starting duplicate tunnel stacks.',
      "`singleton` is a listener guard, not process ownership transfer; adopted external processes are left running on `hack down`.",
      "Inspect lifecycle status via `hack projects --details` and stream via `hack logs <service-or-process>`.",
    ],
  },
  {
    id: "workspaces",
    title: "Workspaces (mux-managed, tmux-first by default)",
    surfaces: ["docs", "skill"],
    bullets: [
      "Picker: `hack session` for persistent project workspaces.",
      "Reuse/create: `hack session start <project>`",
      "Env-scoped workspace: `hack session start <project> --env qa --service api --detach`",
      "Force isolated agent workspace: `hack session start <project> --new --name agent-1` (`<project>--agent-1`).",
      'Execute in workspace: `hack session exec <workspace> "<command>"`',
      'Execute in workspace with injected env: `hack session exec <workspace> --env qa --service api "bun db:migrate"`',
      "Stop workspace: `hack session stop <workspace>`",
    ],
  },
  {
    id: "host-env",
    title: "Host-side env helpers",
    surfaces: ALL_SURFACES,
    bullets: [
      "One-off host command with injected env: `hack host exec --env qa --scope api -- bun db:migrate`",
      "Host commands default to a host-local env view; use `--target compose` when you explicitly want container-oriented addresses.",
      "`--scope` selects which env scope to inject; it does not move execution into that service container.",
      "Interactive host shell with injected env: `hack host shell --env qa --scope api`",
      "Run inside an already-running service container: `hack exec api -- bun test`",
    ],
  },
  {
    id: "branch-instances",
    title: "Branch instances (parallel envs)",
    surfaces: ["docs", "skill", "primer"],
    bullets: [
      "Use a branch instance when you need two versions running at once (PR review, experiments, migrations) or want to keep a stable environment while testing another branch.",
      "Target one with `--branch <name>` on up/open/logs/down (for example: `hack up --branch <name> --detach`).",
      "Linked worktrees pick a branch instance automatically (see Linked git worktrees).",
    ],
  },
  {
    id: "run-exec",
    title: "Run commands inside services",
    surfaces: ["docs", "skill"],
    bullets: [
      "One-off: `hack run <service> <cmd...>` (uses `docker compose run --rm`)",
      "Example: `hack run api bun test`",
      "Use `--workdir <path>` to change working dir inside the container.",
      "Use `hack ps --json` to list services and status.",
    ],
  },
  {
    id: "targeting",
    title: "Project targeting",
    surfaces: ["docs", "skill", "primer"],
    bullets: [
      "From repo root, commands use that project automatically.",
      "Else use `--project <name>` (registry) or `--path <repo-root>`.",
      "List projects: `hack projects --json`",
    ],
  },
  {
    id: "global-infra",
    title: "Global infra",
    surfaces: ["docs", "skill"],
    bullets: [
      "Bootstrap once: `hack global install`",
      "Start/stop/status: `hack global up`, `hack global down`, `hack global status`",
      "Use `hack global up` before Loki/Grafana queries if global logging is offline.",
    ],
  },
  {
    id: "daemon",
    title: "Daemon (optional)",
    surfaces: ["docs", "skill"],
    bullets: [
      "Start for faster JSON status/ps: `hack daemon start`",
      "Check status: `hack daemon status`",
    ],
  },
  {
    id: "compose-notes",
    title: "Docker compose notes",
    surfaces: ["docs", "skill"],
    bullets: [
      "Prefer `hack` commands; they include the right files/networks.",
      "Use `docker compose -f .hack/docker-compose.yml exec <service> <cmd>` only if you need exec into a running container.",
    ],
  },
  {
    id: "maintenance",
    title: "Agent integration maintenance",
    surfaces: ALL_SURFACES,
    bullets: [
      "Project-level hack commands auto-check integration drift and attempt auto-sync (docs/skills/MCP).",
      "Set `HACK_SETUP_SYNC_MODE=warn` to only warn, or `HACK_SETUP_SYNC_MODE=off` to disable.",
      "Refresh project + user integrations: `hack setup sync --all-scopes`",
      "Audit integration state only: `hack setup sync --all-scopes --check`",
      "Remove generated integration artifacts: `hack setup sync --all-scopes --remove`",
      "After upgrading CLI: `hack update` then `hack setup sync --all-scopes`",
      "When changing hack itself: interface or behavior changes must update docs/ in the same change (regenerate the CLI reference with `bun run docs:cli-reference`).",
    ],
  },
  {
    id: "agent-setup",
    title: "Agent setup (CLI-first)",
    surfaces: ["docs", "skill", "primer"],
    bullets: [
      "Cursor rules: `hack setup cursor`",
      "Claude hooks: `hack setup claude`",
      "Codex skill: `hack setup codex`",
      "Refresh all local agent integrations: `hack setup sync --all-scopes`",
      "Agent-assisted onboarding: `hack init --with claude|codex|both` (new repos) or `hack agent onboard` (existing projects) print/hand off the full setup prompt; the `/hack-init` skill and the `hack-init` MCP prompt return the same content.",
      "Init prompt: `hack agent init` (use --client cursor|claude|codex to open)",
      "Init patterns: `hack agent patterns`",
      "MCP (no-shell only): `hack setup mcp`",
      "MCP install (explicit): `hack mcp install --all --scope project`",
    ],
  },
  {
    id: "extensions",
    title: "Optional extensions",
    surfaces: ALL_SURFACES,
    bullets: [
      "A local git-backed tickets extension exists (`hack tickets`) — only use it when the project explicitly uses it.",
    ],
  },
];

/**
 * Select the canonical sections tagged for a rendered surface, in order.
 */
export function sectionsForSurface(opts: {
  readonly surface: InstructionSurface;
}): readonly InstructionSection[] {
  return INSTRUCTION_SECTIONS.filter((section) =>
    section.surfaces.includes(opts.surface)
  );
}

/**
 * Render the canonical sections for a surface as a markdown-ish block.
 *
 * @param opts.surface - Which surface's tagged sections to include.
 * @param opts.headingStyle - `markdown` renders `## Title` headings;
 *   `plain` renders compact `Title:` label lines (used by the embedded
 *   docs snippet and the primer).
 * @returns Joined section blocks separated by blank lines, no trailing newline.
 */
export function renderInstructionSections(opts: {
  readonly surface: InstructionSurface;
  readonly headingStyle: InstructionHeadingStyle;
}): string {
  const blocks = sectionsForSurface({ surface: opts.surface }).map((section) =>
    renderSection({ section, headingStyle: opts.headingStyle })
  );
  return blocks.join("\n\n");
}

/**
 * Normalize generated instruction text for drift comparison: unify line
 * endings, drop trailing whitespace, collapse repeated blank lines, and trim.
 */
export function normalizeInstructionText(opts: {
  readonly text: string;
}): string {
  return opts.text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderSection(opts: {
  readonly section: InstructionSection;
  readonly headingStyle: InstructionHeadingStyle;
}): string {
  const bullets = opts.section.bullets.map((bullet) => `- ${bullet}`);
  if (opts.headingStyle === "markdown") {
    return [`## ${opts.section.title}`, "", ...bullets].join("\n");
  }
  return [`${opts.section.title}:`, ...bullets].join("\n");
}
