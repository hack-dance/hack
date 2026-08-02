import { renderInstructionSections } from "./instruction-source.ts";

/**
 * Render the `hack-cli` skill bundled by the official Hack agent plugins.
 *
 * The committed plugin copy is generated from this function so the plugin,
 * CLI release, and other agent-facing surfaces share one instruction source.
 */
export function renderCodexSkill(): string {
  return [
    "---",
    "name: hack-cli",
    "description: >",
    "  Use the hack CLI for local runtime orchestration (compose, DNS/TLS, logs, env, persistent project workspaces) and agent setup.",
    "  Trigger when asked to run/start/stop services, inspect logs, manage lifecycle/workspace workflows, or update",
    "  agent integrations. Prefer CLI over MCP when shell access is available.",
    "---",
    "",
    "# hack CLI",
    "",
    "Use `hack` as the primary interface for local-first development.",
    "",
    renderInstructionSections({ surface: "skill", headingStyle: "markdown" }),
    "",
  ].join("\n");
}
