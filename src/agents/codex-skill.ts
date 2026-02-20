import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  ensureDir,
  pathExists,
  readTextFile,
  writeTextFileIfChanged,
} from "../lib/fs.ts";

export type CodexSkillScope = "project" | "user";

export type CodexSkillResult = {
  readonly scope: CodexSkillScope;
  readonly status:
    | "created"
    | "updated"
    | "noop"
    | "removed"
    | "missing"
    | "error";
  readonly path: string;
  readonly message?: string;
};

const SKILL_NAME = "hack-cli";
const SKILL_FILENAME = "SKILL.md";
const SKILL_DIR = ".codex/skills";
const HACK_CLI_MARKER_REGEX = /name:\s*hack-cli\b/i;

/**
 * Install or update the Codex skill for hack CLI usage.
 */
export async function installCodexSkill(opts: {
  readonly scope: CodexSkillScope;
  readonly projectRoot?: string;
}): Promise<CodexSkillResult> {
  const resolved = resolveCodexSkillPath(opts);
  if (!resolved.ok) {
    return {
      scope: opts.scope,
      status: "error",
      path: resolved.path ?? SKILL_FILENAME,
      message: resolved.message,
    };
  }

  const path = resolved.path;
  await ensureDir(dirname(path));
  const existed = await pathExists(path);
  const result = await writeTextFileIfChanged(path, renderCodexSkill());

  const status = resolveInstallStatus({ changed: result.changed, existed });
  return { scope: opts.scope, status, path };
}

/**
 * Check whether the Codex skill is installed.
 */
export async function checkCodexSkill(opts: {
  readonly scope: CodexSkillScope;
  readonly projectRoot?: string;
}): Promise<CodexSkillResult> {
  const resolved = resolveCodexSkillPath(opts);
  if (!resolved.ok) {
    return {
      scope: opts.scope,
      status: "error",
      path: resolved.path ?? SKILL_FILENAME,
      message: resolved.message,
    };
  }

  const path = resolved.path;
  const content = await readTextFile(path);
  if (!content) {
    return { scope: opts.scope, status: "missing", path };
  }

  const hasMarker = HACK_CLI_MARKER_REGEX.test(content);
  return { scope: opts.scope, status: hasMarker ? "noop" : "error", path };
}

/**
 * Remove the Codex skill for hack CLI usage.
 */
export async function removeCodexSkill(opts: {
  readonly scope: CodexSkillScope;
  readonly projectRoot?: string;
}): Promise<CodexSkillResult> {
  const resolved = resolveCodexSkillPath(opts);
  if (!resolved.ok) {
    return {
      scope: opts.scope,
      status: "error",
      path: resolved.path ?? SKILL_FILENAME,
      message: resolved.message,
    };
  }

  const path = resolved.path;
  const skillDir = resolve(path, "..");

  if (!(await pathExists(path))) {
    return { scope: opts.scope, status: "missing", path };
  }

  await rm(skillDir, { recursive: true, force: true });
  return { scope: opts.scope, status: "removed", path };
}

/**
 * Render the Codex skill template for hack CLI usage.
 */
