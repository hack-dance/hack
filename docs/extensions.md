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
- Tickets: scaffolding only (commands pending)

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
