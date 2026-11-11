# Common pitfalls

Small problems that are easy to hit, and what to do instead. Each one came up
while we wrote and tested these recipes.

## Installs and files

- **Installing packages on your machine for containers.** `npm install` or
  `bun install` on macOS (or on a different Linux) installs binaries for that
  platform, and a Linux container cannot load them. Install inside the
  container with a [deps service](deps-service.md).
- **Workspace packages write their own `node_modules`.** Bun and pnpm write a
  `node_modules` folder into each workspace package. Give each one a named
  volume, or the container writes it into your checkout. See
  [Monorepos and workspaces](deps-service.md#monorepos-and-workspaces).
- **A locked install does not repair a damaged one.** `bun install
  --frozen-lockfile` can report `no changes` over a broken package. Use
  `--force`, or remove the volume. See
  [Recover a stale or half-written volume](deps-service.md#recover-a-stale-or-half-written-volume).
- **Root-owned files on Linux.** With Docker Engine on Linux, files a container
  writes into your checkout belong to root. That includes lockfiles changed by
  `hack run deps ...` and the empty `node_modules` mount points Docker creates.
  Fix ownership with `sudo chown "$(id -u):$(id -g)" <file>`. Running the
  service as your user instead also changes who owns its volumes, so the
  installer may no longer be able to write them.
- **The shared cache label does nothing without a platform.** If you see
  `Shared dependency cache disabled`, set `platform` on the `deps` service or
  `DOCKER_DEFAULT_PLATFORM` in your shell.

## Env

- **Editing an env file does not change running containers.** Run
  `hack restart`, or `hack env apply --service <name>`.
- **`hack exec` needs the same `--env` as `hack up`.** `hack restart` and
  `hack down` reuse the overlay the stack started with; `hack exec` refuses a
  different one, and no `--env` means the default overlay.
- **A hook cannot change this start's env.** Hack resolves managed env before
  `up.before` hooks run. A value a hook stores with `hack env add` reaches
  containers on the next start. See [Sign in to another CLI](cli-sign-in.md).
- **Your shell expands `$VAR` before Hack sees it.** In
  `hack run app echo "$APP_ENV"`, the variable comes from your shell, not
  from Hack. Use `hack run app sh -c 'echo "$APP_ENV"'`, or
  `hack host exec --shell '...'` on your machine.
- **Secrets in command arguments.** A token or a connection string with a
  password, passed as an argument (`--token "$TOKEN"`, `psql "$DATABASE_URL"`),
  shows up in process listings. Let the tool read it from the environment Hack
  injects, or from a file.
- **Compose expands `$` in the Compose file.** To use a container variable in
  a `command`, write `$$VAR`.
- **Keep `.hack/hack.env.default.yaml`, even when it is empty.** Without it,
  `hack doctor` warns about a missing env file. `hack init` creates it.

## Networking

- **`localhost` in a container is the container.** Use the Compose service
  name (`db`, `queue`) between containers.
- **Reaching your machine from a container on Linux.** Add
  `extra_hosts: ["host.docker.internal:host-gateway"]`, make the host process
  listen on the Docker bridge address instead of `127.0.0.1`, and allow it in
  your firewall. See [Remote database](remote-database.md#linux-reaching-the-proxy-from-containers).
- **Publishing ports to your whole network.** Write `"127.0.0.1:5432:5432"`,
  not `"5432:5432"`, unless other machines must connect.
- **Routed services need the `hack-dev` network.** Services with Caddy labels
  join the external `hack-dev` network, which `hack global install` creates.
  Without it, `hack up` fails.
- **Global-setup notices in command output.** Until the global proxy is
  installed, `hack run` and `hack exec` print notices such as
  `CoreDNS is not reachable` on stdout, before the command's own output. Filter
  them out before you parse the output.

## Lifecycle

- **Lifecycle processes need tmux.** Hack runs them in a tmux (or zellij)
  session. Install tmux first.
- **A failing `up.after` hook leaves containers running.** `hack up` reports
  the failure; run `hack down` if you want them stopped.
- **Quick tunnel URLs change on every start.** Use a named tunnel for OAuth
  callbacks. See [Tunnels](tunnels.md#oauth-callbacks-and-stable-urls).

## Data and cleanup

- **`hack down` keeps volumes.** Your database survives. To start from an
  empty database, remove its volume. See [Cleanup](cleanup.md).
- **Deleting a worktree does not stop its containers.** Run `hack down` in the
  worktree first. See [Cleanup](cleanup.md#remove-a-worktree-the-clean-way).
- **An overlay name is not isolation.** `--env prodlike` still runs on your
  machine, in the same instance. Use `--branch` for a separate instance.
