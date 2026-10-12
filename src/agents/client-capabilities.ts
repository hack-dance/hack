/**
 * Versioned agent-client capability matrix for Hack's optional agent
 * integrations. This module is data only.
 *
 * Invariants, enforced by tests/agent-client-capabilities.test.ts:
 * - Every client x capability pair has exactly one cell.
 * - A `verified` cell names an existing test file whose evidence class is
 *   `isolated-fixture` or stronger. A manifest parse, schema check or
 *   marketplace listing is never component-loading evidence.
 * - For the named native-plugin clients, a component is `unsupported` exactly
 *   when that client's plugin manifest does not declare it. Plugin MCP is read
 *   from the opt-in `hack-mcp` manifest; the default `hack` skills manifest
 *   never declares MCP.
 * - docs/reference/agent-client-capabilities.md matches this data; rewrite its
 *   generated section with `bun run docs:agent-client-capabilities`.
 *
 * Each cell records the client version, host label and source revision at
 * which it was classified. Those values describe one observation on one host;
 * they are not a cross-machine or long-term compatibility claim, and a status
 * for one client implies nothing about another client's UI or loading behavior.
 */

/** Increment when cells are reclassified or the cell shape changes. */
export const AGENT_CLIENT_CAPABILITY_MATRIX_VERSION = 2;

/** Date (UTC) of the observations recorded below. */
export const AGENT_CLIENT_CAPABILITY_OBSERVED_ON = "2026-10-11";

export const AGENT_CLIENTS = [
  "codex",
  "claude",
  "cursor",
  "standalone",
] as const;
export type AgentClient = (typeof AGENT_CLIENTS)[number];

export const AGENT_CLIENT_CAPABILITIES = [
  "packaging",
  "skillDiscovery",
  "hooks",
  "pluginMcp",
  "standaloneMcp",
  "rules",
  "ui",
] as const;
export type AgentClientCapability = (typeof AGENT_CLIENT_CAPABILITIES)[number];

export type CapabilityStatus = "verified" | "untested" | "unsupported";

/**
 * Evidence classes, weakest first. `source-read` and `schema` describe files
 * Hack ships; only `isolated-fixture` and `authenticated-session` observe a
 * client loading a component.
 */
export const EVIDENCE_CLASSES = [
  "source-read",
  "schema",
  "isolated-fixture",
  "authenticated-session",
] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

export interface AgentClientDefinition {
  readonly client: AgentClient;
  readonly label: string;
  /** Repository-relative manifest of the default `hack` (skills) plugin. */
  readonly manifestPath: string;
  /** Repository-relative manifest of the opt-in `hack-mcp` plugin. */
  readonly mcpManifestPath: string;
}

export interface AgentClientCapabilityDefinition {
  readonly capability: AgentClientCapability;
  readonly label: string;
  readonly meaning: string;
}

export interface ClientCapabilityCell {
  readonly client: AgentClient;
  readonly capability: AgentClientCapability;
  readonly status: CapabilityStatus;
  readonly evidenceClass: EvidenceClass;
  /** Repository-relative file that carries the evidence. */
  readonly evidenceRef: string;
  /** Installed client version observed during classification, if any. */
  readonly observedClientVersion: string | null;
  /** Commit of the Hack source that was classified. */
  readonly sourceSha: string;
  /** Non-identifying label of the host that produced the observation. */
  readonly hostLabel: string;
  readonly note: string;
  /** Proof still required before the cell can be `verified`; null if none. */
  readonly openGate: string | null;
}

export const AGENT_CLIENT_DEFINITIONS: readonly AgentClientDefinition[] = [
  {
    client: "codex",
    label: "Codex",
    manifestPath: "plugins/hack/.codex-plugin/plugin.json",
    mcpManifestPath: "plugins/hack-mcp/.codex-plugin/plugin.json",
  },
  {
    client: "claude",
    label: "Claude Code",
    manifestPath: "plugins/hack/.claude-plugin/plugin.json",
    mcpManifestPath: "plugins/hack-mcp/.claude-plugin/plugin.json",
  },
  {
    client: "cursor",
    label: "Cursor",
    manifestPath: "plugins/hack/.cursor-plugin/plugin.json",
    mcpManifestPath: "plugins/hack-mcp/.cursor-plugin/plugin.json",
  },
  {
    client: "standalone",
    label: "Standalone (portable manifest or generic stdio MCP client)",
    manifestPath: "plugins/hack/plugin.json",
    mcpManifestPath: "plugins/hack-mcp/plugin.json",
  },
];

