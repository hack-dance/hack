# Run laptop-to-laptop node pairing e2e

This guide is the full validation run for two Macs:
1. Controller Mac (host mode)
2. Remote MacBook node

It validates pairing, remote routing, workspace mapping, mutagen sync, and dispatch execution.

If you only need initial setup, use [Remote node quickstart](remote-node-quickstart.md) first.

## E2E matrix

| Id | Scenario | Command surface | Pass criteria |
| --- | --- | --- | --- |
| MB-1 | Pair remote MacBook node from controller | `hack node pair ...` or app topology pairing | Node appears in `hack node list` and topology |
| MB-2 | Set project to remote run mode | `hack config set controlPlane.execution.*` | `hack up --target auto` routes remotely |
| MB-3 | Managed workspace bootstrap on remote | `hack up --target auto` + remote `hack node workspace list` | Workspace auto-created under `~/.hack/projects/<slug>` |
| MB-4 | Dispatch job on remote | `hack dispatch run ...` | Command succeeds and artifacts are persisted |
| MB-5 | Mutagen sync path (local edit -> remote run) | remote mode + dispatch/up | No sync bootstrap failures; run events/manifest include sync metadata |
| MB-6 | Topology + host/node controls | macOS app topology/settings | Controller host and default node state are consistent |

## Prerequisites

1. Both laptops have `hack` installed.
2. Remote laptop is reachable via SSH from controller (`user@host`).
3. Remote laptop has gateway enabled (`hack gateway setup`).
4. Controller can write to `~/.hack/bin` (Mutagen is auto-managed by `hack`).
5. Optional but recommended: both laptops are on Tailscale.

## Build artifacts on controller

From repo root:

```bash
bun run build
bun run macos:build
```

This validates local build health before cross-machine testing.

## Install on remote MacBook

### Option A: clone + local install

```bash
git clone <private-repo-url>
cd hack-cli
bun install
bun run install:bin
```

### Option B: copy prebuilt binary

```bash
scp dist/hack <user@node-host>:~/.hack/bin/hack
ssh <user@node-host> 'chmod +x ~/.hack/bin/hack'
```

Verify remote binary resolution:

```bash
ssh <user@node-host> 'which hack || test -x ~/.hack/bin/hack && echo "~/.hack/bin/hack present"'
```

## Pairing flow (controller-led, one command)

Run on controller:

```bash
hack node pair \
  --source "<user@node-host>" \
  --endpoint "http://<node-host>:7788" \
  --name "<display-name>" \
  --labels macbook,remote \
  --default
```

Notes:
1. `hack node pair` auto-detects remote `hack` command in this order:
   - `$HOME/.hack/bin/hack`
   - `/opt/homebrew/bin/hack`
   - `/usr/local/bin/hack`
   - `/usr/bin/hack`
   - `PATH` fallback (`which hack`)
2. `hack node pair` also auto-runs SSH bootstrap (managed key + `~/.ssh/config` host block) so remote runs can use non-interactive SSH.
3. If you need to repair SSH independently, run `hack node ssh setup --source "<user@node-host>"`.
4. If endpoint inference fails, pass `--endpoint` explicitly.
5. If SSH username was wrong, retry with the correct user.

Validate:

```bash
hack node list
hack node status --node <node-id>
```

## Project routing + workspace mapping flow

From controller project root:

```bash
hack config set "controlPlane.execution.mode" "local_edit_remote_run"
hack config set "controlPlane.execution.nodeId" "<node-id>"
```

Optional: inspect remote mapping store before first run:

```bash
ssh <user@node-host> 'hack node workspace list --json'
```

Run lifecycle with remote routing:

```bash
hack up --target auto
```

Then verify map + managed root on remote:

```bash
ssh <user@node-host> 'hack node workspace list --json'
```

Expected:
1. Mapping entry exists for controller project id/name.
2. Workspace root resolves under `~/.hack/projects/<project-slug>/` unless explicitly attached elsewhere.
3. Controller writes/updates the local remote-route bridge so `https://<project>.hack` is proxied through local Caddy to the remote node host.
4. Route bridge diagnostics/repair are available on controller via `hack node routes status` and `hack node routes repair`.

### Private repo bootstrap behavior (default, no manual copy)

GitHub is optional for public repos or for private repos when the remote machine already has working
Git credentials. It becomes required only when Hack needs to supply controller-side credentials for
private GitHub clone fallback.

