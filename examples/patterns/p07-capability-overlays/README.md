# HACK-P07 example: laptop and headless-runner capability overlays

Minimal project for catalogue card HACK-P07 (tracked in HACK-1151). It shows the
part of the pattern Hack supports today. The card's disposition is **partial**;
see "What this example does not prove" below.

## Layout

`.hack/docker-compose.yml` is the one shared topology: an `api` service that
depends on a healthy `upstream` service. Neither overlay changes it.

The env files express only what differs between machines:

- `.hack/hack.env.default.yaml` holds the shared topology values, such as the
  upstream URL. Overlays must not redefine them.
- `.hack/hack.env.laptop.yaml` allows an interactive browser sign-in.
- `.hack/hack.env.runner.yaml` disables browser sign-in and selects a
  non-interactive auth mode for a headless runner.

The `api` health check passes only when the API can reach `upstream`, so
readiness includes the dependency on both machines.

## Commands

Inspect where a value comes from on each machine. The output names the source
file, precedence and delivery target, never the value:

```sh
hack env explain AUTH_MODE --env laptop --json
hack env explain AUTH_MODE --env runner --target compose --json
```

Start the shared topology with the overlay for the machine you are on:

```sh
hack up --env laptop --json
hack up --env runner --json
```

Check what the running containers actually received:

```sh
hack exec api -- bun -e "console.log(await (await fetch('http://127.0.0.1:3000/')).text())"
```

Read the API's bounded log:

```sh
hack logs --no-follow --tail 100 api
```

A worktree-local file such as `.hack/hack.env.runner.local.yaml` overrides the
shared overlay. In a linked worktree, Hack also reads the primary checkout's
local files. `hack env explain` shows that file as the source, so an inherited
override stays visible.

## What this example does not prove

- A laptop/headless capability contract that Hack enforces. The overlays here
  are labels for env files; Hack does not check which machine selected them.
- A headless machine identity. The runner overlay only selects a
  non-interactive auth mode; issuing that identity belongs to WU27/WU30.

Host env is not evidence of container delivery: check the container, as the
command above does, instead of the shell that ran `hack up`.

## How this example is checked

The static checks in `tests/pattern-examples.test.ts` validate the config, the
commands above and the overlay split: overlays declare the same keys, never
redefine a shared value, and hold no secrets.

The Docker-tier scenario `pattern-p07-capability-overlays` in `tests/e2e/`
starts the laptop overlay in the primary checkout and the runner overlay in a
linked worktree in the hosted `docker-e2e` job. It checks that `hack env explain`
names each source file without printing values, including an inherited
primary-local runner override. It also checks that the containers' metadata
carries each overlay's keys, that both APIs reach `upstream`, and that no Hack
command tries to open a browser. The copy uses the runner's cached
`oven/bun:1.4.2-slim` digest instead of the pinned Alpine image, and never
pulls.
