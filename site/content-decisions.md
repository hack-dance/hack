# Content decisions

## Positioning

Hack runs your whole project on your own machine, and runs every project, branch
and git worktree side by side, each at its own HTTPS address. One command
starts a repo. Nothing is hosted. The root `README.md` carries this story in full;
the site homepage and the v5 documentation index repeat it briefly and link out.

The native backend is a proof point, not a headline. It is labelled beta and has
its own section: it runs the same project in a lightweight Linux VM that Hack
manages, without Docker Desktop. Pages never call it a sandbox or a microVM, and
make no speed, memory or battery claim for it.

Pages say "backend" for Compose and native, "instance" for a running copy of a
project, and "prerelease" for a `5.0.0-next.N` build. They do not use "engine",
"provider", "pool" or "candidate" for these in user-facing text. "Isolated" is
always qualified: say what a branch instance gets of its own (containers,
addresses, logs) and what it still shares.

v5 is the same CLI and project model as v4 with a new way to run services. Docker Compose
stays the default backend; the native backend is beta: opt-in, Apple Silicon macOS, `hack-next` channel only. Pages
write `hack` for the v5 CLI and tell prerelease users once, on Install, how to map
that to `hack-next`.

## Product boundary

Supported: the local CLI. Retired: hosted accounts and teams, the web dashboard,
Hack Tickets, built-in GitHub and Linear integrations, and automatic agent
instruction injection. Unsupported: remote, gateway, node and dispatch commands
and the macOS app. Retired and unsupported surfaces appear only in the v5 upgrade
guide's table and are omitted from the curated command reference. The checks in
`scripts/docs/check.ts` refuse a v5 page that publishes retired agent automation
as a runnable recipe.

## Versions

v4 docs are archived at v4.2.4 and describe the stable Compose workflow. v5 docs
are pinned to the latest published prerelease and move forward with
`bun run docs:pin`. Each corpus links only within its own version so that the LLM
exports stay single-version. Field-level reference pages (configuration, MCP,
reports) were audited against `5.0.0-next.5` and say so; they are kept because the
shapes are stable, and they defer to the generated command reference where the two
differ.

## Style

Recipes may be published as editorial pages before a re-pin when every shown
Hack command, flag and configuration field exists in the pinned release. Give
each page explicit source provenance and pin newer example links to that source
commit. Keep a per-page audit in [recipe-compatibility.md](recipe-compatibility.md);
leave recipes that need newer behavior out until the release pin advances.

Plain English. Short pages that answer one question. Commands in fenced blocks
with a sentence saying what to expect. No claims that a build, install or green
check proves application behavior; say what was verified when it matters, and
otherwise leave it out.
