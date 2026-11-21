# Global settings

Machine-wide settings live in `~/.hack/hack.config.json`. Use the CLI instead of
editing the file by hand:

```bash
hack config get --global sessions.mux
hack config set --global sessions.mux tmux
```

Automatic settings updates, including `hack env backend use`, create a missing
global config but refuse to replace an existing unreadable file, malformed JSON or
a non-object JSON value. An empty file is invalid JSON. Repair the reported file
before retrying; a failed update preserves its contents.

Common settings:

- `sessions.mux` (default `auto`; `auto|tmux|none`) — multiplexer for `hack session`.
- `controlPlane.tui.logs.maxEntries` (default `2000`) — log buffer cap in `hack tui`.
- `controlPlane.tui.logs.maxLines` (default `400`) — rendered log lines cap.
- `controlPlane.tui.logs.historyTailStep` (default `200`) — history page size.
- `controlPlane.usage.watchIntervalMs` (default `2000`) — sample interval for `hack usage --watch`.
- `controlPlane.usage.historySize` (default `24`) — sample history for `hack usage --watch`.
- `logging.enabled` (`true|false`; default unset) — whether Hack runs the
  global logging stack (Loki, Alloy and Grafana). It is opt-in. While it is
  unset, a home without `~/.hack/logging/` has it off, and a home that has that
  directory (every earlier `hack global install` created it) keeps it. The
  first `hack global install` or `hack global up` in such a home saves
  `true`, so moving files aside later does not turn it off.
  `hack global up --logging` saves `true`, writes the stack's files if needed
  and starts it. `hack global up --no-logging` saves `false` and stops this
  home's logging containers, found by their Compose labels (project
  `hack-logging` and this home's `~/.hack/logging` as working directory), so
  even a stack whose files are gone is stopped, and another Hack home's stack
  on the same engine is not. If a save fails, the run still follows the
  choice, routing starts, and a warning says the setting was not saved.
  Turning it off keeps the stack's volumes (logs, Grafana state);
  `hack global logs-reset` removes them. With logging off and no logging
  files, `logs-reset` lists any `hack-logging` volumes Docker still has with
  the `docker volume rm` to run, deletes none (Compose does not record which
  home made a volume) and exits non-zero. The logging Compose file
  (`~/.hack/logging/docker-compose.yml`) is Hack's output, like the proxy's:
  install and `up --logging` rewrite it without asking (an engine upgrade
  changes its healthchecks), keeping a `.bak-<UTC time>` copy when it was not
  Hack's rendering. The configs beside it (Loki, Alloy, Grafana) still ask
  before an overwrite. With it off, plain
  `hack logs` and `hack logs --since/--until` read container logs (`d` and
  `w` units become hours, which Docker accepts), and
  `hack logs --loki`/`--query` and `hack open logs` fail with `E_LOGGING_OFF`,
  naming the command that turns the stack on. `hack global status` still asks
  Docker and reports containers that run while the setting says off. A Loki
  named by `HACK_LOKI_URL` is used whatever this says. `hack config set`
  accepts only `true` or `false` here.
  See [the opt-in state chart](../diagrams/global-logging-optin.svg) and the
  model in `tests/models/tla/global-logging-optin`.
- `proxy.bind_address` (default unset: Docker's default, every IPv4 and IPv6
  interface, for a new proxy file) — host address the global
  Caddy proxy publishes ports 80 and 443 on. Accepts one IPv4 or IPv6 address,
  such as `127.0.0.1` or `::1`. Set it when another program already listens on
  :443 on some address (a VPN client, for example) and the proxy fails to start.
  An address other than every interface stops LAN and tunnel clients from
  reaching the proxy through this host, and on macOS a host DNS fallback to
  `127.0.0.1` needs the proxy on loopback. Apply a change with
  `hack global install`, with or without a terminal: it rewrites the proxy
  compose file (`~/.hack/caddy/docker-compose.yml`) without asking, and Compose
  recreates the proxy with the new ports. `hack doctor --fix` does the same.
  That file is Hack's output; when it differs from Hack's current rendering
  (edited by hand, or written by an older Hack), the previous copy is kept as
  `docker-compose.yml.bak-<UTC time>` (or `-N` on a name clash) beside it
  before the rewrite. While this setting is unset, an existing file is never
  widened: if every proxy port names the same host address (any Compose
  syntax, `0.0.0.0` and `::` included), that address is saved as
  `proxy.bind_address` first; if the binding cannot be determined (mixed
  addresses, no proxy ports, invalid YAML), the file is left unchanged with a
  warning. Unsetting the setting alone therefore does not widen a restricted
  proxy. `0.0.0.0` publishes on every IPv4 interface. To return to
  Docker's default (IPv4 and IPv6), unset the setting and move
  `~/.hack/caddy/docker-compose.yml` aside before `hack global install`; a
  missing file is never migrated.

When `hack global up` or `hack global install` cannot start the proxy, it lists
the listeners holding ports 80 and 443 (address, process and pid when the OS
reports them), names this setting and exits non-zero. Install then stops before
DNS and trust setup and prints no next steps. A proxy container that was created
but never started is removed, so the next attempt creates it fresh; if Docker
refuses that, the command prints the `docker rm` to run. `hack doctor --fix`
does the same when it cannot start the proxy. If only the logging stack fails,
install still sets up DNS and trust, then exits non-zero without next steps.

Project-level settings live in `.hack/hack.config.json` and override global ones
where both apply. Settings for the unsupported gateway, cluster and cloud-provider
extensions also live here under `controlPlane.*`; see
[unsupported retained surfaces](../extensions.md).
