# Run laptop-to-laptop node pairing e2e

This guide validates controller + node pairing between two laptops on the same tailnet or network.

## Prerequisites

- Controller laptop and node laptop both have `hack` available.
- Node laptop can be reached by SSH from controller (`user@host`).
- Node laptop has gateway enabled (`hack gateway setup`).
- Optional but recommended: both laptops joined to Tailscale.

## Build artifacts on controller

From repo root:

```bash
bun run build
bun run macos:build
```

This produces:

- CLI binary: `dist/hack`
- Verified macOS package build (Swift package target compile)

## Install options on node laptop

### Option A: clone private repo and install locally

```bash
git clone <private-repo-url>
cd hack-cli
bun install
bun run install:bin
```

### Option B: copy prebuilt CLI binary

```bash
scp dist/hack <user@node-host>:~/.hack/bin/hack
ssh <user@node-host> 'chmod +x ~/.hack/bin/hack'
```

Ensure `~/.hack/bin` is in PATH on node laptop.

## Node laptop prep

```bash
hack gateway setup
hack node status --json
```

## Node-initiated pairing request publish

Run this on the node laptop to create a pending request on the controller:

```bash
hack node pair request --controller "<user@controller-host>" --source "<user@node-host>" --endpoint "http://127.0.0.1:7788" --default
```

This command returns `session_id` and one-time `code`.

## Controller approve flow (macOS app)

1. Open **Settings → System → Topology**.
2. Keep **This Mac is the controller host** enabled.
3. In **Pairing requests**, find the pending session row.
4. Enter the one-time code from node request output.
5. Click **Approve + register**.
5. Refresh topology and verify node appears as authorized/connected.

## Controller approve flow (CLI fallback)

```bash
hack node pair list --status pending
hack node pair fulfill --session <pair-session-id> --code <one-time-code> --default
```

## Validation checks

```bash
hack node list
hack node status --watch
hack dispatch run --project <name|id> --node default --branch <branch> --runner codex -- echo hello
```

### Project execution mode setup (optional)

To make normal lifecycle commands (`hack up/down/restart`) route to remote automatically:

```bash
hack config set "controlPlane.execution.mode" "local_edit_remote_run"
hack config set "controlPlane.execution.nodeId" "<node-id>"
```

Then run:

```bash
hack up --target auto
```

Expected results:

- Node is registered and probe status is healthy/stale (not unknown).
- On macOS host, `hack node status --watch` should not trigger repeated keychain prompts within each 60s poll window.
- Dispatch run completes and writes artifacts to run channel.
- If using host toggle in app:
  - Host enabled: pairing + primary/remove controls are visible.
  - Host disabled: node-mode guidance is shown and controller mutating controls are hidden.
