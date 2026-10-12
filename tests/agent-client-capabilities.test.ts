import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

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
  EVIDENCE_CLASSES,
  type EvidenceClass,
} from "../src/agents/client-capabilities.ts";
import { isRecord } from "../src/lib/guards.ts";

const repoRoot = join(import.meta.dir, "..");
const referencePath = join(
  repoRoot,
  "docs",
  "reference",
  "agent-client-capabilities.md"
);

type IssueCode =
  | "missing-cell"
  | "duplicate-cell"
  | "missing-evidence-ref"
  | "invalid-source-sha"
  | "missing-host-label"
  | "missing-client-version"
  | "open-gate-missing"
  | "verified-without-test"
  | "verified-below-fixture"
  | "verified-on-manifest-or-listing"
  | "verified-with-open-gate"
  | "manifest-disagreement";

interface ClassificationIssue {
  readonly client: AgentClient;
  readonly capability: AgentClientCapability;
  readonly code: IssueCode;
}

/** Manifest key that declares each plugin component for the named clients. */
const MANIFEST_COMPONENT_KEYS: Partial<Record<AgentClientCapability, string>> =
  {
    skillDiscovery: "skills",
    hooks: "hooks",
    pluginMcp: "mcpServers",
    rules: "rules",
    ui: "interface",
  };

const NATIVE_PLUGIN_CLIENTS: readonly AgentClient[] = [
  "codex",
  "claude",
  "cursor",
];

function evidenceStrength(evidenceClass: EvidenceClass): number {
  return EVIDENCE_CLASSES.indexOf(evidenceClass);
}

/** Manifests, shipped component files and marketplace listings describe a
 * package; they never show that a client loaded a component. */
function isManifestOrListingRef(ref: string): boolean {
  const name = ref.split("/").at(-1) ?? ref;
  return (
    ref.startsWith("plugins/") ||
    ref.includes("marketplace") ||
    ["plugin.json", "mcp.json", ".mcp.json", "marketplace.json"].includes(
      name
    ) ||
    name.endsWith(".mdc") ||
    name === "SKILL.md"
  );
}

function classificationIssues({
  cells,
  manifests,
  exists,
}: {
  readonly cells: readonly ClientCapabilityCell[];
  readonly manifests: Readonly<Record<string, Record<string, unknown>>>;
  readonly exists: (repoRelativePath: string) => boolean;
}): ClassificationIssue[] {
  const issues: ClassificationIssue[] = [];
  for (const client of AGENT_CLIENTS) {
    for (const capability of AGENT_CLIENT_CAPABILITIES) {
      const matches = cells.filter(
        (cell) => cell.client === client && cell.capability === capability
      );
      if (matches.length === 0) {
        issues.push({ client, capability, code: "missing-cell" });
      } else if (matches.length > 1) {
        issues.push({ client, capability, code: "duplicate-cell" });
      }
    }
  }
  for (const cell of cells) {
    const report = (code: IssueCode) =>
      issues.push({ client: cell.client, capability: cell.capability, code });
    if (!(cell.evidenceRef && exists(cell.evidenceRef))) {
      report("missing-evidence-ref");
    }
    if (!/^[0-9a-f]{40}$/.test(cell.sourceSha)) {
      report("invalid-source-sha");
    }
    if (cell.hostLabel.trim() === "") {
      report("missing-host-label");
    }
    if (cell.client !== "standalone" && !cell.observedClientVersion) {
      report("missing-client-version");
    }
    if (cell.status === "untested" && !cell.openGate?.trim()) {
      report("open-gate-missing");
    }
    if (cell.status === "verified") {
      if (
        !(
          /^tests\/.+\.test\.ts$/.test(cell.evidenceRef) &&
          exists(cell.evidenceRef)
        )
      ) {
        report("verified-without-test");
      }
      if (
        evidenceStrength(cell.evidenceClass) <
        evidenceStrength("isolated-fixture")
      ) {
        report("verified-below-fixture");
      }
      if (isManifestOrListingRef(cell.evidenceRef)) {
        report("verified-on-manifest-or-listing");
      }
      if (cell.openGate !== null) {
        report("verified-with-open-gate");
      }
      if (!cell.observedClientVersion) {
        report("missing-client-version");
      }
    }
    if (NATIVE_PLUGIN_CLIENTS.includes(cell.client)) {
      const manifest = manifests[cell.client] ?? {};
      const key = MANIFEST_COMPONENT_KEYS[cell.capability];
      const declared =
        cell.capability === "packaging"
          ? Object.keys(manifest).length > 0
          : key !== undefined && key in manifest;
      if (
        (key !== undefined || cell.capability === "packaging") &&
        (cell.status === "unsupported") === declared
      ) {
        report("manifest-disagreement");
      }
    }
  }
  return issues;
}

