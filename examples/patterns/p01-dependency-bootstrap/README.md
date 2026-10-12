# HACK-P01 example: one-shot dependency and generated-artifact bootstrap

Minimal project for catalogue card HACK-P01 (tracked in HACK-1145). It shows the
part of the pattern Hack supports today. The card's disposition is **partial**;
see "What this example does not prove" below.

## Layout

- `install` is a one-shot initializer. It opts into the
  `hack.dependencies.cache-protocol: locked-v1` label, uses a digest-pinned
  installer image with an explicit platform, keeps the default (empty)
  environment, and writes only the `dependencies` volume.
- `generate` is the worktree-specific generation step. It always runs, owns its
  own `generated` volume, and publishes its output by rename.
- `app` starts only after both one-shot services exit successfully. It mounts
  `dependencies` and `generated` read-only and has its own health check.

Installation, generation and application readiness are separate steps. The
verifier label (`require.resolve("greeting")`) checks the real dependency the
application imports, not just a populated directory.

Set `platform` to the platform of your Docker daemon before you run it.

## Commands

Start the project and wait for the detached startup result:

```sh
hack up --json
```

Inspect service state, including the one-shot exits:

```sh
hack ps --json
```

Read the initializer's bounded log:

```sh
hack logs --no-follow --tail 100 install
```

Stop the project. Ordinary `hack down` keeps the dependency volume:

```sh
hack down
```

If an initializer attempt fails or is interrupted, find the cause, then increment
`hack.dependencies.cache-generation` in `.hack/docker-compose.yml` and run
`hack up --json` again. Do not delete protocol markers to force reuse.

## What this example does not prove

- Atomic publication of worktree-specific generated artifacts across concurrent
  writers.
- Installers that need credentials or environment values. `locked-v1` refuses
  explicit `environment` and `env_file` on the initializer.
- Two-worktree or interrupted-writer qualification. Those runtime gates belong to
  WU07/WU11.

The static checks in `tests/pattern-examples.test.ts` validate this config and
its commands. They do not start containers.
