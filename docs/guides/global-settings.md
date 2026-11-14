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
- `proxy.bind_address` (default unset: every interface) — host address the global
  Caddy proxy publishes ports 80 and 443 on. Accepts one IPv4 or IPv6 address,
  such as `127.0.0.1` or `::1`. Set it when another program already listens on
  :443 on some address (a VPN client, for example) and the proxy fails to start.
  An address other than every interface stops LAN and tunnel clients from
  reaching the proxy through this host, and on macOS a host DNS fallback to
  `127.0.0.1` needs the proxy on loopback. Apply a change with
  `hack global install` in a terminal and answer yes to rewrite the proxy
  compose file; Compose then recreates the proxy with the new ports. Install
  and `hack doctor --fix` render that file from this setting, so they never
  revert it.

When `hack global up` cannot start the proxy, it lists the listeners holding
ports 80 and 443 (address, process and pid when the OS reports them) and names
this setting.

Project-level settings live in `.hack/hack.config.json` and override global ones
where both apply. Settings for the unsupported gateway, cluster and cloud-provider
extensions also live here under `controlPlane.*`; see
[unsupported retained surfaces](../extensions.md).
