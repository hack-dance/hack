/**
 * Render a concise CLI-first primer for coding agents.
 */
export function renderAgentPrimer(): string {
  const lines = [
    "# hack CLI primer",
    "",
    "Use hack CLI for local dev when shell access is available. Prefer CLI over MCP.",
    "",
    "Quick start:",
    "- Start services: `hack up --detach`",
    "- Open app: `hack open --json`",
    "- Tail logs: `hack logs --pretty`",
    "- Snapshot logs: `hack logs --json --no-follow`",
    "- Run command: `hack run <service> <cmd...>`",
    "- Stop services: `hack down`",
    "",
    "Branch instances (parallel envs):",
    "- `hack up --branch <name> --detach`",
    "- `hack open --branch <name>`",
    "- `hack logs --branch <name>`",
    "- `hack down --branch <name>`",
    "",
    "Logs:",
    "- Loki history: `hack logs --loki --since 2h --pretty`",
    "- Force compose: `hack logs --compose`",
    "",
    "Project targeting:",
    "- Run from repo root, or use `--project <name>` / `--path <repo-root>`.",
    "",
    "Init assistance:",
    "- Generate init prompt: `hack agent init`",
    "- Patterns checklist: `hack agent patterns`",
    "",
    "MCP:",
    "- Use MCP only when no shell access. Install via `hack setup mcp`.",
    "",
  ];

  return lines.join("\n");
}