export const AGENT_CLIENT_CAPABILITY_DEFINITIONS: readonly AgentClientCapabilityDefinition[] =
  [
    {
      capability: "packaging",
      label: "Packaging",
      meaning:
        "The client accepts, installs and enables the default `hack` plugin package in a session.",
    },
    {
      capability: "skillDiscovery",
      label: "Skill discovery",
      meaning:
        "A fresh session discovers the plugin's bundled skills (hack-cli, hack-branches, hack-env, hack-diagnose, hack-init, hack-install, hack-remote).",
    },
    {
      capability: "hooks",
      label: "Hooks",
      meaning:
        "The client runs plugin-shipped hooks; Hack hooks may only run `hack agent prime`.",
    },
    {
      capability: "pluginMcp",
      label: "Plugin MCP",
      meaning:
        "The client starts the `hack mcp serve` server declared by the opt-in `hack-mcp` plugin and lists its tools. The default `hack` plugin ships no MCP.",
    },
    {
      capability: "standaloneMcp",
      label: "Standalone MCP",
      meaning:
        "The client loads an MCP entry written by `hack mcp install` (stdio or a selected MCP bundle) without the plugin.",
    },
    {
      capability: "rules",
      label: "Rules",
      meaning: "The client loads a plugin-shipped rule file.",
    },
    {
      capability: "ui",
      label: "UI",
      meaning:
        "The client renders plugin presentation metadata (display name, default prompts, brand color).",
    },
  ];

const SOURCE_SHA = "ec56769bdc046f5b64e621eb04613cfb00a65ced";
/** Base of the change that moved plugin MCP into the `hack-mcp` package. */
const MCP_PACKAGE_SOURCE_SHA = "3e261d517ed78fbf55c786682ee95291021cba63";
const MCP_PACKAGE_NOTE =
  "The opt-in `hack-mcp` manifest points `mcpServers` at `.mcp.json` (`hack mcp serve`); the default `hack` plugin declares no MCP. No plugin session started the server.";
const HOST = "macos-arm64-contributor";
const CODEX_VERSION = "codex-cli 0.162.1";
const CLAUDE_VERSION = "Claude Code 2.1.296";
const CURSOR_VERSION = "Cursor 3.24.12";
const BUNDLE_FIXTURE = "tests/mcp-bundle-client.test.ts";

const PLUGIN_LOAD_GATE =
  "Install the plugin into an isolated client home, start a fresh session and observe the component load; a marketplace listing or manifest parse does not count.";

