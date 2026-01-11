# Extensions & SDK (v0.1)

This doc defines the extension surface area for `hack` and how extension commands are authored,
configured, and dispatched.

## Quick start (one command)

If you just want remote access working, start here:

```bash
hack remote setup
```

The wizard enables the gateway for the current project, creates a token + QR, and can configure
Cloudflare/Tailscale/SSH exposure in one flow.

## Behavior

- Built-in extensions are registered in `src/control-plane/extensions/builtins.ts`.
- Each extension provides a manifest + commands (`ExtensionDefinition`).
- The CLI dispatches extension commands via `hack x <namespace> <command>`.
- Global enablement lives in `~/.hack/hack.config.json` (`hack config set --global ...`).
- Per-project overrides live in `.hack/hack.config.json` and typically win over global values
  (except global-only extensions like Cloudflare/Tailscale, which ignore project overrides).
- Built-in Gateway enablement is project-scoped: `controlPlane.gateway.enabled` opts a project into routing.

## Extension definition (API surface)

Types live in `src/control-plane/extensions/types.ts`.

```ts
export type ExtensionDefinition = {
  readonly manifest: ExtensionManifest
  readonly commands: readonly ExtensionCommand[]
}

export type ExtensionCommand = {
  readonly name: string
  readonly summary: string
  readonly description?: string
  readonly scope: "global" | "project"
  readonly handler: (input: {
    readonly ctx: ExtensionCommandContext
    readonly args: readonly string[]
  }) => Promise<number>
}
```

The `ExtensionCommandContext` includes:
- `controlPlaneConfig` (parsed config)
- `projectId` and `projectName` (when available)
- `logger` and `cwd`

## Config + enablement

Global `controlPlane` lives in `~/.hack/hack.config.json` and is parsed by
`src/control-plane/sdk/config.ts`. Per-project overrides use `.hack/hack.config.json`.

Enable a global extension by id:

```json
{
  "controlPlane": {
    "extensions": {
      "dance.hack.gateway": { "enabled": true }
    }
  }
}
```

Shortcut for gateway (project-scoped):

```json
{
  "controlPlane": {
    "gateway": { "enabled": true }
  }
}
```

Global-only extensions (e.g. Cloudflare, Tailscale) must be configured in the global config.
Project overrides for these are ignored.

CLI helpers:
- `hack gateway enable` (sets both gateway + extension flags)
- `hack gateway setup` (guided enable + optional writes + token creation + QR by default)
- `hack config set --global 'controlPlane.extensions[\"dance.hack.gateway\"].enabled' true`

## Dispatch model

`hack x` resolves namespaces and dispatches to the registered command handler:

```
hack x <namespace> <command> [args...]
```

Use `hack x <namespace> help` to list commands.

## Built-in extensions (current)

- Gateway: `hack x gateway token-create|token-list|token-revoke`
- Supervisor: `hack x supervisor job-create|job-list|job-show|job-tail|job-attach|job-cancel|shell`
- Cloudflare: `hack x cloudflare tunnel-print|tunnel-setup|tunnel-start|tunnel-stop|access-setup`
- Tailscale: `hack x tailscale setup|status|ip`
- Tickets: `hack x tickets setup|create|update|list|show|status|sync|tui` (see `docs/guides/tickets.md`)

Gateway tokens default to `read` scope. Use `--scope write` to permit non-GET requests (also
requires global `controlPlane.gateway.allowWrites = true`).

Current gateway API surface (HTTP/WS):
- `GET /v1/status`, `GET /v1/metrics`, `GET /v1/projects`, `GET /v1/ps`
- `GET/POST /control-plane/projects/:id/jobs`
- `GET /control-plane/projects/:id/jobs/:jobId`
- `POST /control-plane/projects/:id/jobs/:jobId/cancel`
- `WS /control-plane/projects/:id/jobs/:jobId/stream`
- `POST /control-plane/projects/:id/shells`
- `GET /control-plane/projects/:id/shells/:shellId`
- `WS /control-plane/projects/:id/shells/:shellId/stream` (requires write token + allowWrites)

Interactive shell/TTY is available via the shell stream endpoints; use
`hack x supervisor shell` or see protocol below.

For full usage guidance and structured workflow patterns, see `gateway-api.md`.

For exposure helpers, see the guides:
- `guides/remote-cloudflare.md`
- `guides/remote-tailscale.md`
DNS note: Cloudflare Tunnel uses a CNAME (`<tunnel-id>.cfargotunnel.com`) in your Cloudflare zone.

## Command reference

### Gateway extension (`hack x gateway`)