export function renderCodexSkill(): string {
  const lines = [
    "---",
    "name: hack-cli",
    "description: >",
    "  Use the hack CLI for local runtime orchestration (compose, DNS/TLS, logs, sessions, tickets) and agent setup.",
    "  Trigger when asked to run/start/stop services, inspect logs, manage lifecycle/session workflows, or update",
    "  agent integrations. Prefer CLI over MCP when shell access is available.",
    "---",
    "",
    "# hack CLI",
    "",
    "Use `hack` as the primary interface for local development.",
    "",
    "## Operating Rules",
    "",
    "- Prefer `hack` over raw `docker` / `docker compose`.",
    "- Do not start/stop project services from Docker Desktop UI for `hack`-managed repos.",
    "- Treat `.hack/.internal` and `.hack/.branch` as hack-managed artifacts; avoid hand-editing generated files.",
    "- Use MCP only when shell access is unavailable.",
    "- Run `hack doctor` (and `hack doctor --fix`) before manual runtime/network repair.",
    "",
    "## Config + Schema",
    "",
    "- Project config: `.hack/hack.config.json`",
    "- Global config: `~/.hack/hack.config.json`",
    "- Schema URL: `https://schemas.hack/hack.config.schema.json`",
    "- Prefer CLI config edits via `hack config get/set`.",
    "",
    "## Hostname Routing",
    "",
    "- Primary host is `dev_host` (default: `<project>.hack`).",
    "- Subdomains use `<sub>.<dev_host>` (for example: `api.myapp.hack`).",
    "- OAuth alias can add `<dev_host>.<tld>` and `<sub>.<dev_host>.<tld>` (default: `gy`).",
    "- Only HTTP services with Caddy labels and `hack-dev` network attachment are routable.",
    "- Required labels: `caddy`, `caddy.reverse_proxy`, `caddy.tls=internal`.",
    "- Quick checks: `hack open`, `hack open <sub>`, `hack open --json`.",
    "",
    "## TLS + OAuth Host Rules",
    "",
    "- Caddy internal PKI provides HTTPS for routed hosts; trust CA with `hack global trust`.",
    "- `.hack` is local-first and not a public suffix.",
    "- Use alias hosts like `*.hack.gy` when provider callback validation rejects non-public-suffix hosts.",
    "- Alias hosts are local routes unless you explicitly add remote ingress/tunnel plumbing.",
    "",
    "## Managed Files",
    "",
    "- Source-of-truth files: `.hack/docker-compose.yml`, `.hack/hack.config.json`, `.hack/hack.env.json`.",
    "- Local-only files: `.hack/.env` and `.hack/.internal/` (gitignored; machine-specific state).",
    "- Generated by hack: `.hack/.internal/compose.override.yml`, `.hack/.internal/compose.env.override.yml`, `.hack/.branch/compose.<branch>.override.yml`.",
    "- Managed via CLI: `.hack/.internal/extra-hosts.json` using `hack internal extra-hosts ...` commands.",
    "- Lifecycle runtime files: `.hack/.internal/lifecycle/state.json`, `.hack/.internal/lifecycle/*.log`.",
    "",
    "## Advanced Networking",
    "",
    "- Static host mappings: set `internal.extra_hosts` in `.hack/hack.config.json`.",
    "- Dynamic mappings for local proxies/tunnels: `hack internal extra-hosts set <hostname> <target>`.",
    "- List/remove mappings: `hack internal extra-hosts list` / `hack internal extra-hosts unset <hostname>`.",
    "- Prefer `host-gateway` for host-local proxy targets when possible.",
    "- Apply changes with `hack restart`; verify with `hack doctor`.",
    "",
    "## Quick Start",
    "",
    "- Bootstrap project config: `hack init`",
    "- Start services: `hack up --detach`",
    "- Alternate shorthand: `hack up -d`",
    "- Restart services: `hack restart`",
    "- Open app: `hack open --json`",
    "- Tail logs (compose): `hack logs --pretty`",
    "- Per-service logs: `hack logs <service>`",
    "- Snapshot logs: `hack logs --json --no-follow`",
    "- Loki history/query: `hack logs --loki --since 2h --pretty`",
    "- Run commands: `hack run <service> <cmd...>`",
    "- Stop services: `hack down`",
    "",
    "## Global Infra",
    "",
    "- Install once: `hack global install`",
    "- Start/stop/status: `hack global up`, `hack global down`, `hack global status`",
    "- Global logs: `hack global logs <service> --no-follow --tail 200`",
    "",
    "## Lifecycle + Startup",
    "",
    "- Put host setup in `.hack/hack.config.json` under `startup` / `lifecycle`.",
    "- Use lifecycle processes for long-running host tasks, not ad-hoc terminals.",
    "- Inspect via `hack projects --details` and `hack logs <service-or-process>`.",
    "",
    "## Branch Instances",
    "",
    "Use branch instances to run parallel environments:",
    "",
    "- `hack up --branch <name> --detach`",
    "- `hack open --branch <name>`",
    "- `hack logs --branch <name>`",
    "- `hack down --branch <name>`",
    "",
    "## Sessions",
    "",
    "- Picker: `hack session`",
    "- Start/attach: `hack session start <project>`",
    "- Isolated agent session: `hack session start <project> --new --name agent-1`",
    '- Exec: `hack session exec <session> "<command>"`',
    "- Stop: `hack session stop <session>`",
    "",
    "## Tickets",
    "",
    '- Create: `hack tickets create --title "..." --body-stdin`',
    "- List/show: `hack tickets list`, `hack tickets show T-00001`",
    "- Status/sync: `hack tickets status T-00001 in_progress`, `hack tickets sync`",
    "",
    "## Project Targeting",
    "",
    "- Run from repo root when possible.",
    "- Otherwise use `--project <name>` or `--path <repo-root>`.",
    "- List projects: `hack projects --json`.",
    "",
    "## Agent Maintenance",
    "",
    "- Project-level hack commands auto-check integration drift and attempt auto-sync.",
    "- Set `HACK_SETUP_SYNC_MODE=warn` to warn-only, or `HACK_SETUP_SYNC_MODE=off` to disable.",
    "- Refresh project + global integrations: `hack setup sync --all-scopes`",
    "- Check generated integrations: `hack setup sync --all-scopes --check`",
    "- Remove generated integrations: `hack setup sync --all-scopes --remove`",
    "- After self-update: `hack update` then `hack setup sync --all-scopes`",
    "",
    "## Agent Setup",
    "",
    "- Cursor rules: `hack setup cursor`",
    "- Claude hooks: `hack setup claude`",
    "- Codex skill: `hack setup codex`",
    "- Tickets skill: `hack setup tickets`",
    "- Init prompt: `hack agent init` (use --client cursor|claude|codex to open)",
    "- Init patterns: `hack agent patterns`",
    "- MCP (no shell only): `hack setup mcp`",
    "- MCP install (explicit): `hack mcp install --all --scope project`",
    "",
  ];

  return lines.join("\n");
}

function resolveCodexSkillPath(opts: {
  readonly scope: CodexSkillScope;
  readonly projectRoot?: string;
}):
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly message: string; readonly path?: string } {
  if (opts.scope === "project" && !opts.projectRoot) {
    return {
      ok: false,
      message: "Missing project root for project-scoped Codex skill.",
    };
  }

  const root = opts.scope === "user" ? resolveHomeDir() : opts.projectRoot;
  if (!root) {
    return {
      ok: false,
      message: "HOME is not set; cannot resolve Codex skill path.",
    };
  }

  return {
    ok: true,
    path: resolve(root, SKILL_DIR, SKILL_NAME, SKILL_FILENAME),
  };
}

function resolveHomeDir(): string | null {
  const home = (process.env.HOME ?? "").trim();
  return home.length > 0 ? home : null;
}

function resolveInstallStatus(opts: {
  readonly changed: boolean;
  readonly existed: boolean;
}): "created" | "updated" | "noop" {
  if (!opts.changed) {
    return "noop";
  }
  return opts.existed ? "updated" : "created";
}
