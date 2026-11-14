# Observe-only global status

`hack global status --json --observe` reports routing, DNS and proxy state for
callers that poll: scripts, agents and the desktop app. It never starts Docker, a
container, `hackd`, a VM or a service, and it never prompts. Plain
`hack global status` can start Docker (it offers to start a stopped Docker backend
and accepts in non-interactive runs), so pollers use this mode instead.

`--observe` needs `--json`; without it the command exits 2.

## What it runs

Only these read-only probes, each bounded:

| Probe | When | Bound |
|---|---|---|
| `docker info --format {{.ServerVersion}}` | always, if `docker` is on `PATH` | 3 s |
| `docker compose -f <file> ps --format json` (Caddy, logging) | Docker answered and the stack's file exists | — |
| `docker network ls --format json` | Docker answered | — |
| `docker ps …` / `docker inspect …` (proxy network, Caddy address) | Docker answered | — |
| Linux: `systemctl is-active systemd-resolved`, `systemctl --version`, `systemctl show …`, `ip -j -4 addr show`, `resolvectl <verb> -- <link>` | Linux | 3 s each |
| macOS: `brew --prefix`; reads `/etc/resolver/<tld>` and `dnsmasq.conf`; one DNS query to `127.0.0.1:53` | macOS | 0.9 s query |

When `docker info` does not answer, Docker is asked nothing else and every
Docker-derived part is `"unknown"`. `tests/global-status-observe.test.ts` runs the
CLI with every child process recorded and fails on any program or argv outside
this list, including any runtime starter (`open -a Docker`, `colima start`,
`orb start`, `sudo systemctl start docker`).

## Shape (`hack.global-status.observe.v1`)

Every `*_ok` and `ok` field is `true`, `false` or `"unknown"`. Unknown means Hack
could not tell; it is never reported as absent or as a failure of the thing.

```json
{
  "schema": "hack.global-status.observe.v1",
  "generated_at": "2026-11-14T00:00:00.000Z",
  "observe": true,
  "platform": "linux",
  "docker": { "state": "running", "detail": null },
  "caddy": { "ok": true, "error": null, "services": [] },
  "logging": { "ok": true, "error": null, "services": [] },
  "networks": { "ok": true, "missing": [], "networks": [] },
  "proxy_network": { "ok": true, "readable": true, "issues": [] },
  "host_dns": { "platform": "linux", "state": "configured", "ok": true },
  "summary": {
    "docker_ok": true,
    "caddy_ok": true,
    "logging_ok": true,
    "networks_ok": true,
    "proxy_network_ok": true,
    "host_dns_ok": true,
    "ok": true
  }
}
```

| Field | Values |
|---|---|
| `docker.state` | `running`; `not_running` (the CLI could not reach the engine; `detail` holds its first error line); `not_installed` (no `docker` on `PATH`); `unknown` (no answer within 3 s) |
| `docker_ok` | `true` when running, `false` when not running or not installed, `"unknown"` on timeout |
| `caddy`, `logging` | Docker's view of the stack (`services[]` as in `hack global status --json`); `ok: false` with `error: "Missing <file> (run: hack global install)"` when the stack was never installed; `ok: "unknown"` with the reason when Docker did not answer or the read failed |
| `networks` | `missing[]` lists absent Hack networks; unknown as above |
| `proxy_network` | the proxy containers' network addresses (`issues[]`); unknown as above |
| `host_dns` (Linux) | `state` from the Linux DNS route check (`configured`, `missing`, `stale`, `bridge_missing`, `not_applied`, `manual`), plus `resolver`, `code`, `link`, `message`, `fix[]`. `ok`: `configured` is `true`, `manual` (a resolver Hack does not manage) is `"unknown"`, every other state is `false` |
| `host_dns` (macOS) | `state`: `configured`, `not_configured` or `unknown`, and `checks[]`: the `resolver:<tld>`, `dnsmasq.conf:<tld>` and `dnsmasq:53` results `hack doctor` reports. `ok` is `true` when all pass, `"unknown"` when a check could not look (no Homebrew to locate `dnsmasq.conf`) and nothing failed, else `false`. A dynamic Caddy address is only looked up when Docker answered |
| `host_dns` (other) | `state: "unknown"`, `ok: "unknown"` |
| `summary.ok` | `false` if any part is `false`; otherwise `"unknown"` if any part is; otherwise `true` |

Exit code: 0 whenever the JSON was printed, whatever it says; read the `ok`
fields.

Not included: the gateway section of plain `hack global status --json` (it reads
the daemon and token store and is not routing state).
