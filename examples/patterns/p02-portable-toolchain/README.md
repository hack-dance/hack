# HACK-P02 example: portable toolchain without an always-on application

Minimal project for catalogue card HACK-P02 (tracked in HACK-1146). It shows the
part of the pattern Hack supports today. The card's disposition is **partial**;
see "What this example does not prove" below.

## Layout

The project has no long-running application. `.hack/docker-compose.yml` declares
one one-shot `toolchain` service behind the opt-in `toolchain` profile:

- a digest-pinned tool image, so every machine runs the same Bun version;
- explicit resource bounds (`cpus`, `mem_limit`);
- separate named volumes for installed dependencies and the Bun download cache;
- no Docker socket, user home, SSH agent or credential directory mounts, and no
  `env_file`. Keep project secrets out of the image build context as well.

## Commands

Install dependencies into the toolchain's own volume:

```sh
hack run --profile toolchain toolchain -- bun install --frozen-lockfile
```

Run the checks:

```sh
hack run --profile toolchain toolchain -- bun test
```

The command's own exit status is the result. Check it directly; do not pipe the
output through a filter that can hide a failed check.

The service is one-shot, so there is nothing to keep running. `hack down` keeps
the named cache volumes.

## What this example does not prove

- Cache reuse across worktrees with bounded eviction.
- A source receipt for linked worktrees, whose `.git` entry is a pointer file
  rather than a directory.
- Owned cache accounting. Those runtime gates belong to WU11.

A test-only source identity override must never reach release evidence.

## How this example is checked

The static checks in `tests/pattern-examples.test.ts` validate this config and
its commands. They do not start containers.

The Docker-tier scenario `pattern-p02-portable-toolchain` in `tests/e2e/` runs
both commands above in the hosted `docker-e2e` job, from the primary checkout
and from a linked worktree. In the linked worktree `/app/.git` is a pointer file
whose target is not mounted, and the checks still pass because they do not need
Git. A failing check exits non-zero, Hack returns the command's exact exit
status, and an ordinary down keeps both instances' cache volumes. Each instance gets
its own caches; cross-worktree reuse is still open. The copy uses the runner's
cached `oven/bun:1.4.2-slim` digest instead of the pinned Alpine image, and
never pulls.