async function loadManifests(): Promise<
  Record<string, Record<string, unknown>>
> {
  const manifests: Record<string, Record<string, unknown>> = {};
  for (const definition of AGENT_CLIENT_DEFINITIONS) {
    const parsed: unknown = await Bun.file(
      join(repoRoot, definition.manifestPath)
    ).json();
    if (!isRecord(parsed)) {
      throw new Error(`Expected a manifest object: ${definition.manifestPath}`);
    }
    manifests[definition.client] = parsed;
  }
  return manifests;
}

const repoExists = (path: string) => existsSync(join(repoRoot, path));

function replaceCell(
  client: AgentClient,
  capability: AgentClientCapability,
  change: Partial<ClientCapabilityCell>
): ClientCapabilityCell[] {
  return AGENT_CLIENT_CAPABILITY_MATRIX.map((cell) =>
    cell.client === client && cell.capability === capability
      ? { ...cell, ...change }
      : cell
  );
}

function codesFor(
  issues: readonly ClassificationIssue[],
  client: AgentClient,
  capability: AgentClientCapability
): IssueCode[] {
  return issues
    .filter(
      (issue) => issue.client === client && issue.capability === capability
    )
    .map((issue) => issue.code);
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

const GENERATED_BEGIN = "<!-- BEGIN GENERATED: agent-client-capabilities -->";
const GENERATED_END = "<!-- END GENERATED: agent-client-capabilities -->";

function renderGeneratedSection(): string {
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
          AGENT_CLIENT_CAPABILITY_MATRIX.find(
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
    ...AGENT_CLIENT_CAPABILITY_MATRIX.map((cell) =>
      [
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
        .trim()
    ),
    "",
    GENERATED_END,
  ];
  return lines.join("\n");
}

test("every client and capability pair is classified with complete evidence", async () => {
  expect(AGENT_CLIENT_CAPABILITY_MATRIX).toHaveLength(
    AGENT_CLIENTS.length * AGENT_CLIENT_CAPABILITIES.length
  );
  const issues = classificationIssues({
    cells: AGENT_CLIENT_CAPABILITY_MATRIX,
    manifests: await loadManifests(),
    exists: repoExists,
  });
  expect(issues).toEqual([]);
});

test("verified cells require an existing fixture-strength test file", async () => {
  const manifests = await loadManifests();
  const accepted = replaceCell("codex", "standaloneMcp", {
    status: "verified",
    evidenceClass: "isolated-fixture",
    evidenceRef: "tests/mcp-bundle-client.test.ts",
    openGate: null,
  });
  expect(
    classificationIssues({ cells: accepted, manifests, exists: repoExists })
  ).toEqual([]);

  const missingTest = replaceCell("codex", "standaloneMcp", {
    status: "verified",
    evidenceClass: "isolated-fixture",
    evidenceRef: "tests/does-not-exist.test.ts",
    openGate: null,
  });
  expect(
    codesFor(
      classificationIssues({
        cells: missingTest,
        manifests,
        exists: repoExists,
      }),
      "codex",
      "standaloneMcp"
    )
  ).toEqual(["missing-evidence-ref", "verified-without-test"]);

  const weakClass = replaceCell("codex", "standaloneMcp", {
    status: "verified",
    evidenceClass: "schema",
    evidenceRef: "tests/mcp-install.test.ts",
    openGate: null,
  });
  expect(
    codesFor(
      classificationIssues({ cells: weakClass, manifests, exists: repoExists }),
      "codex",
      "standaloneMcp"
    )
  ).toEqual(["verified-below-fixture"]);
});

test("negative control: plugin skills verified on manifest-only evidence fail", async () => {
  const manifests = await loadManifests();
  const cells = replaceCell("claude", "skillDiscovery", {
    status: "verified",
    evidenceClass: "isolated-fixture",
    evidenceRef: "plugins/hack/.claude-plugin/plugin.json",
    openGate: null,
  });
  expect(
    codesFor(
      classificationIssues({ cells, manifests, exists: repoExists }),
      "claude",
      "skillDiscovery"
    )
  ).toEqual(["verified-without-test", "verified-on-manifest-or-listing"]);

  const listing = replaceCell("cursor", "packaging", {
    status: "verified",
    evidenceClass: "authenticated-session",
    evidenceRef: ".claude-plugin/marketplace.json",
    openGate: null,
  });
  expect(
    codesFor(
      classificationIssues({
        cells: listing,
        manifests,
        exists: () => true,
      }),
      "cursor",
      "packaging"
    )
  ).toEqual(["verified-without-test", "verified-on-manifest-or-listing"]);
});

test("manifest-declared components agree with the matrix", async () => {
  const manifests = await loadManifests();
  expect("hooks" in (manifests.codex ?? {})).toBe(false);
  const codexHooks = replaceCell("codex", "hooks", {
    status: "verified",
    evidenceClass: "isolated-fixture",
    evidenceRef: "tests/mcp-bundle-client.test.ts",
    openGate: null,
  });
  expect(
    codesFor(
      classificationIssues({
        cells: codexHooks,
        manifests,
        exists: repoExists,
      }),
      "codex",
      "hooks"
    )
  ).toEqual(["manifest-disagreement"]);

  const hiddenRules = replaceCell("cursor", "rules", {
    status: "unsupported",
    openGate: null,
  });
  expect(
    codesFor(
      classificationIssues({
        cells: hiddenRules,
        manifests,
        exists: repoExists,
      }),
      "cursor",
      "rules"
    )
  ).toEqual(["manifest-disagreement"]);

  const missing = AGENT_CLIENT_CAPABILITY_MATRIX.filter(
    (cell) => !(cell.client === "claude" && cell.capability === "ui")
  );
  expect(
    codesFor(
      classificationIssues({ cells: missing, manifests, exists: repoExists }),
      "claude",
      "ui"
    )
  ).toEqual(["missing-cell"]);

  const ungated = replaceCell("claude", "hooks", { openGate: null });
  expect(
    codesFor(
      classificationIssues({ cells: ungated, manifests, exists: repoExists }),
      "claude",
      "hooks"
    )
  ).toEqual(["open-gate-missing"]);
});

test("reference doc matches the matrix and records ownership decisions", async () => {
  const doc = await Bun.file(referencePath).text();
  const start = doc.indexOf(GENERATED_BEGIN);
  const end = doc.indexOf(GENERATED_END);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  expect(doc.slice(start, end + GENERATED_END.length)).toBe(
    renderGeneratedSection()
  );
  expect(doc).toContain("## Companion-package layout decision");
  expect(doc).toContain("## Model-policy ownership");
  for (const owner of [
    "scripts/generate-agent-plugins.ts",
    "src/agents/instruction-source.ts",
    "src/mcp/bundle.ts",
  ]) {
    expect(doc).toContain(owner);
  }
});
