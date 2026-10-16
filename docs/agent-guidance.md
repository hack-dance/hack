# Maintaining agent guidance

Hack owns Hack-specific instructions. User and project policy continues to own model
selection, general coding standards, work-unit planning, evolution, and writeback.
Do not ship provider model pins or copy global instruction packs into this plugin.

## Sources and installed surfaces

| Source | Consumers |
| --- | --- |
| Root `AGENTS.md` | Contributor baseline; root `CLAUDE.md` imports it |
| `apps/macos/AGENTS.md` | Explicit maintenance of the unsupported native app |
| `WORKFLOW.md`, `.factory/` | Repository validation and optional Factory mission adapter |
| `src/agents/instruction-source.ts` | Project AGENTS/CLAUDE snippets, standalone/shared Hack skill, Cursor rules, session primer, native plugin skill/rule |
| `src/agents/onboarding-prompt.ts` | `hack agent onboard`, init handoff, and MCP onboarding prompt |
| `src/agents/hack-init-skill.ts` | Thin Claude/Codex/plugin adapter that fetches onboarding guidance |
| `src/agents/init-patterns.ts`, `init-assistant.ts` | Optional init inventory and pattern hints |
| `scripts/generate-agent-plugins.ts` | Three plugin manifests, two skills, and Cursor rule |

Consumer examples live under `examples/basic/`. Do not replace the root contributor
baseline with a generated consumer snippet. Provider metadata and hook configuration
belong to their client adapters; shared behavior belongs to the canonical sources.

## Editing and verification

1. Change the canonical source. Keep recurring primers shorter than full reference
   skills. Preserve scope, native approval, secret-handling, ownership, and publishing
   gates while removing redundant confirmation and optional-warning completion gates.
2. When canonical instruction sections change, update their SHA-256 content fingerprint
   in `src/agents/integration-revision.ts`; its test verifies the first 12 hex characters
   of the serialized non-freshness sections. CLI version alone is not a content revision.
3. Render only repository targets: the checked-in Codex skills, Cursor rule, Claude
   onboarding skill, and `examples/basic` snippets. Use their renderer/install functions
   with explicit project roots. Run `bun run generate:agent-plugins` for the bundle.
   Do not run a user/global integration sync to update source-controlled examples.
4. Run instruction-source, onboarding, hack-init-skill, shared-agent-skill, and plugin
   generation tests. Run normal typecheck/check/test gates for behavior changes. New
   packaging needs fresh client loading proof beyond a successful marketplace listing.
5. Release preparation regenerates plugin assets after the version bump. Verify the
   published bundle and installed executable separately.

## Audit decisions

- Claude imports the contributor baseline instead of carrying a divergent copy.
- Removed whole-repository format-on-every-edit hooks; run the pinned formatter on
  changed files and retain normal quality gates.
- Removed duplicated generic macOS/SwiftUI skill packs and retired hosted Neon guidance.
  The retained app's constraints are scoped to `apps/macos/AGENTS.md`; they are not
  default CLI instructions or consumer plugin payloads.
- Default onboarding does not recommend unsupported remote/node/gateway/dispatch flows.
  Existing experimental code remains available only for explicit work.
- Partial adoption, successful one-shot containers, and optional integrations are
  represented consistently across prompts, skills, examples, and docs.
- Secret values never belong in agent-visible command arguments or prompts. Native
  trust approvals, exact development-origin checks, publishing gates, and resource
  ownership remain required.
- Plugin installation is optional and does not migrate or delete standalone guidance.
  Verify replacement components before explicitly removing scoped duplicates, and
  preserve customized files. See [integration setup](integrations.md).
- Historical Factory validation artifacts describe past runs; they are evidence, not
  current contributor policy. Do not rewrite history to resemble the current workflow.