export const AGENT_CLIENT_CAPABILITY_MATRIX: readonly ClientCapabilityCell[] = [
  // Codex
  {
    client: "codex",
    capability: "packaging",
    status: "untested",
    evidenceClass: "schema",
    evidenceRef: "plugins/hack/.codex-plugin/plugin.json",
    observedClientVersion: CODEX_VERSION,
    sourceSha: SOURCE_SHA,
    hostLabel: HOST,
    note: "Manifest is generated and parsed by tests/agent-plugin-generation.test.ts; no client installed it.",
    openGate: PLUGIN_LOAD_GATE,
  },
  {
    client: "codex",
    capability: "skillDiscovery",
    status: "untested",
    evidenceClass: "schema",
    evidenceRef: "plugins/hack/.codex-plugin/plugin.json",
    observedClientVersion: CODEX_VERSION,
    sourceSha: SOURCE_SHA,
    hostLabel: HOST,
    note: "Manifest declares `skills: ./skills/`; skill content matches the canonical renderers.",
    openGate: PLUGIN_LOAD_GATE,
  },
  {
    client: "codex",
    capability: "hooks",
    status: "unsupported",
    evidenceClass: "source-read",
    evidenceRef: "plugins/hack/.codex-plugin/plugin.json",
    observedClientVersion: CODEX_VERSION,
    sourceSha: SOURCE_SHA,
    hostLabel: HOST,
    note: "Hack ships no Codex plugin hooks; the manifest declares no `hooks` key. This says nothing about Codex's own hook support.",
    openGate: null,
  },
  {
    client: "codex",
    capability: "pluginMcp",
    status: "untested",
    evidenceClass: "schema",
    evidenceRef: "plugins/hack-mcp/.mcp.json",
    observedClientVersion: CODEX_VERSION,
    sourceSha: MCP_PACKAGE_SOURCE_SHA,
    hostLabel: HOST,
    note: MCP_PACKAGE_NOTE,
    openGate: PLUGIN_LOAD_GATE,
  },
  {
    client: "codex",
    capability: "standaloneMcp",
    status: "untested",
    evidenceClass: "isolated-fixture",
    evidenceRef: BUNDLE_FIXTURE,
    observedClientVersion: CODEX_VERSION,
    sourceSha: SOURCE_SHA,
    hostLabel: HOST,
    note: "In the opt-in fixture, `codex mcp get hack --json` resolved the generated bundle adapter from an isolated CODEX_HOME. The fixture then stopped at the Claude step, so no tool call was observed in that run. Configuration discovery alone does not prove a Codex model session loaded the server or accepted project trust.",
    openGate:
      "Pass tests/mcp-bundle-client.test.ts end to end at this client version; a Codex model session tool call remains a separate authenticated-session gate.",
  },
  {
    client: "codex",
    capability: "rules",
    status: "unsupported",
    evidenceClass: "source-read",
    evidenceRef: "plugins/hack/.codex-plugin/plugin.json",
    observedClientVersion: CODEX_VERSION,
    sourceSha: SOURCE_SHA,
    hostLabel: HOST,
    note: "Hack ships no Codex plugin rule file. Project AGENTS.md snippets are standalone setup, not a plugin component.",
    openGate: null,
  },
  {
    client: "codex",
    capability: "ui",
    status: "untested",
    evidenceClass: "schema",
    evidenceRef: "plugins/hack/.codex-plugin/plugin.json",
    observedClientVersion: CODEX_VERSION,
    sourceSha: SOURCE_SHA,
    hostLabel: HOST,
    note: "Manifest declares an `interface` block (display name, default prompts, brand color); rendering was not observed.",
    openGate:
      "Observe the installed plugin's presentation in the Codex UI for this client version.",
  },
  // Claude Code
  {
    client: "claude",
    capability: "packaging",
    status: "untested",
    evidenceClass: "schema",
    evidenceRef: "plugins/hack/.claude-plugin/plugin.json",
    observedClientVersion: CLAUDE_VERSION,
    sourceSha: SOURCE_SHA,
    hostLabel: HOST,
    note: "Manifest is generated and parsed by tests/agent-plugin-generation.test.ts; no client installed it.",
    openGate: PLUGIN_LOAD_GATE,
  },
  {
    client: "claude",
    capability: "skillDiscovery",
    status: "untested",
    evidenceClass: "schema",
    evidenceRef: "plugins/hack/.claude-plugin/plugin.json",
    observedClientVersion: CLAUDE_VERSION,
    sourceSha: SOURCE_SHA,
    hostLabel: HOST,
    note: "Manifest declares `skills: ./skills/`; skill content matches the canonical renderers.",
    openGate: PLUGIN_LOAD_GATE,
  },
  {
    client: "claude",
    capability: "hooks",
    status: "untested",
    evidenceClass: "schema",
    evidenceRef: "plugins/hack/hooks/claude-hooks.json",
    observedClientVersion: CLAUDE_VERSION,
    sourceSha: SOURCE_SHA,
    hostLabel: HOST,
    note: "SessionStart and PreCompact hooks run only `hack agent prime`; the generation test enforces that command allowlist.",
    openGate: PLUGIN_LOAD_GATE,
  },
  {
    client: "claude",
    capability: "pluginMcp",
    status: "untested",
    evidenceClass: "schema",
    evidenceRef: "plugins/hack-mcp/.mcp.json",
    observedClientVersion: CLAUDE_VERSION,
    sourceSha: MCP_PACKAGE_SOURCE_SHA,
    hostLabel: HOST,
    note: MCP_PACKAGE_NOTE,
    openGate: PLUGIN_LOAD_GATE,
  },
  {
    client: "claude",
    capability: "standaloneMcp",
    status: "untested",
    evidenceClass: "isolated-fixture",
    evidenceRef: BUNDLE_FIXTURE,
    observedClientVersion: CLAUDE_VERSION,
    sourceSha: SOURCE_SHA,
    hostLabel: HOST,
    note: "The opt-in fixture failed at this version: in an isolated HOME, `claude mcp get hack` reports the project-scoped server as pending approval instead of connected, so no connection or tool call was observed. Project approval is a native trust gate and must not be bypassed.",
    openGate:
      "Qualify Claude standalone MCP without bypassing project approval (for example, user scope in an isolated HOME) and pass the fixture end to end.",
  },
  {
    client: "claude",
    capability: "rules",
    status: "unsupported",
    evidenceClass: "source-read",
    evidenceRef: "plugins/hack/.claude-plugin/plugin.json",
    observedClientVersion: CLAUDE_VERSION,
    sourceSha: SOURCE_SHA,
    hostLabel: HOST,
    note: "Hack ships no Claude plugin rule file. Project CLAUDE.md snippets are standalone setup, not a plugin component.",
    openGate: null,
  },
  {
    client: "claude",
    capability: "ui",
    status: "unsupported",
    evidenceClass: "source-read",
    evidenceRef: "plugins/hack/.claude-plugin/plugin.json",
    observedClientVersion: CLAUDE_VERSION,
    sourceSha: SOURCE_SHA,
    hostLabel: HOST,
    note: "Manifest declares no presentation metadata. Codex UI metadata implies nothing for Claude Code.",
    openGate: null,
  },
  // Cursor
  {
    client: "cursor",
    capability: "packaging",
    status: "untested",
    evidenceClass: "schema",
    evidenceRef: "plugins/hack/.cursor-plugin/plugin.json",
    observedClientVersion: CURSOR_VERSION,
    sourceSha: SOURCE_SHA,
    hostLabel: HOST,
    note: "Manifest is generated and parsed by tests/agent-plugin-generation.test.ts. docs/integrations.md records an earlier manual symlink-rejection observation (Cursor 3.18.25), not a fixture.",
    openGate: PLUGIN_LOAD_GATE,
  },
  {
    client: "cursor",
    capability: "skillDiscovery",
    status: "untested",
    evidenceClass: "schema",
    evidenceRef: "plugins/hack/.cursor-plugin/plugin.json",
    observedClientVersion: CURSOR_VERSION,
    sourceSha: SOURCE_SHA,
    hostLabel: HOST,
    note: "Manifest declares `skills: ./skills/`; skill content matches the canonical renderers.",
    openGate: PLUGIN_LOAD_GATE,
  },
  {
    client: "cursor",
    capability: "hooks",
    status: "unsupported",
    evidenceClass: "source-read",
    evidenceRef: "plugins/hack/.cursor-plugin/plugin.json",
    observedClientVersion: CURSOR_VERSION,
    sourceSha: SOURCE_SHA,
    hostLabel: HOST,
    note: "Hack ships no Cursor plugin hooks; the manifest declares no `hooks` key.",
    openGate: null,
  },
  {
    client: "cursor",
    capability: "pluginMcp",
    status: "untested",
    evidenceClass: "schema",
    evidenceRef: "plugins/hack-mcp/.mcp.json",
    observedClientVersion: CURSOR_VERSION,
    sourceSha: MCP_PACKAGE_SOURCE_SHA,
    hostLabel: HOST,
    note: MCP_PACKAGE_NOTE,
    openGate: PLUGIN_LOAD_GATE,
  },
  {
    client: "cursor",
    capability: "standaloneMcp",
    status: "untested",
    evidenceClass: "schema",
    evidenceRef: "tests/mcp-install.test.ts",
    observedClientVersion: CURSOR_VERSION,
    sourceSha: SOURCE_SHA,
    hostLabel: HOST,
    note: "Tests check the `.cursor/mcp.json` entry Hack writes; Cursor itself never loaded it in a fixture.",
    openGate:
      "Add an isolated Cursor fixture that loads the written entry and lists Hack tools.",
  },
  {
    client: "cursor",
    capability: "rules",
    status: "untested",
    evidenceClass: "schema",
    evidenceRef: "plugins/hack/rules/hack.mdc",
    observedClientVersion: CURSOR_VERSION,
    sourceSha: SOURCE_SHA,
    hostLabel: HOST,
    note: "Agent-selectable rule (`alwaysApply: false`) matches the canonical renderer; loading was not observed.",
    openGate: PLUGIN_LOAD_GATE,
  },
  {
    client: "cursor",
    capability: "ui",
    status: "unsupported",
    evidenceClass: "source-read",
    evidenceRef: "plugins/hack/.cursor-plugin/plugin.json",
    observedClientVersion: CURSOR_VERSION,
    sourceSha: SOURCE_SHA,
    hostLabel: HOST,
    note: "Manifest declares no presentation metadata. Codex UI metadata implies nothing for Cursor.",
    openGate: null,
  },
  // Standalone: no named client; the portable manifest or a generic stdio MCP client.
  {
    client: "standalone",
    capability: "packaging",
    status: "untested",
    evidenceClass: "schema",
    evidenceRef: "plugins/hack/plugin.json",
    observedClientVersion: null,
    sourceSha: SOURCE_SHA,
    hostLabel: HOST,
    note: "Portable agent-plugins manifest is derived from the Codex manifest; no portable consumer was observed.",
    openGate: "Name a portable consumer and observe it install the package.",
  },
  {
    client: "standalone",
    capability: "skillDiscovery",
    status: "untested",
    evidenceClass: "source-read",
    evidenceRef: "plugins/hack/plugin.json",
    observedClientVersion: null,
    sourceSha: SOURCE_SHA,
    hostLabel: HOST,
    note: "The portable manifest declares no component paths; discovery of `skills/` by convention is unverified.",
    openGate:
      "Name a portable consumer and observe skill discovery in a fresh session.",
  },
  {
    client: "standalone",
    capability: "hooks",
    status: "unsupported",
    evidenceClass: "source-read",
    evidenceRef: "plugins/hack/plugin.json",
    observedClientVersion: null,
    sourceSha: SOURCE_SHA,
    hostLabel: HOST,
    note: "The portable manifest carries hooks only through the OpenAI extension, and Hack ships none there.",
    openGate: null,
  },
  {
    client: "standalone",
    capability: "pluginMcp",
    status: "untested",
    evidenceClass: "schema",
    evidenceRef: "plugins/hack-mcp/mcp.json",
    observedClientVersion: null,
    sourceSha: MCP_PACKAGE_SOURCE_SHA,
    hostLabel: HOST,
    note: "The opt-in `hack-mcp` portable MCP manifest adds an explicit stdio transport to the same launch as its `.mcp.json`; the default `hack` package ships no MCP file.",
    openGate:
      "Name a portable consumer and observe it start the declared server.",
  },
  {
    client: "standalone",
    capability: "standaloneMcp",
    status: "untested",
    evidenceClass: "isolated-fixture",
    evidenceRef: BUNDLE_FIXTURE,
    observedClientVersion: null,
    sourceSha: SOURCE_SHA,
    hostLabel: HOST,
    note: "The fixture's reference MCP SDK client calls a real tool through the generated entry, but that step was not reached in the recorded run. The SDK client is not an agent.",
    openGate:
      "Pass tests/mcp-bundle-client.test.ts end to end, or add a client-independent stdio fixture.",
  },
  {
    client: "standalone",
    capability: "rules",
    status: "unsupported",
    evidenceClass: "source-read",
    evidenceRef: "plugins/hack/plugin.json",
    observedClientVersion: null,
    sourceSha: SOURCE_SHA,
    hostLabel: HOST,
    note: "No portable rule component is shipped.",
    openGate: null,
  },
  {
    client: "standalone",
    capability: "ui",
    status: "unsupported",
    evidenceClass: "source-read",
    evidenceRef: "plugins/hack/plugin.json",
    observedClientVersion: null,
    sourceSha: SOURCE_SHA,
    hostLabel: HOST,
    note: "Presentation metadata exists only in the OpenAI extension; no portable UI is claimed.",
    openGate: null,
  },
];
