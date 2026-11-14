# Doctor tool coverage audit

The fixed table in `core/src/doctor_tools.rs` attributes filtered PATH tools to
read-only CLI checks. It is not inferred from UI area names, repair recipes or
what might normally be installed together. This audit follows `doctor.ts` and
its imported read helpers at this PR's CLI base. Update it when those calls
change. A listed transitive dependency can be conditional; it does not prove
that every branch executed the helper. The coverage card always identifies the
unchecked tool; only listed dependent check IDs can be downgraded.

| PATH tool | Actual read call and affected check IDs |
| --- | --- |
| bun, docker, brew, dnsmasq, mkcert, tmux, go, caddy, asdf | `doctor.ts::checkTool` looks up the named executable. Only its own tool-presence row (including optional/sessions suffixes) follows from this lookup. Docker's additional dependencies are below. |
| gum, fzf | `checkOptionalGum` / `checkOptionalFzf` call the UI path resolvers (override, bundled path, then PATH); only their optional presence rows. No Doctor read launches these UI tools. |
| mutagen | `checkMutagenBinary` resolves override/managed/PATH selection and runs `mutagen version`; only `mutagen`. Absolute candidates have a separate desktop preflight. |
| docker | `checkDockerRunning` runs `info`; `checkDockerNetwork` / `checkIngressSubnet` run network inspect (`network:*`); `checkProxyNetwork` -> `inspectProxyNetwork` runs ps/inspect (`proxy network`); `checkCoreDnsForwarding` -> `resolveCoreDnsServer` runs ps/inspect (`coredns forwarding`); `checkCaddyLocalCa` and `inspectProxyLoopback` -> `inspectCaddyCaIdentity` run ps/inspect/cp (`caddy local ca`, `proxy ports`); `checkCaddyHostMapping` -> `resolveGlobalCaddyIp` runs ps/inspect (`caddy hosts`). |
| docker, conditional | `checkHackLocalDns` calls `resolveGlobalCaddyIp` only for a nonstandard DNS answer (`dns:hack.local` and custom `dns:*`, excluding the separate lookup-only `dns:hack` / `dns:hack.gy` checks). `checkMacDnsmasqConfigForDomain` falls back to `resolveGlobalCaddyIp` for a dynamic address (`dnsmasq.conf:*`). |
| docker, runtime reads | `checkProjectRuntimeHygiene`, `checkWorktreeInstanceCollisions`, and lifecycle hygiene's active-Compose-project read call `readRuntimeProjects` -> docker ps/inspect (`runtime hygiene`, `worktree instances`, `lifecycle hygiene`). |
| git | `checkEnvKeyAtRoot` -> `doctor-env-key` runs ls-files/check-ignore (`env key`); `inspectWorktreeSecretKeys` -> `listGitWorktrees` (`worktree keys`); `doctor-generated-files` runs ls-files/check-ignore/rev-parse (`generated files`, `hack gitignore`); `inspectSecretsHygiene` runs git tracking/ignore queries (`secrets hygiene`); secret integrity and env materialization read shared/primary checkout inputs via `project-env-config`/`git-worktree`, and file-store key tracking via `secret-store` (`secret integrity`, `env materialization`). |
| security | `checkMacHostTlsTrust`, `checkSupersededCaddyRoots` and native `inspectNativeCaTrust` call `mac-ca-trust` -> security find-certificate/verify-cert (`host tls trust`, `superseded caddy roots`, `native root trust`, `native https owner`, `native https route`). Native owner/route results depend on the combined owner/trust observation. |
| brew | `checkMacDnsmasqConfigForDomain` runs `brew --prefix` (`dnsmasq.conf:*`); `createNativeHackLocalRouteDependencies` resolves the prefix the same way (`native hack.local route`). |
| systemctl | `resolveSystemdSummary` -> `readSystemdServiceStatus` probes/shows the user service (`daemon service`); Linux DNS host probes resolved status/version/unit reload (`linux dns route`). |
| loginctl | `readSystemdServiceStatus` -> `readLingerStatus` (`daemon service`). |
| ip, resolvectl | `inspectLinuxGlobalDns` -> `inspectLinuxDns` -> Linux DNS host reads link addresses and per-link resolver settings (`linux dns route`). |
| tmux, zellij | Lifecycle hygiene enumerates mux sessions; runtime project liveness reads tmux windows or zellij sessions (`lifecycle hygiene`, `runtime hygiene`, `worktree instances`). `sessions mux` separately looks up tmux only. |
| ps | Lifecycle hygiene -> `readProcessIdentities` spawns ps for process identity (`lifecycle hygiene`). Native DNS observation uses absolute `/bin/ps`, not this PATH selection. |
| lsof, ss | `inspectProxyLoopback` calls `listHostTcpListeners` only after a failed authenticated port probe, for extra listener detail. Keep the verified `proxy ports` warning and guidance; record unavailable auxiliary coverage on the one tool card, without downgrading the result. |

## Explicit independent checks

- `compose networks`: `checkComposeNetworkHygiene` reads/parses Compose YAML and
  calls `analyzeComposeNetworkHygiene`. It does not invoke Docker.
- `compose backend features`: `checkComposeBackendFeatures` reads Compose and
  adaptation files through `readComposeBackendReading`; pure feature decisions.
- `compose env at rest`: reads override/adoption files and reports stored literals;
  no Docker read. `grafana` reads route configuration and uses Bun fetch.
- `native source size` invokes the selected native runtime metadata measurement;
  it does not invoke PATH Git. Native owner/route runtime calls are not PATH ps,
  lsof or caddy executions. Repairs (`sudo`, native CA repair, cache flushing)
  are outside the read-only Doctor probe and never justify table entries.
- `dnsmasq:53` uses `queryDnsARecord` (UDP), not dnsmasq/dig/lsof. `resolver:*`
  reads files. Native host DNS uses Node lookup. No read path invokes dig,
  scutil, mkcert or openssl for these checks; they have no inferred dependency.
- `local ca trust` uses Node certificate parsing/files plus its own fixed vetted
  helper PATH / absolute NSS resolver; filtering the desktop PATH does not
  establish anything about those helpers. The separate NSS guard is an open
  prerequisite; this table is not a mitigation for it.
- Project selection, env format/overlay file diagnostics, generated static
  guidance and certificate parsing remain independent unless the exact read
  helper above names a tool call. Shared/primary env inspection can query Git;
  this does not make the entire Env or Project files area dependent on Git.

No entry widens ownership, mode, ACL or symlink trust. No NSS profile discovery,
credential configuration copy, environment switch or runtime side effect is
introduced by this table.