#### token-create

Usage: `hack x gateway token-create [options] [label]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--scope <read|write>` | string | `read` | Token scope |
| `--write` | boolean | false | Shortcut for `--scope write` |
| `--label <label>` | string | - | Optional label |

Notes:
- The first non-flag argument is treated as the label if `--label` is not used.

#### token-list

Usage: `hack x gateway token-list`

#### token-revoke

Usage: `hack x gateway token-revoke <token-id>`

### Supervisor extension (`hack x supervisor`)

All supervisor commands accept `--project <name>` or `--path <dir>` (mutually exclusive).

#### job-list

Usage: `hack x supervisor job-list [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--project <name>` | string | - | Target a registered project |
| `--path <dir>` | string | - | Target a repo path |
| `--json` | boolean | false | Output JSON |

#### job-create

Usage: `hack x supervisor job-create [options] -- <command...>`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--project <name>` | string | - | Target a registered project |
| `--path <dir>` | string | - | Target a repo path |
| `--runner <name>` | string | `generic` | Runner name |
| `--cwd <path>` | string | - | Working directory (relative to project root) |
| `--env <KEY=VALUE>` | string | - | Environment override (repeatable) |
| `--json` | boolean | false | Output JSON |

#### job-show

Usage: `hack x supervisor job-show <job-id> [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--project <name>` | string | - | Target a registered project |
| `--path <dir>` | string | - | Target a repo path |
| `--json` | boolean | false | Output JSON |

#### job-cancel

Usage: `hack x supervisor job-cancel <job-id> [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--project <name>` | string | - | Target a registered project |
| `--path <dir>` | string | - | Target a repo path |

#### job-tail

Usage: `hack x supervisor job-tail <job-id> [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--project <name>` | string | - | Target a registered project |
| `--path <dir>` | string | - | Target a repo path |
| `--follow` | boolean | true | Follow logs (default) |
| `--no-follow` | boolean | false | Print logs and exit |
| `--logs-from <n>` | number | 0 | Resume from log offset |
| `--from <n>` | number | 0 | Alias for `--logs-from` |
| `--json` | boolean | false | Output JSON |

#### job-attach

Usage: `hack x supervisor job-attach <job-id> [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--project <name>` | string | - | Target a registered project |
| `--path <dir>` | string | - | Target a repo path |
| `--follow` | boolean | true | Follow logs (default) |
| `--no-follow` | boolean | false | Print logs and exit |
| `--logs-from <n>` | number | 0 | Resume from log offset |
| `--from <n>` | number | 0 | Alias for `--logs-from` |
| `--events-from <n>` | number | 0 | Resume from event sequence |
| `--json` | boolean | false | Output JSON |

#### shell

Usage: `hack x supervisor shell [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--project <name>` | string | - | Target a registered project |
| `--project-id <id>` | string | - | Target by project id (gateway) |
| `--path <dir>` | string | - | Target a repo path |
| `--gateway <url>` | string | `http://127.0.0.1:7788` | Gateway URL |
| `--token <token>` | string | - | Gateway write token |
| `--shell <path>` | string | - | Shell path |
| `--cwd <path>` | string | - | Working directory |
| `--cols <n>` | number | - | Terminal columns |
| `--rows <n>` | number | - | Terminal rows |
| `--env <KEY=VALUE>` | string | - | Environment override (repeatable) |

Notes:
- `--project` and `--project-id` are mutually exclusive.

### Cloudflare extension (`hack x cloudflare`)

#### tunnel-print

Usage: `hack x cloudflare tunnel-print [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--hostname <host>` | string | - | Gateway hostname |
| `--tunnel <name>` | string | `hack-gateway` | Tunnel name |
| `--origin <url>` | string | `http://127.0.0.1:7788` | Gateway origin |
| `--ssh-hostname <host>` | string | - | SSH hostname (optional) |
| `--ssh-origin <url>` | string | `ssh://127.0.0.1:22` | SSH origin |
| `--credentials-file <path>` | string | - | Cloudflared credentials file |
| `--out <path>` | string | - | Write config to a file |

#### tunnel-setup

Usage: `hack x cloudflare tunnel-setup [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--hostname <host>` | string | - | Gateway hostname |
| `--tunnel <name>` | string | `hack-gateway` | Tunnel name |
| `--origin <url>` | string | `http://127.0.0.1:7788` | Gateway origin |
| `--ssh-hostname <host>` | string | - | SSH hostname (optional) |
| `--ssh-origin <url>` | string | `ssh://127.0.0.1:22` | SSH origin |
| `--credentials-file <path>` | string | - | Cloudflared credentials file |
| `--out <path>` | string | - | Write config to a file |
| `--skip-login` | boolean | false | Skip `cloudflared tunnel login` |
| `--skip-create` | boolean | false | Skip tunnel creation |
| `--skip-route` | boolean | false | Skip DNS route creation |

#### tunnel-start

Usage: `hack x cloudflare tunnel-start [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--config <path>` | string | `~/.cloudflared/config.yml` | Config path |
| `--out <path>` | string | - | Alias for `--config` |
| `--tunnel <name>` | string | - | Override tunnel name |

#### tunnel-stop

Usage: `hack x cloudflare tunnel-stop`

#### access-setup

Usage: `hack x cloudflare access-setup [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--ssh-hostname <host>` | string | - | SSH hostname |
| `--user <user>` | string | - | SSH username |

### Tailscale extension (`hack x tailscale`)

#### setup

Usage: `hack x tailscale setup`

#### status

Usage: `hack x tailscale status [args...]`

#### ip

Usage: `hack x tailscale ip [args...]`

Notes:
- `status` and `ip` forward extra args directly to `tailscale`.
- `ip` defaults to `-4` when no args are provided.

### Tickets extension (`hack x tickets`)

A lightweight, git-backed ticket log stored in `.hack/tickets/` and syncable via a dedicated git ref (`refs/hack/tickets` hidden by default).

Guide: `docs/guides/tickets.md`

#### setup

Usage: `hack x tickets setup [--global] [--agents|--claude|--all] [--check|--remove] [--json]`

#### create

Usage: `hack x tickets create --title "..." [--body "..."] [--body-file <path>] [--body-stdin] [--depends-on "T-00001"] [--blocks "T-00002"] [--actor "..."] [--json]`

#### update

Usage: `hack x tickets update <ticket-id> [--title "..."] [--body "..."] [--body-file <path>] [--body-stdin] [--depends-on "T-00001"] [--blocks "T-00002"] [--clear-depends-on] [--clear-blocks] [--actor "..."] [--json]`

#### list

Usage: `hack x tickets list [--json]`

#### tui

Usage: `hack x tickets tui`

#### show

Usage: `hack x tickets show <ticket-id> [--json]`

#### status

Usage: `hack x tickets status <ticket-id> <open|in_progress|blocked|done> [--actor "..."] [--json]`

#### sync

Usage: `hack x tickets sync [--json]`

## Gateway exposure (optional)

The gateway binds to `127.0.0.1` by default. Expose it through one of:

- SSH tunnel (ad‑hoc): `ssh -L 7788:127.0.0.1:7788 <host>`
- Zero Trust/VPN (persistent): Tailscale, Cloudflare, etc. targeting the gateway port
- Optional Caddy route for local convenience (`https://gateway.hack`):
  - Add a small labeled container in the global Caddy compose that proxies to
    `host.docker.internal:7788` (or `host-gateway` on Linux).

Keep tokens read-only unless you explicitly need writes.

Recommended order:
1) Start with SSH tunneling for quick remote access.
2) Move to a private Zero Trust/VPN network once you want persistent access.
3) Add the Caddy route only for nicer local URLs (not required for remote access).

Remote helper commands:
- `hack remote status` shows gateway + exposure status.
- `hack remote qr` emits QR payloads for SSH or gateway clients.

## Supervisor streaming output (JSON)

`hack x supervisor job-tail --json` and `job-attach --json` emit line-delimited JSON events:

```
{"type":"start","jobId":"...","logsOffset":0,"eventsSeq":0}
{"type":"log","stream":"combined","offset":128,"data":"..."}
{"type":"event","seq":3,"event":{"type":"job.started", ...}}
{"type":"heartbeat","ts":"...","logsOffset":128,"eventsSeq":3}
{"type":"end","jobId":"...","logsOffset":256,"eventsSeq":5}
```

Use the latest `logsOffset`/`eventsSeq` for resume flags.

## Shell stream protocol (JSON)

Client → server (JSON frames):

```
{"type":"hello","cols":120,"rows":30}
{"type":"input","data":"ls -la\n"}
{"type":"resize","cols":160,"rows":40}
{"type":"signal","signal":"SIGINT"}
{"type":"close"}
```

Server → client:

```
{"type":"ready","shellId":"...","cols":120,"rows":30,"cwd":"/repo","shell":"/bin/zsh","status":"running"}
{"type":"output","data":"..."} 
{"type":"exit","exitCode":0,"signal":null}
```

Non-JSON text frames are treated as raw input.
