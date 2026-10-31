# Agent client capability matrix

This page classifies what Hack's optional agent integrations are known to do in
each client. The data lives in `src/agents/client-capabilities.ts`.
`scripts/generate-agent-client-capabilities.ts` renders the generated section
below from that data. `tests/agent-client-capabilities.test.ts` fails when the
committed section differs from the rendered one, and enforces the classification
rules.

## Classification rules

- **verified**: a named test file observed the client load the component, at
  `isolated-fixture` or `authenticated-session` strength.
- **untested**: Hack ships the component, but no fixture or session has observed
  a client load it at the recorded version. Each untested cell names its open gate.
- **unsupported**: Hack does not ship the component for that client. This says
  nothing about what the client itself supports.

Evidence classes, weakest first:

| Class | Meaning |
| --- | --- |
| `source-read` | Classified by reading shipped files or client documentation. |
| `schema` | A test parses or generates the shipped file; no client loads it. |
| `isolated-fixture` | A test runs the real client with an isolated home and configuration. |
| `authenticated-session` | A signed-in client session used the component. |

A manifest parse, a schema check or a marketplace listing is never evidence that a
component loaded. Each cell records the client version, a host label and the source
commit at which it was classified. That is one observation on one host. It does not
cover other machines or later client versions. A status for one client implies
nothing about another client, including UI parity.

To reclassify a cell, update the data, increment
`AGENT_CLIENT_CAPABILITY_MATRIX_VERSION`, and run
`bun run docs:agent-client-capabilities` to rewrite the section below. Add
`-- --check` to report a stale section without writing. Edit only the prose
outside the generated markers by hand. Promote a cell to `verified` only after its
named test passes against the recorded client version.

<!-- BEGIN GENERATED: agent-client-capabilities -->

Matrix version 3, latest observation 2026-10-18. Older cells retain their recorded source and client versions.

### Clients

| Client | `hack` plugin manifest | `hack-mcp` plugin manifest |
| --- | --- | --- |
| Codex | `plugins/hack/.codex-plugin/plugin.json` | `plugins/hack-mcp/.codex-plugin/plugin.json` |
| Claude Code | `plugins/hack/.claude-plugin/plugin.json` | `plugins/hack-mcp/.claude-plugin/plugin.json` |
| Cursor | `plugins/hack/.cursor-plugin/plugin.json` | `plugins/hack-mcp/.cursor-plugin/plugin.json` |
| Standalone (portable manifest or generic stdio MCP client) | `plugins/hack/plugin.json` | `plugins/hack-mcp/plugin.json` |

### Capabilities

| Capability | Meaning |
| --- | --- |
| Packaging | The client accepts, installs and enables the default `hack` plugin package in a session. |
| Skill discovery | A fresh session discovers the plugin's bundled skills (hack-cli, hack-branches, hack-env, hack-diagnose, hack-init, hack-install, hack-remote). |
| Hooks | The client runs plugin-shipped hooks; Hack v5 declares none. |
| Plugin MCP | The client starts the `hack mcp serve` server declared by the opt-in `hack-mcp` plugin and lists its tools. The default `hack` plugin ships no MCP. |
| Standalone MCP | The client loads an MCP entry written by `hack mcp install` (stdio or a selected MCP bundle) without the plugin. |
| Rules | The client loads a plugin-shipped rule file. |
| UI | The client renders plugin presentation metadata (display name, default prompts, brand color). |

### Status summary

| Capability | Codex | Claude Code | Cursor | Standalone (portable manifest or generic stdio MCP client) |
| --- | --- | --- | --- | --- |
| Packaging | untested | untested | untested | untested |
| Skill discovery | untested | untested | untested | untested |
| Hooks | unsupported | unsupported | unsupported | unsupported |
| Plugin MCP | untested | untested | untested | untested |
| Standalone MCP | untested | untested | untested | verified |
| Rules | unsupported | unsupported | unsupported | unsupported |
| UI | untested | unsupported | unsupported | unsupported |

### Cells