Workspace bootstrap now uses this order automatically:
1. Attempt clone with the remote machine's existing Git credentials.
2. If clone fails and origin is GitHub, retry with controller GitHub token auth (from `hack x github connect` or `HACK_GITHUB_APP_TOKEN`).
3. Dispatch records a preflight probe (`native_git`, `controller_github_token`, or `none`) before workspace ensure so failures are diagnosable.

No manual `rsync`/attach steps are required for normal private GitHub repo flows.

Repair commands when mapping is missing or incorrect:

```bash
ssh <user@node-host> 'hack node workspace resolve --project <name|id> --json'
ssh <user@node-host> 'hack node workspace attach --project <name|id> --path <absolute-path> --json'
ssh <user@node-host> 'hack node workspace remove --project <name|id> --json'
```

## Dispatch validation

```bash
hack dispatch run \
  --project <name|id> \
  --node default \
  --branch <branch> \
  --runner generic \
  -- "pwd"
```

Expected:
1. Dispatch succeeds on the remote node.
2. Run artifacts are written to local run channel.
3. If `local_edit_remote_run` is enabled, sync metadata is included in run artifacts/events.

Mutagen sync proof (recommended):

```bash
MARKER="sync-smoke-$(date +%s)"
printf '%s\n' "$MARKER" > .hack-sync-smoke.txt
hack dispatch run --project <name|id> --node default --branch <branch> --runner generic --json -- "cat .hack-sync-smoke.txt"
hack dispatch status <run-id> --json
mutagen sync list
```

Check status output for sync metadata paths and confirm the marker output appears in remote command logs.

Inspect bootstrap auth evidence:

```bash
hack dispatch logs <run-id> | tail -n 50
cat ~/.hack/registry/runs/<run-id>/manifest.json
cat ~/.hack/registry/runs/<run-id>/summary.md
```

## macOS app validation

1. Open **Settings → System → Topology**.
2. Confirm controller-host mode is enabled on the controller device.
3. Confirm paired node appears as connected/authorized.
4. Confirm default node reflects CLI state (`hack node list`).

## Known failure signatures and fixes

1. `Could not auto-detect --endpoint ...`
   - Fix: set explicit `--endpoint`, verify remote gateway bind/port.
2. `SSH pairing command failed: zsh: command not found: hack`
   - Fix: install `hack` on remote or pass `--remote-hack` explicitly.
3. `Connection closed by <host> port 22`
   - Fix: validate SSH user/shell; test with `ssh <user@host> "echo ok"`.
4. `Missing token` on `/v1/node/status` curl
   - Expected for unauthenticated direct status calls. Pairing/dispatch uses scoped node auth.
5. `requested tags [...] are invalid or not permitted` (Railway private)
   - Fix: omit tags unless tailnet policy explicitly allows them.
6. Topology shows empty node list unexpectedly
   - Fix: refresh topology, verify controller-host mode and local node registry (`hack node list`).
7. `bootstrap_clone_failed: ... Permission denied (publickey)`
   - Cause: remote node clone failed and no usable GitHub token fallback was available.
   - Fix: connect a GitHub account on controller (`hack x github connect --profile <id>`), or set `HACK_GITHUB_APP_TOKEN`, then rerun.
8. `probe_failed (404): not_found` before workspace ensure
   - Cause: remote node is running an older daemon build that does not expose `/v1/node/git/probe`.
   - Fix: update `hack` on the remote node to the same build as controller, restart daemon, then retry.
9. `Mutagen binary was not found on this machine`
   - Cause: controller is missing mutagen and auto-install failed (permissions/network/tooling).
   - Fix: run `hack doctor --fix` (or `hack global install`) and retry.
10. `hack up --target auto` succeeds remotely but local browser on `https://<project>.hack` fails TLS/connection
   - Cause: local global proxy stack is down, so remote bridge routes were saved but not applied.
   - Fix: run `hack global up`; remote routes are reconciled automatically on startup.
   - Optional: run `hack node routes status` and `hack node routes repair` to inspect/re-apply bridge routes explicitly.

## Evidence capture

Record these outputs in your run notes:

```bash
hack node list
hack node status --json
hack node routes status --json
hack config get "controlPlane.execution.mode"
hack config get "controlPlane.execution.nodeId"
hack dispatch status <run-id>
hack dispatch logs <run-id>
```

Remote evidence:

```bash
ssh <user@node-host> 'hack node workspace list --json'
ssh <user@node-host> 'hack node status --json'
```
