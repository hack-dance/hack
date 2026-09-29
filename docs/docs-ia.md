# Documentation scope

Public documentation describes supported local CLI workflows, configuration,
architecture, optional agent integrations and contributor verification.

- Add user guides under `docs/guides/` and link them from the relevant index.
- Keep exhaustive CLI flags in the generated `docs/reference/cli.md`; regenerate
  from command definitions rather than editing it manually.
- Keep contributor workflows in `AGENTS.md` and real skills in `.ai/skills/`.
- Keep internal plans, specs, reviews and benchmark receipts in gitignored `_docs/`.
  These files are local-only and must not be required by public tests or builds.
- Preserve executable specifications and test fixtures under `tests/`; they are
  maintained verification assets, not historical planning documents.
- Do not restore retired hosted features or unsupported remote walkthroughs to
  onboarding. The exhaustive generated reference may still describe retained commands.

See the [documentation index](README.md) for supported guides.