| Client | Capability | Status | Evidence class | Evidence | Client version | Host | Source | Note | Open gate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex | Packaging | untested | schema | `plugins/hack/.codex-plugin/plugin.json` | codex-cli 0.162.1 | `macos-arm64-contributor` | `ec56769bdc04` | Manifest is generated and parsed by tests/agent-plugin-generation.test.ts; no client installed it. | Install the plugin into an isolated client home, start a fresh session and observe the component load; a marketplace listing or manifest parse does not count. |
| codex | Skill discovery | untested | schema | `plugins/hack/.codex-plugin/plugin.json` | codex-cli 0.162.1 | `macos-arm64-contributor` | `ec56769bdc04` | Manifest declares `skills: ./skills/`; skill content matches the canonical renderers. | Install the plugin into an isolated client home, start a fresh session and observe the component load; a marketplace listing or manifest parse does not count. |
| codex | Hooks | unsupported | source-read | `plugins/hack/.codex-plugin/plugin.json` | codex-cli 0.162.1 | `macos-arm64-contributor` | `ec56769bdc04` | Hack ships no Codex plugin hooks; the manifest declares no `hooks` key. This says nothing about Codex's own hook support. | none |
| codex | Plugin MCP | untested | schema | `plugins/hack-mcp/.mcp.json` | codex-cli 0.162.1 | `macos-arm64-contributor` | `3e261d517ed7` | The opt-in `hack-mcp` manifest points `mcpServers` at `.mcp.json` (`hack mcp serve`); the default `hack` plugin declares no MCP. No plugin session started the server. | Install the plugin into an isolated client home, start a fresh session and observe the component load; a marketplace listing or manifest parse does not count. |
| codex | Standalone MCP | untested | isolated-fixture | `tests/mcp-bundle-client.test.ts` | codex-cli 0.162.1 | `macos-arm64-contributor` | `ec56769bdc04` | In the opt-in fixture, `codex mcp get hack --json` resolved the generated bundle adapter from an isolated CODEX_HOME. The fixture then stopped at the Claude step, so no tool call was observed in that run. Configuration discovery alone does not prove a Codex model session loaded the server or accepted project trust. | Pass tests/mcp-bundle-client.test.ts end to end at this client version; a Codex model session tool call remains a separate authenticated-session gate. |
| codex | Rules | unsupported | source-read | `plugins/hack/.codex-plugin/plugin.json` | codex-cli 0.162.1 | `macos-arm64-contributor` | `ec56769bdc04` | Hack ships no Codex plugin rule file. Project AGENTS.md snippets are standalone setup, not a plugin component. | none |
| codex | UI | untested | schema | `plugins/hack/.codex-plugin/plugin.json` | codex-cli 0.162.1 | `macos-arm64-contributor` | `ec56769bdc04` | Manifest declares an `interface` block (display name, default prompts, brand color); rendering was not observed. | Observe the installed plugin's presentation in the Codex UI for this client version. |
| claude | Packaging | untested | schema | `plugins/hack/.claude-plugin/plugin.json` | Claude Code 2.1.296 | `macos-arm64-contributor` | `ec56769bdc04` | Manifest is generated and parsed by tests/agent-plugin-generation.test.ts; no client installed it. | Install the plugin into an isolated client home, start a fresh session and observe the component load; a marketplace listing or manifest parse does not count. |
| claude | Skill discovery | untested | schema | `plugins/hack/.claude-plugin/plugin.json` | Claude Code 2.1.296 | `macos-arm64-contributor` | `ec56769bdc04` | Manifest declares `skills: ./skills/`; skill content matches the canonical renderers. | Install the plugin into an isolated client home, start a fresh session and observe the component load; a marketplace listing or manifest parse does not count. |
| claude | Hooks | unsupported | schema | `plugins/hack/.claude-plugin/plugin.json` | Claude Code 2.1.296 | `macos-arm64-contributor` | `5c066d6cca0d` | Hack v5 ships explicitly invoked skills; no automatic session hooks. | none |
| claude | Plugin MCP | untested | schema | `plugins/hack-mcp/.mcp.json` | Claude Code 2.1.296 | `macos-arm64-contributor` | `3e261d517ed7` | The opt-in `hack-mcp` manifest points `mcpServers` at `.mcp.json` (`hack mcp serve`); the default `hack` plugin declares no MCP. No plugin session started the server. | Install the plugin into an isolated client home, start a fresh session and observe the component load; a marketplace listing or manifest parse does not count. |
| claude | Standalone MCP | untested | isolated-fixture | `tests/mcp-bundle-client.test.ts` | Claude Code 2.1.296 | `macos-arm64-contributor` | `ec56769bdc04` | The opt-in fixture failed at this version: in an isolated HOME, `claude mcp get hack` reports the project-scoped server as pending approval instead of connected, so no connection or tool call was observed. Project approval is a native trust gate and must not be bypassed. | Qualify Claude standalone MCP without bypassing project approval (for example, user scope in an isolated HOME) and pass the fixture end to end. |
| claude | Rules | unsupported | source-read | `plugins/hack/.claude-plugin/plugin.json` | Claude Code 2.1.296 | `macos-arm64-contributor` | `ec56769bdc04` | Hack ships no Claude plugin rule file. Project CLAUDE.md snippets are standalone setup, not a plugin component. | none |
| claude | UI | unsupported | source-read | `plugins/hack/.claude-plugin/plugin.json` | Claude Code 2.1.296 | `macos-arm64-contributor` | `ec56769bdc04` | Manifest declares no presentation metadata. Codex UI metadata implies nothing for Claude Code. | none |
| cursor | Packaging | untested | schema | `plugins/hack/.cursor-plugin/plugin.json` | Cursor 3.24.12 | `macos-arm64-contributor` | `ec56769bdc04` | Manifest is generated and parsed by tests/agent-plugin-generation.test.ts. docs/integrations.md records an earlier manual symlink-rejection observation (Cursor 3.18.25), not a fixture. | Install the plugin into an isolated client home, start a fresh session and observe the component load; a marketplace listing or manifest parse does not count. |
| cursor | Skill discovery | untested | schema | `plugins/hack/.cursor-plugin/plugin.json` | Cursor 3.24.12 | `macos-arm64-contributor` | `ec56769bdc04` | Manifest declares `skills: ./skills/`; skill content matches the canonical renderers. | Install the plugin into an isolated client home, start a fresh session and observe the component load; a marketplace listing or manifest parse does not count. |
| cursor | Hooks | unsupported | source-read | `plugins/hack/.cursor-plugin/plugin.json` | Cursor 3.24.12 | `macos-arm64-contributor` | `ec56769bdc04` | Hack ships no Cursor plugin hooks; the manifest declares no `hooks` key. | none |
| cursor | Plugin MCP | untested | schema | `plugins/hack-mcp/.mcp.json` | Cursor 3.24.12 | `macos-arm64-contributor` | `3e261d517ed7` | The opt-in `hack-mcp` manifest points `mcpServers` at `.mcp.json` (`hack mcp serve`); the default `hack` plugin declares no MCP. No plugin session started the server. | Install the plugin into an isolated client home, start a fresh session and observe the component load; a marketplace listing or manifest parse does not count. |
| cursor | Standalone MCP | untested | schema | `tests/mcp-install.test.ts` | Cursor 3.24.12 | `macos-arm64-contributor` | `ec56769bdc04` | Tests check the `.cursor/mcp.json` entry Hack writes; Cursor itself never loaded it in a fixture. | Add an isolated Cursor fixture that loads the written entry and lists Hack tools. |
| cursor | Rules | unsupported | schema | `plugins/hack/.cursor-plugin/plugin.json` | Cursor 3.24.12 | `macos-arm64-contributor` | `5c066d6cca0d` | Hack v5 ships explicitly invoked skills; no injected rules. | none |
| cursor | UI | unsupported | source-read | `plugins/hack/.cursor-plugin/plugin.json` | Cursor 3.24.12 | `macos-arm64-contributor` | `ec56769bdc04` | Manifest declares no presentation metadata. Codex UI metadata implies nothing for Cursor. | none |
| standalone | Packaging | untested | schema | `plugins/hack/plugin.json` | none | `macos-arm64-contributor` | `ec56769bdc04` | Portable agent-plugins manifest is derived from the Codex manifest; no portable consumer was observed. | Name a portable consumer and observe it install the package. |
| standalone | Skill discovery | untested | source-read | `plugins/hack/plugin.json` | none | `macos-arm64-contributor` | `ec56769bdc04` | The portable manifest declares no component paths; discovery of `skills/` by convention is unverified. | Name a portable consumer and observe skill discovery in a fresh session. |
| standalone | Hooks | unsupported | source-read | `plugins/hack/plugin.json` | none | `macos-arm64-contributor` | `ec56769bdc04` | The portable manifest carries hooks only through the OpenAI extension, and Hack ships none there. | none |
| standalone | Plugin MCP | untested | schema | `plugins/hack-mcp/mcp.json` | none | `macos-arm64-contributor` | `3e261d517ed7` | The opt-in `hack-mcp` portable MCP manifest adds an explicit stdio transport to the same launch as its `.mcp.json`; the default `hack` package ships no MCP file. | Name a portable consumer and observe it start the declared server. |
| standalone | Standalone MCP | verified | isolated-fixture | `tests/mcp-bundle-client.test.ts` | @modelcontextprotocol/sdk 1.26.0 (Bun 1.4.2) | `macos-arm64-contributor` | `f0c0d1740db3` | The client-independent bundle fixture passed on Apple Silicon macOS: a real SDK client loaded the generated stdio entry, listed tools, called hack.projects.list through the compiled CLI with an isolated empty registry and unavailable Docker, then observed owned backend retirement. Source-matched adapter/owner/backend and CLI were built locally. This qualifies this SDK transport, not agent authentication, plugin loading or a published installation. | none |
| standalone | Rules | unsupported | source-read | `plugins/hack/plugin.json` | none | `macos-arm64-contributor` | `ec56769bdc04` | No portable rule component is shipped. | none |
| standalone | UI | unsupported | source-read | `plugins/hack/plugin.json` | none | `macos-arm64-contributor` | `ec56769bdc04` | Presentation metadata exists only in the OpenAI extension; no portable UI is claimed. | none |

