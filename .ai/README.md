# Hack contributor operating layer

`AGENTS.md` is the shared entry point; `CLAUDE.md` imports it rather than maintaining
a second policy. Load focused skills on demand. `.ai/` contains portable,
reviewed project guidance, not personal instructions, credentials, host inventories,
agent transcripts, generated queues, local reviews, or runtime state.

## Ownership

| Asset | Source of truth |
| --- | --- |
| Contributor scope and routing | [AGENTS.md](../AGENTS.md) |
| Code and state-boundary rules | [code-quality skill](skills/hack-repo-code-quality/SKILL.md) |
| Commands and evidence selection | [verification skill](skills/hack-repo-verify/SKILL.md) |
| Work units and experiment design | [work-unit skill](skills/hack-repo-work-unit/SKILL.md) |
| Developer toolchain | [.hack/README.md](../.hack/README.md), root mise/package pins |
| v5 status and acceptance | [Linear program and issue index](https://linear.app/hackdance/document/hack-v5-program-measurable-acceptance-and-source-of-truth-26d5fb362f3e); local mapping `_docs/docs/plans/v5/linear-sync.md`, preserved ledger `_docs/docs/plans/v5/work-units.md` |
| Consumer instructions installed by Hack | [agent-guidance.md](../docs/agent-guidance.md) |

Contributor skills are authored in `.ai/skills/<name>/SKILL.md`. Relative symlinks
in `.agents/skills/` and `.claude/skills/` expose the same files to local clients.
Use unique `hack-repo-*` names; existing generated `hack-cli`/`hack-init` skills serve
consumers and remain separately owned. Do not copy these contributor skills into
`plugins/hack`, global tool homes, or another project through setup sync.

Current skills:

- [hack-repo-code-quality](skills/hack-repo-code-quality/SKILL.md): TypeScript/Rust and state boundaries.
- [hack-repo-work-unit](skills/hack-repo-work-unit/SKILL.md): acceptance and feedback loops.
- [hack-repo-tla](skills/hack-repo-tla/SKILL.md): self-contained formal-model runner, references and tests.

- [hack-repo-verify](skills/hack-repo-verify/SKILL.md): choose and execute checks for a Hack change.
- [hack-repo-performance](skills/hack-repo-performance/SKILL.md): bounded runtime/resource experiments.

Add a skill when a repeated workflow has useful project-specific decisions or
helpers. Give it a precise trigger, observable output and proportionate verification.
Prefer existing harnesses and linked references over copied commands and scripts.
Keep tool installation optional unless the workflow needs it. Skills support the
user's task; they do not authorize new effects or impose unrelated process.

## Maintenance and validation

When guidance changes, check local links, skill frontmatter, symlink targets and
documented commands against source. Validate through both symlink entry points, then
exercise representative task selection: a docs edit, a CLI regression, a Rust state
change and a resource experiment should select different, appropriate evidence.
A file existing is not proof that a running client loaded it; check a fresh client's
skill listing when client discovery is the acceptance criterion.

Contributor-only edits do not require consumer regeneration. When consumer sources
change, follow their generation contract and check the generated diff. No global
sync, MCP registration, provider settings or machine configuration is part of this
layer. Preserve existing unrelated client artifacts.

fclt project enrollment is configured in `config.toml`, with on-demand indexing and
no scheduling or managed rendering. Run `fclt index --project` after capability
changes, then `fclt list skills --project` to inspect discovery. Generated state and
receipts stay machine-local. The checked-in relative links are the deployment
contract: edits to canonical skills are immediately shared with both clients.
When adding a skill, add its two links and verify they resolve to the same directory.
Do not use deprecated broad `manage`/`sync` mutation or its legacy bypass to replace
existing client configuration. fclt 2.30.4's per-asset deployment plan is read-only
and does not yet apply skills; this setup does not pretend otherwise.

`hack-repo-tla` was copied from the maintained global `tla-agent-checks` at source
commit `d799ec0` on 2026-09-17. It includes the Python runner, templates, references
and regression tests, excluding downloaded tools and caches. Repo naming and Hack
workflow links distinguish it from the global skill. Subsequent changes are reviewed
here; no automatic two-way global sync is configured. Run its helper suite through
the toolchain's `exec python3 -m unittest discover -s .ai/skills/hack-repo-tla/tests`.
CI runs those portable tests alongside the maintained model controls. The optional
`TLA_LIVE_TESTS=1` helper test additionally runs TLC, Apalache and valid/invalid traces;
it requires their pinned tools and Java runtimes and is not enabled in that CI job.

Validation on 2026-09-17: five skill schemas and both sets of symlink targets passed;
fclt discovered all five with no setup issues; 19 existing consumer-guidance tests
passed and regeneration produced no consumer diff. The copied TLA helper passed
seven portable tests (one live test skipped) in the Hack container and all eight on
the host using the existing checksum-verified tool cache. Local links, Claude import
and CI YAML were checked. Fresh-session Codex/Claude discovery is a separate check;
these results establish the files and entry points, not a newly launched client.

This layout adapts hack-mesh's focused operating layer and explicit boundary
contracts to Hack's actual code. It does not import Mesh's protocol policy, blanket
unsafe ban, formatter settings or verification commands. The shared Claude import
also avoids the duplicate policy drift seen in that reference checkout.

Reviewed against [Astra guidance](https://developers.openai.com/api/docs/guides/latest-model),
[AGENTS.md loading](https://learn.chatgpt.com/docs/agent-configuration/agents-md), and
[skill discovery](https://learn.chatgpt.com/docs/build-skills) on 2026-09-17.
The resulting conventions favor clear scope, selective context and bounded checks;
they do not depend on a specific model or silently select one.
