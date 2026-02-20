import { resolve } from "node:path";

import { pathExists, readTextFile, writeTextFileIfChanged } from "../lib/fs.ts";

export type AgentDocTarget = "agents" | "claude";

export type AgentDocUpdateResult = {
  readonly target: AgentDocTarget;
  readonly status: "created" | "updated" | "noop" | "error";
  readonly path: string;
  readonly message?: string;
};

export type AgentDocCheckResult = {
  readonly target: AgentDocTarget;
  readonly status: "present" | "missing" | "error";
  readonly path: string;
  readonly message?: string;
};

export type AgentDocRemoveResult = {
  readonly target: AgentDocTarget;
  readonly status: "removed" | "noop" | "error";
  readonly path: string;
  readonly message?: string;
};

const DOC_MARKER_START = "<!-- hack:agent-docs:start -->";
const DOC_MARKER_END = "<!-- hack:agent-docs:end -->";

/**
 * Upsert hack usage instructions into AGENTS.md / CLAUDE.md for a project.
 */
export async function upsertAgentDocs(opts: {
  readonly projectRoot: string;
  readonly targets: readonly AgentDocTarget[];
}): Promise<AgentDocUpdateResult[]> {
  const results: AgentDocUpdateResult[] = [];
  const snippet = renderAgentDocsSnippet();

  for (const target of opts.targets) {
    const path = resolveAgentDocPath({ projectRoot: opts.projectRoot, target });
    try {
      const existed = await pathExists(path);
      const existing = (await readTextFile(path)) ?? "";
      const next = upsertSnippet({ existing, snippet });
      const result = await writeTextFileIfChanged(path, next);
      const status = resolveUpsertStatus({ changed: result.changed, existed });
      results.push({ target, status, path });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to update file";
      results.push({ target, status: "error", path, message });
    }
  }

  return results;
}

/**
 * Detect which agent doc files already exist in a project.
 */
export async function getExistingAgentDocs(opts: {
  readonly projectRoot: string;
}): Promise<AgentDocTarget[]> {
  const targets: AgentDocTarget[] = [];
  const agentsPath = resolveAgentDocPath({
    projectRoot: opts.projectRoot,
    target: "agents",
  });
  const claudePath = resolveAgentDocPath({
    projectRoot: opts.projectRoot,
    target: "claude",
  });

  if (await pathExists(agentsPath)) {
    targets.push("agents");
  }
  if (await pathExists(claudePath)) {
    targets.push("claude");
  }

  return targets;
}

/**
 * Check whether agent docs include the hack snippet.
 */
export async function checkAgentDocs(opts: {
  readonly projectRoot: string;
  readonly targets: readonly AgentDocTarget[];
}): Promise<AgentDocCheckResult[]> {
  const results: AgentDocCheckResult[] = [];

  for (const target of opts.targets) {
    const path = resolveAgentDocPath({ projectRoot: opts.projectRoot, target });
    try {
      const existing = await readTextFile(path);
      if (!existing) {
        results.push({ target, status: "missing", path });
        continue;
      }

      if (!hasAgentDocSnippet({ content: existing })) {
        results.push({
          target,
          status: "error",
          path,
          message: "Missing hack agent-docs markers.",
        });
        continue;
      }

      results.push({ target, status: "present", path });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to read file";
      results.push({ target, status: "error", path, message });
    }
  }

  return results;
}

/**
 * Remove the hack snippet from agent docs.
 */
export async function removeAgentDocs(opts: {
  readonly projectRoot: string;
  readonly targets: readonly AgentDocTarget[];
}): Promise<AgentDocRemoveResult[]> {
  const results: AgentDocRemoveResult[] = [];

  for (const target of opts.targets) {
    const path = resolveAgentDocPath({ projectRoot: opts.projectRoot, target });
    try {
      const existing = await readTextFile(path);
      if (!existing) {
        results.push({ target, status: "noop", path });
        continue;
      }

      const next = removeSnippet({ existing });
      if (next === existing) {
        results.push({ target, status: "noop", path });
        continue;
      }

      await writeTextFileIfChanged(path, next);
      results.push({ target, status: "removed", path });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to update file";
      results.push({ target, status: "error", path, message });
    }
  }

  return results;
}

/**
 * Render the hack usage snippet for agent-facing docs.
 */
