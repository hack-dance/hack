import type { AnyCommandSpec, CliSpec } from "./command.ts";
import { JSON_COMMAND_SHAPES, SCHEMA_JSON_VARIANTS } from "./json-contracts.ts";

export function jsonCommandPaths(cli: CliSpec): readonly string[] {
  const out: string[] = [];
  function visit(command: AnyCommandSpec, parents: readonly string[]): void {
    const path = [...parents, command.name];
    if (command.options.some((option) => option.name === "json")) {
      out.push(path.join(" "));
    }
    for (const child of command.subcommands) {
      visit(child, path);
    }
  }
  for (const command of cli.commands) {
    visit(command, []);
  }
  return out.sort();
}

const SHAPES: Record<
  (typeof JSON_COMMAND_SHAPES)[keyof typeof JSON_COMMAND_SHAPES],
  string
> = {
  "schema-envelope": "Envelope; versioned `data.schema`",
  envelope:
    "Envelope (`ok`, `data` / `error`); legacy payload has no required schema",
  "legacy-object": "Legacy bare object (no `data` envelope)",
  "legacy-result":
    "Legacy result (`ok` plus fields, no `data`; error may be a string)",
  "backend-dependent": "Backend-dependent: envelope or legacy bare object",
  ndjson: "NDJSON events / terminal event, not a single envelope",
  logs: "NDJSON logs; finite native modes may return a legacy snapshot object",
  transport:
    "Native compiler protocol object (`transport_version`, `ok`, result / diagnostics)",
  "error-only": "Retired: usage-error envelope, no success payload",
};

export function renderJsonInventory(cli: CliSpec): string {
  const rows = jsonCommandPaths(cli).map((command) => {
    const kind =
      JSON_COMMAND_SHAPES[command as keyof typeof JSON_COMMAND_SHAPES];
    if (kind === undefined) {
      throw new Error(`Missing JSON shape decision: ${command}`);
    }
    const variant = SCHEMA_JSON_VARIANTS.find(
      (entry) => entry.command === command && kind === "schema-envelope"
    );
    const flags = variant?.flags.join(" ") ?? "";
    return `| \`hack ${command}${flags ? ` ${flags}` : ""} --json\` | ${SHAPES[kind]}${variant ? `: \`${variant.schema}\`` : ""} |`;
  });
  for (const variant of SCHEMA_JSON_VARIANTS.filter(
    (entry) => entry.command === "projects" || entry.command === "global status"
  )) {
    rows.push(
      `| \`hack ${variant.command} --json ${variant.flags.join(" ")}\` | Envelope; \`data.schema: ${variant.schema}\` |`
    );
  }
  return [
    "| Canonical command / variant | Success shape |",
    "|---|---|",
    ...rows,
    "",
  ].join("\n");
}
