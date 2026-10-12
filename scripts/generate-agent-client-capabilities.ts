import { resolve } from "node:path";

import {
  AGENT_CLIENT_CAPABILITIES,
  AGENT_CLIENT_CAPABILITY_DEFINITIONS,
  AGENT_CLIENT_CAPABILITY_MATRIX,
  AGENT_CLIENT_CAPABILITY_MATRIX_VERSION,
  AGENT_CLIENT_CAPABILITY_OBSERVED_ON,
  AGENT_CLIENT_DEFINITIONS,
  AGENT_CLIENTS,
  type AgentClient,
  type AgentClientCapability,
  type ClientCapabilityCell,
} from "../src/agents/client-capabilities.ts";

/**
 * Renders the generated section of docs/reference/agent-client-capabilities.md
 * from src/agents/client-capabilities.ts.
 *
 * Run `bun run docs:agent-client-capabilities` to rewrite the section in place,
 * or add `--check` to exit non-zero when the committed section is stale.
 * tests/agent-client-capabilities.test.ts fails on the same drift. Only the
 * text between the markers is generated; the surrounding prose is hand-written.
 */

export const AGENT_CLIENT_CAPABILITIES_REFERENCE_PATH =
  "docs/reference/agent-client-capabilities.md";
export const GENERATED_BEGIN =
  "<!-- BEGIN GENERATED: agent-client-capabilities -->";
export const GENERATED_END =
  "<!-- END GENERATED: agent-client-capabilities -->";

/** Closed failure codes; messages never include document content or paths. */
export type GeneratedSectionError =
  | "missing-markers"
  | "duplicate-markers"
  | "markers-out-of-order";

const GENERATED_SECTION_ERROR_MESSAGES: Readonly<
  Record<GeneratedSectionError, string>
> = {
  "missing-markers": "The reference doc is missing a generated-section marker.",
  "duplicate-markers":
    "The reference doc has more than one generated-section marker pair.",
  "markers-out-of-order":
    "The reference doc's generated-section end marker precedes its start marker.",
};

export class GeneratedSectionMarkerError extends Error {
  readonly code: GeneratedSectionError;

  constructor(code: GeneratedSectionError) {
    super(GENERATED_SECTION_ERROR_MESSAGES[code]);
    this.name = "GeneratedSectionMarkerError";
    this.code = code;
  }
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function clientLabel(client: AgentClient): string {
  return (
    AGENT_CLIENT_DEFINITIONS.find((definition) => definition.client === client)
      ?.label ?? client
  );
}

function capabilityLabel(capability: AgentClientCapability): string {
  return (
    AGENT_CLIENT_CAPABILITY_DEFINITIONS.find(
      (definition) => definition.capability === capability
    )?.label ?? capability
  );
}

function renderCellRow(cell: ClientCapabilityCell): string {
  return [
    "",
    cell.client,
    capabilityLabel(cell.capability),
    cell.status,
    cell.evidenceClass,
    `\`${cell.evidenceRef}\``,
    escapeCell(cell.observedClientVersion ?? "none"),
    `\`${cell.hostLabel}\``,
    `\`${cell.sourceSha.slice(0, 12)}\``,
    escapeCell(cell.note),
    escapeCell(cell.openGate ?? "none"),
    "",
  ]
    .join(" | ")
    .trim();
}

/** Renders the generated section, markers included, from the given cells. */
export function renderAgentClientCapabilitySection({
  cells = AGENT_CLIENT_CAPABILITY_MATRIX,
}: {
  readonly cells?: readonly ClientCapabilityCell[];
} = {}): string {
  const lines = [
    GENERATED_BEGIN,
    "",
    `Matrix version ${AGENT_CLIENT_CAPABILITY_MATRIX_VERSION}, observed ${AGENT_CLIENT_CAPABILITY_OBSERVED_ON}.`,
    "",
    "### Clients",
    "",
    "| Client | Manifest |",
    "| --- | --- |",
    ...AGENT_CLIENT_DEFINITIONS.map(
      (definition) =>
        `| ${escapeCell(definition.label)} | \`${definition.manifestPath}\` |`
    ),
    "",
    "### Capabilities",
    "",
    "| Capability | Meaning |",
    "| --- | --- |",
    ...AGENT_CLIENT_CAPABILITY_DEFINITIONS.map(
      (definition) =>
        `| ${definition.label} | ${escapeCell(definition.meaning)} |`
    ),
    "",
    "### Status summary",
    "",
    `| Capability | ${AGENT_CLIENTS.map(clientLabel).map(escapeCell).join(" | ")} |`,
    `| --- | ${AGENT_CLIENTS.map(() => "---").join(" | ")} |`,
    ...AGENT_CLIENT_CAPABILITIES.map((capability) => {
      const statuses = AGENT_CLIENTS.map(
        (client) =>
          cells.find(
            (cell) => cell.client === client && cell.capability === capability
          )?.status ?? "missing"
      );
      return `| ${capabilityLabel(capability)} | ${statuses.join(" | ")} |`;
    }),
    "",
    "### Cells",
    "",
    "| Client | Capability | Status | Evidence class | Evidence | Client version | Host | Source | Note | Open gate |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...cells.map(renderCellRow),
    "",
    GENERATED_END,
  ];
  return lines.join("\n");
}

function markerRange(document: string): { start: number; end: number } {
  const start = document.indexOf(GENERATED_BEGIN);
  const end = document.indexOf(GENERATED_END);
  if (start < 0 || end < 0) {
    throw new GeneratedSectionMarkerError("missing-markers");
  }
  if (
    document.indexOf(GENERATED_BEGIN, start + 1) >= 0 ||
    document.indexOf(GENERATED_END, end + 1) >= 0
  ) {
    throw new GeneratedSectionMarkerError("duplicate-markers");
  }
  if (end < start) {
    throw new GeneratedSectionMarkerError("markers-out-of-order");
  }
  return { start, end: end + GENERATED_END.length };
}

/** Returns the committed generated section, markers included. */
export function extractGeneratedSection(document: string): string {
  const { start, end } = markerRange(document);
  return document.slice(start, end);
}

/** Replaces the generated section, keeping all hand-written prose intact. */
export function replaceGeneratedSection({
  document,
  section,
}: {
  readonly document: string;
  readonly section: string;
}): string {
  const { start, end } = markerRange(document);
  return document.slice(0, start) + section + document.slice(end);
}

async function main(): Promise<void> {
  const check = process.argv.slice(2).includes("--check");
  const docPath = resolve(
    import.meta.dir,
    "..",
    AGENT_CLIENT_CAPABILITIES_REFERENCE_PATH
  );
  const document = await Bun.file(docPath).text();
  const next = replaceGeneratedSection({
    document,
    section: renderAgentClientCapabilitySection(),
  });
  if (check) {
    if (next !== document) {
      process.stderr.write(
        "The agent client capability reference is stale. Run `bun run docs:agent-client-capabilities`.\n"
      );
      process.exit(1);
    }
    process.stdout.write("agent client capability reference is current\n");
    return;
  }
  if (next === document) {
    process.stdout.write("agent client capability reference is current\n");
    return;
  }
  await Bun.write(docPath, next);
  process.stdout.write(`wrote ${AGENT_CLIENT_CAPABILITIES_REFERENCE_PATH}\n`);
}

if (import.meta.main) {
  await main();
}
