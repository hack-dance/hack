# Admin plans: `hack global install|trust --plan --json`

`--plan` prints the steps a `hack global` command would take, in order, with the
exact command line of every step that runs with administrator rights, and runs
none of them. A script or app shows the plan and hands root steps to a terminal.

Use `hack global install --plan --json` or `hack global trust --plan --json`
on macOS and Linux. Planning neither bootstraps the host nor grants permission
to run the listed commands.

![Admin plan preparation and execution](../diagrams/global-admin-plan.svg)

## Guarantees

- The plan comes from one read-only look at the host and the same decision code
  the real command uses. The real command then runs the steps that code prepared,
  so a planned root step is the spawned one (tested at the spawn boundary).
- `argv` is the spawned argv after privilege wrapping:
  - Linux trust and DNS: Hack's vetted `sudo` (real path, root-owned, setuid), then
    `/usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C LC_ALL=C`, then the
    command.
  - Linux Docker system-service startup: `sudo` from `PATH`, then
    `systemctl start docker`, with the inherited environment, matching the
    existing install command.
  - macOS: `sudo` from `PATH`, then the command.
- `stdin` gives the size and SHA-256 of what a step reads on stdin (for Linux
  trust, the verified CA PEM), never the bytes. The step's own arguments carry the
  same digest, and root refuses other bytes.
- Planning runs only read-only probes: the runtime CA witness (Docker reads),
  `docker info`, keychain and trust-store reads, and tool and `sudo` lookups. It
  never runs a planned step, a `sudo` probe, a write, a prompt, or anything that
  starts Docker.
- Keychain reads have a plan-only deadline. A timeout or failure to start leaves
  trust incomplete; it never establishes that a certificate is absent.
- Nothing is invented. When a step depends on something the run itself creates or
  reads first, the plan says so (`blocked`, `complete: false`) instead of guessing
  argv.

## Shape (`hack.global-admin-plan.v1`)

```json
{
  "schema": "hack.global-admin-plan.v1",
  "command": "trust",
  "platform": "linux",
  "refused": null,
  "complete": true,
  "blocked": [],
  "steps": [
    {
      "order": 1,
      "privilege": "root",
      "id": "system-trust-install",
      "description": "Install the CA (SHA-256 …) into the debian trust anchors; root accepts only these exact bytes",
      "argv": ["/usr/bin/sudo", "/usr/bin/env", "-i", "PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C", "LC_ALL=C", "/bin/sh", "-c", "<install script>", "hack-install", "<bytes>", "<sha256>", "/usr/local/share/ca-certificates/hack-caddy-local-ca.crt", "0644"],
      "shell": "/usr/bin/sudo /usr/bin/env -i … 0644",
      "stdin": { "bytes": 652, "sha256": "…", "content": "the verified Caddy Local CA (PEM)" },
      "when": "after you confirm the system-wide trust prompt on an interactive terminal; …"
    },
    { "order": 2, "privilege": "root", "id": "system-trust-refresh", "argv": ["/usr/bin/sudo", "/usr/bin/env", "-i", "…", "/usr/sbin/update-ca-certificates"], "…": "…" },
    { "order": 3, "privilege": "user", "id": "nss-trust", "description": "Add or update Hack's CA in each browser NSS database you own (certutil, as you)", "when": "…" },
    { "order": 4, "privilege": "user", "id": "host-tls-env", "description": "…", "when": "…" }
  ]
}
```

| Field | Meaning |
|---|---|
| `refused` | the real command would refuse (native runtime, slim mode, an invalid CA); no steps |
| `complete` | false when a phase cannot be known before the run (`blocked[]` says which, why, and what to do first) |
| `steps[].privilege` | `root` (has `argv`, `shell`, maybe `stdin`) or `user` (what it changes, no argv) |
| `steps[].when` | when the real command takes the step: after a confirmation, only interactively, only if a check passes |
| `steps[].gates` | on a probe: the step it can skip (macOS non-interactive runs check `sudo -n true` before the keychain step) |

Exit code: 0 for a complete plan, 1 when `refused`, 3 when incomplete; `--plan`
without `--json` exits 2. `--json` without `--plan` also exits 2 before any effect.

