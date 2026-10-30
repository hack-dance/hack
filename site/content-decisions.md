# Public content decisions

The homepage is a minimal index: `hack.foo` opens the documentation, with task
links below the first viewport. System monospace type, ordinary scrolling and
keyboard navigation keep access independent of animation.

## Positioning sources

- `README.md` and commit `a83c0fbdbe64a79beb72ab2e260b4775d6181bd9` establish the whole-project story: services, environment, secrets, local HTTPS and logs.
- Commit `d82ae58221c137402bea1529f94cd93eb9815a82` explains why the environment leads and URLs support that story.
- Commit `99a4b96c7764a4c35eab88b1f799ac6f04058c27` carries that positioning into the docs index.
- `AGENTS.md`, `docs/docs-ia.md` and `docs/guides/v5-dogfooding.md` define current support boundaries. Historical remote, hosted account and Tickets plans do not override them.

These are committed editorial sources, not proof that every historical phrase was
approved by a user. No standalone ignored positioning draft was recovered in the
bounded October 30 search. Private archive contents are not publication inputs.

## Curation

`docs/README.md` groups first setup, daily work, troubleshooting, experimental v5
and contributing. `docs/core.md` explains the project model and basic commands.
Contributor dependency-inventory instructions no longer interrupt the user index;
the existing script remains available in the repository.

`scripts/docs/versions.json` now defines separate explicit publication allowlists; the earlier 25-document manifest is historical.
Canonical Markdown is staged into Fumadocs, search and LLM exports. Internal plans,
benchmark receipts and historical design notes stay outside that allowlist. Stable
Compose setup leads; native v5 installation and project adoption remain separate
and experimental. A site build is not a runtime acceptance or release claim.

## Explicit-agent v5 publication choice

The recommended v5 setup is CLI plus versioned docs, with separately selected
skills or MCP. Editorial overrides replace the pinned integrations, agent-first,
project-setup, core and CLI-overview tutorials. The new integrations page links
the reviewed next.5 native marketplace and manifests, names the exact seven
skills, and distinguishes local source registration from client installation.
The official OpenAI packaging guide supplies the local marketplace registration
command and client-directory route; no client loading was performed here.

Next.5 is not a hook-free artifact: its Codex manifest selects skills, whose text
still includes guidance-maintenance recommendations; Claude selects primer hooks
and Cursor selects rules. Core removal is a separate, pending dependency. The
short historical compatibility page records shipped availability and source
links without a runnable repair/export tutorial.

Eight agent-management leaves and init's optional handoff flag are intentionally
omitted from the recommended v5 command reference and LLM corpus. Setup-sync
report types are also excluded from that slice. V4 and every hashed original
remain intact; this editorial choice does not assert runtime removal in next.5.
Env injection, lifecycle definition freshness and runtime ownership are unrelated
and remain documented.

Publication checks exercise both versions, reject retiring command/flag/tutorial
patterns in staged v5 pages and full LLM exports, preserve unrelated runtime
language, and require the explicit plugin/MCP artifact boundaries. All original
manifest hashes are checked even when an editorial override replaces a page.
