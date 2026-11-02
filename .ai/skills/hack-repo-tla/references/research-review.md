# Research review: applying TLA+ to agent-assisted development

Reviewed 2026-09-16. Read this when considering a new modeling workflow or tool, not for every check.

## Useful choices

[The Foundation's AgentSkills](https://github.com/tlaplus/AgentSkills) provides concrete source-modeling and variable/action-editing guidance. Our short model-review reference carries the useful checks. Its abstraction advice is conditional: removing memory management or error paths would erase the very bugs in reclamation and crash recovery.

[The Foundation challenge](https://foundation.tlapl.us/challenge/index.html) highlights complementary directions: deriving models from implementations, validating traces, constraining generation syntax, and using specifications to guide implementation. None alone proves a complete production implementation. The practical loop here remains intent → small model → executable checks → source mapping → implementation regression.

[Specula](https://github.com/specula-org/Specula) is a candidate for deeper source-to-model and trace-conformance work. Its current setup adds agents, MCP tools, Java 21/Maven and Python tooling; its README recommends at least 32 GB RAM and 100 GB disk. It supports keeping the original checkout unchanged and importing an existing model for incremental verification. Evaluate it on a bounded module with explicit output/storage budgets and a pinned revision before adopting its setup globally. It is not a requirement for ordinary CI model checks. A suitable experiment compares discovered defects and conformance coverage with our existing hand-maintained model, including an injected defect and a known-good control.

[Can LLMs Write Correct TLA+ Specifications?](https://arxiv.org/html/2606.05792v1) motivates treating generated specs as untrusted artifacts. Its headline success rates should not be interpreted as an Astra reliability estimate: Table 3/4 explicitly include state-directory and missing-module infrastructure failures. A successful TLC run under a supplied configuration also does not independently prove fidelity to natural-language intent. Separate parser/configuration/infrastructure failures, invariant counterexamples, and actual source-conformance evidence in our own results.

[Demirbas' industry account](https://muratbuffalo.blogspot.com/2026/03/tla-as-design-accelerator-lessons-from.html) supports modeling early and choosing the smallest abstraction that answers the design question. For example, a client-visible history can be more useful than modeling an entire storage engine. Apply this to ownership, admission, reclamation and recovery boundaries as separate questions.

[Terzian's case study](https://medium.com/@polyglot_factotum/tla-in-support-of-ai-code-generation-9086fc9715c4) illustrates specs guiding generated Rust, with design and review still doing essential work. Use specifications as precise contracts; keep implementation tests and mapping evidence.

## Learning and discovery

[Learning TLA+](https://learning.tlapl.us/) offers interactive examples and a blocking-queue tutorial. [Awesome TLA+](https://github.com/tlaplus/awesome-tlaplus) is a source of tools and maintained example links. Use relevant primary examples on demand rather than loading a tutorial corpus into the skill.

[Walsh's system-design guide](https://wal.sh/research/tla-plus-system-design/) is a broad educational overview, not a tested template library or release authority. Validate any borrowed fragment with the actual parser/checker and current official documentation. The Chrome rendering was also reviewed: the lease example uses one global owner, making its mutual-exclusion formula unable to represent conflicting client beliefs. Model per-client ownership/fencing where that is the actual risk; do not copy a tautological safety check.

The [MCP Market listing](https://mcpmarket.com/tools/skills/tla-getting-started) describes a beginner skill but did not establish the complete source or a local installation. The [Shah Bhat Medium link](https://shahbhat.medium.com/beyond-vibe-coding-using-tla-and-executable-specifications-with-claude-51df2a9460ff) returned only the page shell; the [daily.dev link](https://daily.dev/posts/tla-modeling-tips-qykkhdb0w) failed to load. No technical conclusions were drawn from those unavailable bodies.

## Skill behavior

Follow [official Astra guidance](https://developers.openai.com/api/docs/guides/latest-model) and the bundled skill-creator: precise applicability, concise essential instructions, optional references, no inferred approval gates, and verification matched to the change. Keep model/provider selection in the host harness rather than hard-coding it into a TLA skill.