## What `hack global trust` plans

Linux:
- If no running Caddy CA can be confirmed: blocked; run `hack global up` first.
- If the export is stale: a user step rewrites it from the runtime CA first.
  A symlink or other non-regular export is refused before any root steps;
  an unreadable replacement check leaves the phase incomplete.
- If the system bundle already holds the CA: no root step. If Hack cannot automate
  this distribution or its tools: no root step (the real command prints manual
  steps).
- Otherwise two root steps: install the exact CA bytes, then rebuild the bundle.
  They run only after a confirmation on an interactive terminal.
- Then user steps: NSS databases, and the host trust bundle and env script.

macOS:
- When Docker answers, the run first copies the CA of the Caddy in the installed
  Compose stack to the export (a user step). The plan reads that CA the same way,
  without writing. Only when it equals the current export byte for byte is the
  keychain step decided now. Otherwise, or when it cannot be read, the keychain
  phase is blocked (`complete: false`, no root argv).
- When Docker is down and there is no export, the run starts Docker and exports
  first: blocked. With an export and Docker confirmed down (its `docker info`
  completed and failed), the current file decides. When `docker info` times out
  or cannot start, the run's own unbounded probe may still find Docker, so the
  keychain phase is blocked.
- An export the keychain step would reject (expired, malformed) makes the plan
  `refused`, as the run exits 1.
- If the keychain already trusts the CA: no root step. Otherwise
  `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain <export>`,
  after the prompt, which non-interactive runs accept. With `--no-interactive` (or
  `HACK_NO_INTERACTIVE`), a `sudo -n true` probe comes first, and the keychain step
  is skipped when it fails.
- Then a user step writes the host trust bundle and env script, and sets them for
  launchd.

## What `hack global install` plans

The initial user steps prepare optional tools, ensure shared networks and
materialize the Compose files and schemas. When Docker is stopped, the plan uses
the same detected startup backend as the command. Linux system-service startup
is a conditional root step (`sudo systemctl start docker`); desktop-backend
startup is a user step. Unknown status leaves startup incomplete. Docker
confirmed down with no detected backend is refused with install/start guidance.
Compose startup and the optional
user daemon need no administrator rights. Homebrew formula installation is a
user step; any separate Homebrew authentication is outside Hack's root argv.

On Linux, the planner reads the existing ingress network and host resolver. With
a host-visible bridge and a static subnet, it uses the same DNS plan and stdin
installer as the confirmed run: install managed systemd/udev files, reload them,
and restart the bridge's DNS unit. Non-interactive runs and declined confirmation
print manual instructions and run no root steps. A network without the fixed
subnet skips DNS. An absent network or unreadable host state leaves DNS incomplete
because install first creates or starts it. Already configured and manual-only
resolvers have no automatic root steps.

On macOS, the plan includes these phases in execution order:

1. Before Compose startup, restart dnsmasq if Homebrew reports it installed but
   not started as root. A recovery helper is tried first when installed, with
   Homebrew as its fallback.
2. After Compose startup, update the user-owned dnsmasq configuration, offer the
   managed resolver files, restart dnsmasq and flush the DNS cache. Existing custom
   resolver files are retained. If dnsmasq is not yet installed, its dependent
   phase is incomplete until the formula and prefix can be read.
3. Export the CA and prepare System keychain trust and the user TLS environment.
   Install must find a running Caddy container: unlike `global trust`, it never
   falls back to an old export. A new or unreadable CA leaves the keychain phase
   incomplete until its exact bytes are known.
4. When the recovery sudoers rule is absent, offer recovery authorization. The
   plan lists the helper and sudoers installs, validation, `sudo -k` and the
   passwordless verification probe. They run only after explicit confirmation,
   user-level validation and the root-controlled-path checks. The per-user daemon
   login-service offer is a user step.

Each macOS service/cache command shows its `sudo -n` attempt and the interactive
password alternative, even when a script plans without a TTY. That alternative
runs only on an interactive terminal when the passwordless attempt fails; helper fallbacks are also
conditional. A plan lists possible operations with their guards, not a promise
that every listed operation will execute. Completion still requires the real
command's checks and prompts against the current host state.
