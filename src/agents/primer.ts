import { renderInstructionSections } from "./instruction-source.ts";

/**
 * Render a concise CLI-first primer for coding agents.
 *
 * Content is the `primer`-tagged subset of the shared instruction source so
 * the primer can never drift from the fuller docs/skill/rules surfaces.
 */
export function renderAgentPrimer(): string {
  const lines = [
    "# hack CLI primer",
    "",
    "Use the `hack` CLI for local-first dev when shell access is available. Prefer CLI over MCP.",
    "",
    renderInstructionSections({ surface: "primer", headingStyle: "plain" }),
    "",
  ];

  return lines.join("\n");
}
