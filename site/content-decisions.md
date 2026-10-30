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
