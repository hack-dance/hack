# Observe-only global status

`hack global status --json --observe` reports routing, DNS and proxy state for
callers that poll: scripts, agents and the desktop app. It never starts Docker, a
container, `hackd`, a VM or a service, and it never prompts. Plain
`hack global status` can start Docker (it offers to start a stopped Docker backend
and accepts in non-interactive runs), so pollers use this mode instead.

`--observe` needs `--json`; without it the command exits 2.

## What it runs

Only these read-only probes. Each has its own deadline; a probe that misses it is
stopped (its process group gets a short termination grace) and its part reports
`"unknown"`.

| Probe | When | Deadline |
|---|---|---|
| `docker info --format {{.ServerVersion}}` | `docker` is on `PATH` | 3 s |
| `docker compose -f <stack file> ps --format json` (Caddy, logging, proxy) | Docker answered and the stack's file exists | 5 s each |
| `docker inspect <container ids>` (proxy network) | the proxy stack has containers | 5 s |
| `docker network ls --format json` | Docker answered | 5 s |
| `docker ps -q --filter …caddy…`, `docker inspect --format … <id>` (Caddy's address, macOS dnsmasq check) | macOS, Docker answered, and a dnsmasq line names an address other than the static ones | 5 s each |
| Linux: `systemctl is-active systemd-resolved`, `systemctl --version`, `systemctl show -p NeedDaemonReload -- <unit>`, `ip -j -4 addr show`, `resolvectl {dns,domain,default-route,dnssec,dnsovertls} -- <link>` | Linux | 3 s each |
| macOS: `brew --prefix`; reads `/etc/resolver/<tld>` and `dnsmasq.conf`; a DNS question to `127.0.0.1:53` (AAAA, then A when AAAA has no answer) | macOS | 3 s; 0.9 s per question |

When `docker info` does not answer, Docker is asked nothing else and every
Docker-derived part is `"unknown"`. `tests/global-status-observe.test.ts` runs the
CLI with every child process recorded and fails on any argv outside these exact
shapes (fixed words exactly; only the file, link, unit and container-id positions
vary). That includes any runtime starter (`open -a Docker`, `colima start`,
`sudo systemctl start docker`) and any mutating verb (`resolvectl revert`,
`docker compose up`).

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
| `caddy`, `logging` | Docker's view of the stack (`services[]` as in `hack global status --json`). `ok: false` with `error: "Missing <file> (run: hack global install)"` only when the stack's file is confirmed missing. `ok: "unknown"` with the reason when the file cannot be read, Docker did not answer, or `compose ps` failed or timed out |
| `networks` | `missing[]` lists Hack networks Docker confirmed absent; `ok: "unknown"` (and an empty `missing[]`) when `network ls` failed or timed out |
| `proxy_network` | the proxy containers' network addresses (`issues[]`); `false` only when the Caddy file is confirmed missing; unknown as above |
| `host_dns` (Linux) | `state` from the Linux DNS route check (`configured`, `missing`, `stale`, `bridge_missing`, `not_applied`, `manual`), plus `resolver`, `code`, `link`, `message`, `fix[]` and `unreadable[]` (each read the answer rested on that failed: a probe that errored or timed out, a file or directory that exists but could not be read). `ok`: `configured` is `true`; `manual` (a resolver Hack does not manage), or any other state with a non-empty `unreadable[]`, is `"unknown"`; every other state is `false` |
| `host_dns` (macOS) | `state`: `configured`, `not_configured` or `unknown`, and `checks[]` of `{name, outcome, message}` for `resolver:<tld>`, `dnsmasq.conf:<tld>` and `dnsmasq:53`, with `outcome` `ok`, `missing` (confirmed absent or different; for `dnsmasq:53`, no answer) or `unknown` (a file that exists but cannot be read, no Homebrew prefix, or a dnsmasq line whose address only Docker could confirm while Docker did not answer). `ok` is `false` if any check is missing, otherwise `"unknown"` if any is unknown, otherwise `true` |
| `host_dns` (other) | `state: "unknown"`, `ok: "unknown"` |
| `summary.ok` | `false` if any part is `false`; otherwise `"unknown"` if any part is; otherwise `true` |

Exit code: 0 whenever the JSON was printed, whatever it says; read the `ok`
fields.

Not included: the gateway section of plain `hack global status --json` (it reads
the daemon and token store and is not routing state).