export function renderAgentDocsSnippet(): string {
  const lines = [
    DOC_MARKER_START,
    "## hack CLI (local dev + MCP)",
    "",
    "Use `hack` as the single interface for local runtime orchestration (compose, DNS/TLS, logs, sessions).",
    "",
    "Operating rules:",
    "- Prefer `hack` over raw `docker` / `docker compose` for project workflows.",
    "- Do not start/stop services from Docker Desktop UI for `hack`-managed projects.",
    "- Treat `.hack/.internal` and `.hack/.branch` as hack-managed artifacts; do not hand-edit generated files there.",
    "- Use MCP only when shell access is unavailable.",
    "- If runtime state looks wrong, run `hack doctor`, then `hack doctor --fix` before manual repair.",
    "",
    "Core objects:",
    "- Project: a repo with `.hack/` config + compose file.",
    "- Service: a compose service (e.g. api, web, worker).",
    "- Instance: a running project; branch instances are separate copies started with `--branch`.",
    "",
    "Config + schema:",
    "- Project config: `.hack/hack.config.json`",
    "- Global config: `~/.hack/hack.config.json`",
    "- Schema URL: `https://schemas.hack/hack.config.schema.json`",
    "- Prefer CLI writes: `hack config get <path>`, `hack config set <path> <value>`, `hack config set --global <path> <value>`",
    "",
    "Hostname routing + Caddy labels:",
    "- Primary host comes from `dev_host` (default: `<project>.hack`).",
    "- Subdomain pattern is `<sub>.<dev_host>` (for example: `api.myapp.hack`).",
    "- OAuth alias (when enabled) also routes `<dev_host>.<tld>` and `<sub>.<dev_host>.<tld>` (default tld: `gy`).",
    "- Not every compose service is routable: only services with Caddy labels and on `hack-dev` are exposed.",
    "- Required labels for HTTP services: `caddy`, `caddy.reverse_proxy`, `caddy.tls=internal`.",
    "- Quick checks: `hack open`, `hack open <sub>`, `hack open --json`.",
    "",
    "TLS + valid-hostname constraints:",
    "- `hack` uses Caddy internal PKI for HTTPS on routed hosts; trust CA with `hack global trust`.",
    "- `.hack` is local-first and great for dev, but it is not a public suffix.",
    "- Use OAuth alias hosts (for example `*.hack.gy`) when providers require public-suffix-style callback domains.",
    "- Alias hosts are still local-dev routes unless you add an external tunnel/remote ingress path.",
    "",
    "Project files (managed vs generated):",
    "- Source-of-truth files: `.hack/docker-compose.yml`, `.hack/hack.config.json`, `.hack/hack.env.json` (if env contract is used).",
    "- Local-only files: `.hack/.env` and `.hack/.internal/` (runtime/local machine state; keep gitignored).",
    "- Generated (do not hand-edit): `.hack/.internal/compose.override.yml`, `.hack/.internal/compose.env.override.yml`, `.hack/.branch/compose.<branch>.override.yml`.",
    "- Managed via CLI: `.hack/.internal/extra-hosts.json` (use `hack internal extra-hosts ...` commands).",
    "- Lifecycle runtime files: `.hack/.internal/lifecycle/state.json`, `.hack/.internal/lifecycle/*.log`.",
    "",
    "Advanced networking (extra_hosts + local proxies/tunnels):",
    "- Static host mappings: set `internal.extra_hosts` in `.hack/hack.config.json`.",
    "- Dynamic host mappings: `hack internal extra-hosts set <hostname> <target>` / `unset` / `list`.",
    "- For host-local proxies/tunnels, prefer `host-gateway` as target when possible.",
    "- After mapping changes or proxy IP churn: `hack restart` and then `hack doctor`.",
    "",
    "Standard workflow:",
    "- If `.hack/` is missing: `hack init`",
    "- Start services: `hack up --detach` (or `hack up -d`)",
    "- Check status: `hack ps` or `hack status`",
    "- Open app URL: `hack open --json`",
    "- Restart: `hack restart`",
    "- Stop services: `hack down`",
    "",
    "Logs (default is compose):",
    "- Fast tail: `hack logs --pretty`",
    "- Per-service tail: `hack logs <service>`",
    "- Machine snapshot: `hack logs --json --no-follow`",
    "- Loki history/query: `hack logs --loki --since 2h --pretty` or `hack logs --loki --query '{project=\"<name>\"}'`",
    "- Force compose backend: `hack logs --compose`",
    "- Global infra logs: `hack global logs caddy --no-follow --tail 200`",
    "",
    "Lifecycle + startup:",
    "- Put host setup in `.hack/hack.config.json` under `startup`/`lifecycle` (not ad-hoc terminal tabs).",
    "- Use `lifecycle.up.before` for pre-start hooks and `lifecycle.processes` for long-running host tasks.",
    "- Inspect lifecycle status via `hack projects --details` and stream via `hack logs <service-or-process>`.",
    "",
    "Sessions (mux-managed):",
    "- Picker: `hack session`",
    "- Start/attach: `hack session start <project>`",
    "- Force isolated agent session: `hack session start <project> --new --name agent-1`",
    '- Execute in session: `hack session exec <session> "<command>"`',
    "- Stop session: `hack session stop <session>`",
    "",
    "Tickets (git-backed):",
    '- Create: `hack tickets create --title "..." --body-stdin`',
    "- List/show: `hack tickets list`, `hack tickets show T-00001`",
    "- Status/sync: `hack tickets status T-00001 in_progress`, `hack tickets sync`",
    "",
    "Global infra:",
    "- Bootstrap once: `hack global install`",
    "- Start/stop/status: `hack global up`, `hack global down`, `hack global status`",
    "- Use `hack global up` before Loki/Grafana queries if global logging is offline.",
    "",
    "When to use a branch instance:",
    "- You need two versions running at once (PR review, experiments, migrations).",
    "- You want to keep a stable environment while testing another branch.",
    "- Use `--branch <name>` on `hack up/open/logs/down` to target it.",
    "",
    "Run commands inside services:",
    "- One-off: `hack run <service> <cmd...>` (uses `docker compose run --rm`)",
    "- Example: `hack run api bun test`",
    "- Use `--workdir <path>` to change working dir inside the container.",
    "- Use `hack ps --json` to list services and status.",
    "",
    "Project targeting:",
    "- From repo root, commands use that project automatically.",
    "- Else use `--project <name>` (registry) or `--path <repo-root>`.",
    "- List projects: `hack projects --json`",
    "",
    "Daemon (optional):",
    "- Start for faster JSON status/ps: `hack daemon start`",
    "- Check status: `hack daemon status`",
    "",
    "Docker compose notes:",
    "- Prefer `hack` commands; they include the right files/networks.",
    "- Use `docker compose -f .hack/docker-compose.yml exec <service> <cmd>` only if you need exec into a running container.",
    "",
    "Agent integration maintenance:",
    "- Refresh project + user integrations: `hack setup sync --all-scopes`",
    "- Audit integration state only: `hack setup sync --all-scopes --check`",
    "- Remove generated integration artifacts: `hack setup sync --all-scopes --remove`",
    "- After upgrading CLI: `hack update` then `hack setup sync --all-scopes`",
    "",
    "Agent setup (CLI-first):",
    "- Cursor rules: `hack setup cursor`",
    "- Claude hooks: `hack setup claude`",
    "- Codex skill: `hack setup codex`",
    "- Tickets skill: `hack setup tickets`",
    "- Refresh all local agent integrations: `hack setup sync --all-scopes`",
    "- Init prompt: `hack agent init` (use --client cursor|claude|codex to open)",
    "- Init patterns: `hack agent patterns`",
    "- MCP (no-shell only): `hack setup mcp`",
    "- MCP install (explicit): `hack mcp install --all --scope project`",
    DOC_MARKER_END,
    "",
  ];

  return lines.join("\n");
}

