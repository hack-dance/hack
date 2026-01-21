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
      const status = result.changed
        ? existed
          ? "updated"
          : "created"
        : "noop";
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

  if (await pathExists(agentsPath)) targets.push("agents");
  if (await pathExists(claudePath)) targets.push("claude");

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
    "Use `hack` as the single interface for local dev. It manages docker compose, TLS/DNS, and logs.",
    "",
    "Concepts:",
    "- Project: a repo with `.hack/` config + compose file.",
    "- Service: a docker compose service (e.g. api, web, worker).",
    "- Instance: a running project; branch instances are separate copies started with `--branch`.",
    "",
    "When to use a branch instance:",
    "- You need two versions running at once (PR review, experiments, migrations).",
    "- You want to keep a stable environment while testing another branch.",
    "- Use `--branch <name>` on `hack up/open/logs/down` to target it.",
    "",
    "Standard workflow:",
    "- If `.hack/` is missing: `hack init`",
    "- Start services: `hack up --detach`",
    "- Check status: `hack ps` or `hack projects status`",
    "- Open app: `hack open` (use `--json` for machine parsing)",
    "- Stop services: `hack down`",
    "",
    "Logs and search:",
    "- Tail compose logs: `hack logs --pretty` or `hack logs <service>`",
    "- Snapshot for agents: `hack logs --json --no-follow`",
    "- Loki history: `hack logs --loki --since 2h --pretty`",
    "- Filter Loki services: `hack logs --loki --services api,web`",
    "- Raw LogQL: `hack logs --loki --query '{project=\"<name>\"}'`",
    "- Force compose logs: `hack logs --compose`",
    "- If Loki is unavailable, start global logs: `hack global up`",
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
    "Sessions (tmux-based):",
    "- Interactive picker: `hack session` (fzf picker, works as switcher inside tmux)",
    "- Start/attach: `hack session start <project>` (attaches if exists, switches if in tmux)",
    "- Force new: `hack session start <project> --new --name agent-1`",
    "- With infra: `hack session start <project> --up`",
    "- List: `hack session list`",
    "- Stop: `hack session stop <session>`",
    "- Exec in session: `hack session exec <session> \"<command>\"`",
    "- Setup tmux: `hack setup tmux` (installs tmux if missing)",
    "",
    "Agent setup (CLI-first):",
    "- Cursor rules: `hack setup cursor`",
    "- Claude hooks: `hack setup claude`",
    "- Codex skill: `hack setup codex`",
    "- Init prompt: `hack agent init` (use --client cursor|claude|codex to open)",
    "- Init patterns: `hack agent patterns`",
    "- MCP (no-shell only): `hack setup mcp`",
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
  if (trimmed.length === 0) return opts.snippet;
  return ensureTrailingNewline({
    text: `${trimmed}\n\n${opts.snippet.trimEnd()}`,
  });
}

function removeSnippet(opts: { readonly existing: string }): string {
  const pattern = new RegExp(
    `${escapeRegex({ value: DOC_MARKER_START })}[\\s\\S]*?${escapeRegex({ value: DOC_MARKER_END })}\\s*\\n?`,
    "m"
  );

  if (!pattern.test(opts.existing)) return opts.existing;

  const replaced = opts.existing.replace(pattern, "").trimEnd();
  if (replaced.length === 0) return "";
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
