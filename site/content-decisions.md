# Content decisions

## Positioning

The headline is "Hack on your project, not your setup." The description is: "One
command starts your API, your database and the tunnel to staging, and catches the
sign-in you forgot. Every branch gets its own running copy. One config, any
machine. Docker optional." Both live in `site/lib/home.ts`, which the home page
and the site metadata share.

The home page (`site/app/page.tsx`) describes Hack 5.0 as it is being built. It is
reviewed against the product before the 5.0 release. Its install commands are the
real ones: the pinned v5 prerelease installer and the stable v4 Homebrew command.
Every performance and resource figure it shows is recorded in
`site/lib/home-numbers.ts` with whether it has been measured. No figure about
another product is published without a measurement: the comparisons on the home
page stay off until `COMPARISONS_MEASURED` in that file is set.

The rest of this section is about the root `README.md` and the documentation
pages. They share the home page's headline and open with one sentence: "Hack
runs your whole project from one folder committed with the code: the services,
the settings and encrypted secrets, and the helpers around them. Every branch
and git worktree runs side by side at its own HTTPS address, and the same folder
starts the project on another machine with Docker." The README puts the headline
on the first line under its title, then that sentence. The documentation indexes
(`docs/versions/v5/index.md` and `docs/README.md`) open with the sentence, then
"Nothing is hosted." The README carries the story in full; the indexes repeat it
briefly and link out.

Unlike the home page, the README and the documentation describe only what works
in the current prerelease and in stable v4. A feature planned for 5.0 that the
pinned prerelease does not have stays out of them until a release has it.
`docs/reference/cli.md` is generated and decides whether a command or flag
exists. They make no speed or memory claim, and use no client, project, person
or host name.

The native backend is a proof point, not a headline. It is labelled beta and has
its own section: it runs the same project in a lightweight Linux VM that Hack
manages, without Docker Desktop. Documentation pages never call it a sandbox or a
microVM, and make no speed, memory or battery claim for it.

Documentation pages say "backend" for Compose and native, "instance" for a running
copy of a project, and "prerelease" for a `5.0.0-next.N` build. A page's first
mention may say "running copy" and then name the instance; the glossary in
`docs/core.md` defines the term. They do not use
"engine", "provider", "pool" or "candidate" for these in user-facing text.
"Isolated" is always qualified: say what a branch instance gets of its own
(containers, addresses, logs) and what it still shares.

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
