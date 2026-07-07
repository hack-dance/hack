import type { AnyCommandSpec, CliGroup, CliSpec } from "./command.ts";
import { renderHelpMarkdownForPath } from "./help.ts";

const GROUP_ORDER: readonly CliGroup[] = [
  "Project",
  "Global",
  "Diagnostics",
  "Agents",
  "Secrets",
  "Integrations",
  "Extensions",
  "Fun",
  "Beta",
  "Internal",
];

const GROUP_HEADINGS: Readonly<Record<CliGroup, string>> = {
  Project: "Project",
  Global: "Global infrastructure",
  Diagnostics: "Diagnostics",
  Agents: "Agents",
  Secrets: "Secrets & env",
  Integrations: "Integrations",
  Extensions: "Extensions",
  Fun: "Fun",
  Beta: "Experimental (unsupported)",
  Internal: "Internal",
};

/**
 * Renders the full generated CLI reference for the docs site from a CLI spec.
 *
 * Supported commands get a full markdown section (including one level of
 * subcommands); Beta-group commands are listed but not expanded — they are
 * outside the supported v3 product contract and hidden from default help.
 * Output is deterministic and version-free so the committed file only changes
 * when the CLI surface changes (enforced by tests/cli-reference-docs.test.ts).
 */
export function renderCliReferenceMarkdown(opts: {
  readonly cli: CliSpec;
}): string {
  const lines: string[] = [
    "# hack CLI reference",
    "",
    "<!-- GENERATED FILE — do not edit. Regenerate with: bun run docs:cli-reference -->",
    "",
    `${opts.cli.name} — ${opts.cli.summary}`,
    "",
    "Run `hack help <command>` for the same content in the terminal. Global options: `--no-interactive` (or `HACK_NO_INTERACTIVE=1`); commands with `--json` emit a `{ok, data, error}` envelope on stdout.",
    "",
  ];

  const byGroup = groupCommands({ commands: opts.cli.commands });

  for (const group of GROUP_ORDER) {
    const commands = byGroup.get(group);
    if (!commands || commands.length === 0) {
      continue;
    }
    lines.push(`## ${GROUP_HEADINGS[group]}`, "");
    if (group === "Beta") {
      lines.push(
        "These commands are source-available but outside the supported v3 product contract. They are hidden from default `hack --help` (see them with `hack help --all`) and print a warning when invoked.",
        ""
      );
      for (const command of commands) {
        lines.push(`- \`hack ${command.name}\` — ${command.summary}`);
      }
      lines.push("");
      continue;
    }
    for (const command of commands) {
      lines.push(renderCommandSection({ cli: opts.cli, command }));
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function groupCommands(opts: {
  readonly commands: readonly AnyCommandSpec[];
}): Map<CliGroup, AnyCommandSpec[]> {
  const byGroup = new Map<CliGroup, AnyCommandSpec[]>();
  for (const command of opts.commands) {
    const existing = byGroup.get(command.group) ?? [];
    existing.push(command);
    byGroup.set(command.group, existing);
  }
  return byGroup;
}

function renderCommandSection(opts: {
  readonly cli: CliSpec;
  readonly command: AnyCommandSpec;
}): string {
  const sections: string[] = [
    renderHelpMarkdownForPath(opts.cli, [opts.command.name]),
  ];
  for (const sub of opts.command.subcommands) {
    sections.push(
      renderHelpMarkdownForPath(opts.cli, [opts.command.name, sub.name])
    );
  }
  return `${sections.join("\n")}\n`;
}
