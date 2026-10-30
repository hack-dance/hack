import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  AGENT_CLIENT_CAPABILITIES_REFERENCE_PATH,
  extractGeneratedSection,
  GENERATED_BEGIN,
  GENERATED_END,
  GeneratedSectionMarkerError,
  renderAgentClientCapabilitySection,
  replaceGeneratedSection,
} from "../scripts/generate-agent-client-capabilities.ts";
import {
  AGENT_CLIENT_CAPABILITIES,
  AGENT_CLIENT_CAPABILITY_MATRIX,
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
const referencePath = join(repoRoot, AGENT_CLIENT_CAPABILITIES_REFERENCE_PATH);

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
  | "manifest-disagreement"
  | "skills-package-declares-mcp";

/** A client's default `hack` (skills) and opt-in `hack-mcp` manifests. */
interface ClientManifests {
  readonly skills: Record<string, unknown>;
  readonly mcp: Record<string, unknown>;
}

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
  readonly manifests: Readonly<Record<string, ClientManifests>>;
  readonly exists: (repoRelativePath: string) => boolean;
}): ClassificationIssue[] {
  const issues: ClassificationIssue[] = [];
  for (const client of NATIVE_PLUGIN_CLIENTS) {
    if ("mcpServers" in (manifests[client]?.skills ?? {})) {
      issues.push({
        client,
        capability: "pluginMcp",
        code: "skills-package-declares-mcp",
      });
    }
  }
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
      const packages = manifests[cell.client];
      // Plugin MCP ships only in the opt-in hack-mcp package.
      const manifest =
        (cell.capability === "pluginMcp" ? packages?.mcp : packages?.skills) ??
        {};
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

async function readManifest(path: string): Promise<Record<string, unknown>> {
  const parsed: unknown = await Bun.file(join(repoRoot, path)).json();
  if (!isRecord(parsed)) {
    throw new Error(`Expected a manifest object: ${path}`);
  }
  return parsed;
}

async function loadManifests(): Promise<Record<string, ClientManifests>> {
  const manifests: Record<string, ClientManifests> = {};
  for (const definition of AGENT_CLIENT_DEFINITIONS) {
    manifests[definition.client] = {
      skills: await readManifest(definition.manifestPath),
      mcp: await readManifest(definition.mcpManifestPath),
    };
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
  expect("hooks" in (manifests.codex?.skills ?? {})).toBe(false);
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
    status: "untested",
    openGate: "Observe the selected client loading this capability.",
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

  const ungated = replaceCell("claude", "skillDiscovery", { openGate: null });
  expect(
    codesFor(
      classificationIssues({ cells: ungated, manifests, exists: repoExists }),
      "claude",
      "skillDiscovery"
    )
  ).toEqual(["open-gate-missing"]);
});

test("negative control: plugin MCP is classified from hack-mcp, never the skills package", async () => {
  const manifests = await loadManifests();
  for (const client of NATIVE_PLUGIN_CLIENTS) {
    expect("mcpServers" in (manifests[client]?.skills ?? {})).toBe(false);
    expect(manifests[client]?.mcp.mcpServers).toBe("./.mcp.json");
  }

  const claude = manifests.claude;
  if (!claude) {
    throw new Error("expected Claude manifests");
  }
  const readded = {
    ...manifests,
    claude: {
      ...claude,
      skills: { ...claude.skills, mcpServers: "./.mcp.json" },
    },
  };
  expect(
    codesFor(
      classificationIssues({
        cells: AGENT_CLIENT_CAPABILITY_MATRIX,
        manifests: readded,
        exists: repoExists,
      }),
      "claude",
      "pluginMcp"
    )
  ).toEqual(["skills-package-declares-mcp"]);

  const { mcpServers: _removed, ...withoutServer } = claude.mcp;
  const emptied = { ...manifests, claude: { ...claude, mcp: withoutServer } };
  expect(
    codesFor(
      classificationIssues({
        cells: AGENT_CLIENT_CAPABILITY_MATRIX,
        manifests: emptied,
        exists: repoExists,
      }),
      "claude",
      "pluginMcp"
    )
  ).toEqual(["manifest-disagreement"]);
});

test("committed reference section matches the generator output", async () => {
  const doc = await Bun.file(referencePath).text();
  expect(extractGeneratedSection(doc)).toBe(
    renderAgentClientCapabilitySection()
  );
  expect(
    replaceGeneratedSection({
      document: doc,
      section: renderAgentClientCapabilitySection(),
    })
  ).toBe(doc);
  expect(doc).toContain("bun run docs:agent-client-capabilities");
  expect(doc).toContain("## Companion-package layout decision");
  expect(doc).toContain("## Model-policy ownership");
  for (const owner of [
    "scripts/generate-agent-plugins.ts",
    "src/agents/instruction-source.ts",
    "src/mcp/bundle.ts",
  ]) {
    expect(doc).toContain(owner);
  }
  const packageJson: unknown = await Bun.file(
    join(repoRoot, "package.json")
  ).json();
  const scripts = isRecord(packageJson) ? packageJson.scripts : undefined;
  expect(
    isRecord(scripts) ? scripts["docs:agent-client-capabilities"] : undefined
  ).toBe("bun run scripts/generate-agent-client-capabilities.ts");
});

test("negative control: a reclassified cell makes the committed section stale", async () => {
  const doc = await Bun.file(referencePath).text();
  const reclassified = replaceCell("claude", "skillDiscovery", {
    status: "verified",
    openGate: null,
  });
  const rendered = renderAgentClientCapabilitySection({ cells: reclassified });
  expect(extractGeneratedSection(doc)).not.toBe(rendered);
  const rewritten = replaceGeneratedSection({
    document: doc,
    section: rendered,
  });
  expect(extractGeneratedSection(rewritten)).toBe(rendered);
  expect(rewritten.slice(0, doc.indexOf(GENERATED_BEGIN))).toBe(
    doc.slice(0, doc.indexOf(GENERATED_BEGIN))
  );
  expect(rewritten.slice(rewritten.indexOf(GENERATED_END))).toBe(
    doc.slice(doc.indexOf(GENERATED_END))
  );
});

test("generator refuses documents without exactly one ordered marker pair", () => {
  const section = renderAgentClientCapabilitySection();
  const codeFor = (document: string): string | null => {
    try {
      replaceGeneratedSection({ document, section });
      return null;
    } catch (error) {
      return error instanceof GeneratedSectionMarkerError
        ? error.code
        : "other";
    }
  };
  expect(codeFor("# Title\n")).toBe("missing-markers");
  expect(codeFor(`${GENERATED_BEGIN}\n`)).toBe("missing-markers");
  expect(
    codeFor(
      `${GENERATED_BEGIN}\n${GENERATED_END}\n${GENERATED_BEGIN}\n${GENERATED_END}\n`
    )
  ).toBe("duplicate-markers");
  expect(codeFor(`${GENERATED_END}\n${GENERATED_BEGIN}\n`)).toBe(
    "markers-out-of-order"
  );
  expect(codeFor(`a\n${GENERATED_BEGIN}\nold\n${GENERATED_END}\nb\n`)).toBe(
    null
  );
});