<!-- END GENERATED: agent-client-capabilities -->

## Standalone bundle qualification

The SDK transport can be qualified independently of Claude, Codex or Cursor sign-in.
Use a verified local bundle and its source-matched compiled CLI:

```sh
HACK_MCP_BUNDLE_TEST_DIRECTORY=/absolute/verified/bundle \
HACK_MCP_CLI_TEST_BINARY=/absolute/source-matched/hack \
bun test tests/mcp-bundle-client.test.ts --test-name-pattern 'generated standalone'
```

The fixture installs an entry in a private temporary project, starts the declared
adapter, lists tools, calls the real CLI against an empty private registry and
waits for owned backend retirement. It uses no agent credentials or VM. A skipped
test is not qualification. Passing this test establishes the recorded SDK transport
only; agent trust, plugin loading and official installed-package acceptance remain
separate gates. The original multi-client fixture still requires its explicit
Claude and Codex executables and their native approval requirements.

## Companion-package layout decision

Hack keeps three separate companion layouts. Each layout has one authoritative
owner, and none of them replaces the others. Users choose one per client.

| Layout | What it contains | Authoritative owner | Installed and updated by |
| --- | --- | --- | --- |
| Native plugin (`plugins/hack`) | Client manifests, seven skills, Claude primer hooks and Cursor rule; opt-in `plugins/hack-mcp` separately declares `hack mcp serve` | `scripts/generate-agent-plugins.ts`, rendering from `src/agents/instruction-source.ts` and the skill renderers in `src/agents/` | The client's plugin manager. Hack commands never install or update it. |
| Standalone setup | Project AGENTS.md/CLAUDE.md snippets, Cursor rules, shared skills, Claude primer hooks, MCP entries | `src/agents/instruction-source.ts` and its renderers, written by `hack setup` and `hack mcp install` | Explicit `hack setup` and `hack mcp install` commands in a chosen scope |
| MCP bundle | Native MCP adapter, owner and backend executables with a content-derived identity | `src/mcp/bundle.ts` (packaging and verification) | `hack mcp install --bundle ... --cli ...` writes the client entry; the bundle is never modified after selection |

