# Toolchain and maintenance

Reviewed 2026-09-16 against official release APIs:

- TLC 1.7.4 is the latest stable release; [1.8.0](https://github.com/tlaplus/tlaplus/releases/tag/v1.8.0) is a rolling prerelease. Keep the stable checksum pin for reproducible checks.
- [Apalache 0.62.2](https://github.com/apalache-mc/apalache/releases/tag/v0.62.2) is the current stable release and requires Java 21 (class version 65).
- TLC uses mise `java@temurin-17.0.20+101`; Apalache uses `java@temurin-21.0.12+101.0.LTS`. Pins are centralized in `scripts/tla_agent_checks.py`. Verify the actual `java -version`, since distribution identifiers may differ from displayed patch versions.

Before upgrading, check release status and asset digests from official publishers. Update the helper pins and related repository CI pins together if TLC changes. Verify downloads before execution/extraction. Preserve previous installed versions until compatibility is established; do not prune unrelated caches.

Run `python3 -m unittest discover -s tests -v`; set `TLA_LIVE_TESTS=1 PYTHONDONTWRITEBYTECODE=1` to enable the installed-checker integration test. Exercise both valid and intentionally invalid models through the actual executables, plus valid/invalid-initial/invalid-transition trace replay. Verify mise configuration hashes remain unchanged. Version output and frontmatter validation are insufficient evidence by themselves.

The local CLI workflow does not require MCP. The [upstream TLA+ extension](https://github.com/tlaplus/vscode-tlaplus) exposes editor-integrated MCP tools; the [headless server proposal](https://github.com/tlaplus/tlaplus/pull/1296) is an additional option. Evaluate a server only when its parsing, navigation, structured results, or editor integration improves the actual workflow; discover callable tools rather than assuming names or availability. No TLA-related Codex MCP server was configured at this review.

The [MCP Market getting-started page](https://mcpmarket.com/tools/skills/tla-getting-started) is a discovery listing, not a verified local installation. [Terzian's case study](https://medium.com/@polyglot_factotum/tla-in-support-of-ai-code-generation-9086fc9715c4) illustrates specifications supporting implementation work; it does not establish implementation conformance automatically.

Skill structure follows the bundled OpenAI skill-creator guidance and [Astra model guidance](https://developers.openai.com/api/docs/guides/latest-model): precise routing, scoped instructions, progressive detail, proportional verification, and no hidden approval gates. Do not copy model-wide prompts into this domain skill.
