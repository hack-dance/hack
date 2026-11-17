# Linux isolated-home preflight: blocked

HACK-2070 step 1, 2026-11-16 UTC. This is a **blocked preflight**, not a Linux
qualification pass. No real-host installation, DNS, trust, systemd, Caddy,
network recreation or reboot was performed. Steps 2–4 remain outside this run.

## Build and execution

- Fetched `origin/next` and built commit
  `52f2c5688f3acb32b3b58c02fd371d3b9ebcb6e2`.
- Pinned Bun 1.4.4; dependency installation and `bun run build` exited 0.
- The scratch-only executable printed `hack v4.3.0`. This is the actual source
  build output, not evidence that a published v5 prerelease was installed.
- The [qualification runbook](../guides/linux-host-qualification.md) was
  unchanged from `bb6a7d17`.
- The read-only preflight exited **3** because the existing Docker engine
  already had the `hack-dev-proxy` Compose project. The revised gate rerun is
  recorded in private `evidence/preflight-round-2.txt`.

Raw snapshots, build/dependency logs, command ledger and reviewer receipts are
retained with the private [HACK-2070 issue](https://linear.app/hackdance/issue/HACK-2070).
They contain host details and are deliberately not committed here.

## Why an isolated home cannot protect this stack

`HACK_HOME` changes filesystem paths, but the global Compose templates retain
`hack-dev-proxy` and `hack-logging` project names, the external `hack-dev`
network, the `caddy_data` volume and reserved addresses `172.30.0.2` and
`172.30.0.53`. These objects already belong to the running stack.

At the tested commit, `src/templates.ts:40,54,86,90,140` and
`src/constants.ts:4,8,9,105` define those identities. `globalUp` in
`src/commands/global.ts:1921,1969` invokes Compose with `up -d --remove-orphans`
and no separate project name. Before that, network repair, ingress-IP
reassignment and daemon startup can also have effects (`:1870,1893,1918`).

`proxy.bind_address` changes port mappings only. Another loopback bind cannot
prevent reconciliation of live containers or reuse of the live Caddy volume.
The run stopped before `global install`, as required by its safety constraint.
No dangerous command was executed to demonstrate a collision.

## Command and acceptance ledger

| Command or check | Result |
| --- | --- |
| Scratch executable `--version` | `hack v4.3.0` |
| Read-only collision gate | Exit 3: existing `hack-dev-proxy` project |
| `global install` | Not run: shared Docker identity collision |
| `global trust` | Not run: blocked installation; no root trust step |
| `daemon start`, `init`, `up`, `ps`, `logs`, `down`, `doctor` | Not run after the required stop; no project created |
| Daemon autostart / service management | Disabled in the gate environment; isolated-home allow overrides unset |
| Packages, linger, DNS/resolver/udev, trust, network recreation, reboot | Skipped by scope |
| HACK-2055 | Bind setting confirmed in source; runtime bind/conflict message skipped |
| HACK-2064 | Corefile update and AAAA latency skipped; live DNS is not candidate evidence |
| HACK-2068 | Socket-permission `ps --json` check skipped |

No P1–P7, R1–R3 or B1–B4 pass is claimed. Before/after snapshots match except
for UTC time over **22:29:04Z–22:29:43Z**; this window does not include dependency
installation or build start. Container start dates preceded this run and
restart counts were zero. The snapshots show unchanged observed service PID,
container IDs/start times/mounts/ports and network IDs; they are not an
end-to-end service health test.

Dependency installation ran the repository's Husky prepare hook, which writes
`core.hooksPath` to shared Git configuration. The prior value was not captured,
so whether that value changed is unknown. This unintended side effect departed
from the no-Git-config-changes constraint; no speculative restore was attempted.
Future qualification installs must use `HUSKY=0 bun install --frozen-lockfile`.

No task daemon, container or network was started; the existing stack remained
running. Regenerable task artifacts are cleaned separately from retained evidence.
No product runtime failure was reproduced, so no separate product-failure issue
was filed.

## Repeat the safe gate

The [preflight script](../../scripts/linux-isolated-home-preflight.sh) takes a
built executable, an absolute new `HACK_HOME` and an absolute scratch root:

```sh
bash scripts/linux-isolated-home-preflight.sh \
  /absolute/scratch/bin/hack /absolute/scratch/home /absolute/scratch
```

It canonicalizes paths with GNU `realpath -m`, rejects an existing home, disables
autostart/systemd management and unsets isolated-home service-management opt-ins.
It prints the binary version, then reads Docker inventory. It creates no home
and never runs installation, startup or cleanup commands.

![Preflight gate](../diagrams/linux-isolated-home-preflight.svg)

[Diagram source](../diagrams/linux-isolated-home-preflight.mmd).

Exit 2 means invalid inputs; exit 3 means a detected shared-object collision.
Exit 4 means only the limited inventory checks found no collision; it is **not
permission to install**. Other networks, volumes, remote routes and ports are
not checked. Command failures propagate nonzero. This gate is not the full
rerunnable qualification runner; that remains blocked with the runtime run.

To clear step 1, provide an explicitly authorized separate Docker engine or
disposable Linux VM, or supported product isolation for all global Docker
objects. Do not edit generated Compose files to bypass this guard or stop the
existing stack. Step 2 separately needs the owner's explicit go-ahead for the
real-host install and an agreed replacement/rollback plan for existing setup.