Decisions:

- Shared guidance has one canonical source, `src/agents/instruction-source.ts`. The
  plugin and the standalone setup are renderings of it, not separate sources.
- Installing the plugin does not migrate or remove standalone guidance. See
  [integration setup](../integrations.md).
- The MCP bundle is an alternative launch for MCP only. It does not carry skills,
  hooks or rules.
- This page records the current layout. Layout changes are separate work and must
  update this matrix in the same change.

## Model-policy ownership

The user's own provider configuration and project policy own these settings. Hack
artifacts must not set them:

- model selection, model overrides and reasoning effort (for example
  `model_reasoning_effort`, `reasoning_effort`, or `effort` in skill frontmatter)
- permission modes, tool allowlists, approval policies and sandbox modes
- output styles

Hack-shipped hooks may run only `hack agent prime`.
`tests/agent-plugin-generation.test.ts` enforces this for the generated guidance
surfaces: `plugins/hack`, `.claude-plugin`, `.cursor-plugin`, `.agents` (including
the skills it links to), and the agent configuration in `examples/basic/.claude`,
`.codex` and `.cursor`. It parses JSON, JSON Lines, TOML, YAML and markdown
frontmatter. It fails on structured-config formats it cannot parse, such as INI,
JSONC, XML or `.env`, and counts a file as scanned only when it parsed it.
A negative control proves the check rejects each forbidden setting. See
[maintaining agent guidance](../agent-guidance.md).