export function resolveAgentDocPath(opts: {
  readonly projectRoot: string;
  readonly target: AgentDocTarget;
}): string {
  return resolve(
    opts.projectRoot,
    resolveAgentDocFilename({ target: opts.target })
  );
}

function resolveAgentDocFilename(opts: {
  readonly target: AgentDocTarget;
}): string {
  return opts.target === "agents" ? "AGENTS.md" : "CLAUDE.md";
}

function resolveUpsertStatus(opts: {
  readonly changed: boolean;
  readonly existed: boolean;
}): "created" | "updated" | "noop" {
  if (!opts.changed) {
    return "noop";
  }
  return opts.existed ? "updated" : "created";
}

function upsertSnippet(opts: {
  readonly existing: string;
  readonly snippet: string;
}): string {
  const pattern = new RegExp(
    `${escapeRegex({ value: DOC_MARKER_START })}[\\s\\S]*?${escapeRegex({ value: DOC_MARKER_END })}`
  );

  if (pattern.test(opts.existing)) {
    const replaced = opts.existing.replace(pattern, opts.snippet.trimEnd());
    return ensureTrailingNewline({ text: replaced });
  }

  const trimmed = opts.existing.trimEnd();
  if (trimmed.length === 0) {
    return opts.snippet;
  }
  return ensureTrailingNewline({
    text: `${trimmed}\n\n${opts.snippet.trimEnd()}`,
  });
}

function removeSnippet(opts: { readonly existing: string }): string {
  const pattern = new RegExp(
    `${escapeRegex({ value: DOC_MARKER_START })}[\\s\\S]*?${escapeRegex({ value: DOC_MARKER_END })}\\s*\\n?`,
    "m"
  );

  if (!pattern.test(opts.existing)) {
    return opts.existing;
  }

  const replaced = opts.existing.replace(pattern, "").trimEnd();
  if (replaced.length === 0) {
    return "";
  }
  return ensureTrailingNewline({ text: replaced.replace(/\n{3,}/g, "\n\n") });
}

function hasAgentDocSnippet(opts: { readonly content: string }): boolean {
  return (
    opts.content.includes(DOC_MARKER_START) &&
    opts.content.includes(DOC_MARKER_END)
  );
}

function escapeRegex(opts: { readonly value: string }): string {
  return opts.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensureTrailingNewline(opts: { readonly text: string }): string {
  return opts.text.endsWith("\n") ? opts.text : `${opts.text}\n`;
}
