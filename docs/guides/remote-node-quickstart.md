# Remote Node Quickstart (Beta)

> **Status: unsupported experimental.** These surfaces are source-available but outside the supported v3 product contract. They are hidden from default `hack --help` (see `hack help --all`) and print a warning when invoked.

This is a beta workflow.
Start with [Core docs](../core.md) if you are new to `hack`, and use [Beta workflows](../beta.md)
for the rest of the remote path.

Use this guide to connect one remote machine as a `hack` execution node and run a project on it.

> Beta: multi-node execution is still being validated and is not part of the core local-dev path.

## What you need

1. A host machine (controller) with `hack` installed.
2. A remote machine with `hack` installed.
3. SSH access from host to remote (`user@host`).
4. A reachable gateway endpoint on the remote (`http://<host>:7788` or tailnet URL).

GitHub is optional here. You only need it if the repo is private on GitHub and the remote machine
cannot already clone it with its own credentials.

## Step 1: prepare the remote machine

Run on the remote machine:

```bash
hack init --auto --no-discovery
hack gateway enable
hack daemon restart
```

If you use Tailscale, verify both devices are online in the same tailnet before pairing.

## Step 2: pair from the host machine

Run on the host machine:

```bash
hack node pair \
  --source "<user@remote-host>" \
  --endpoint "http://<remote-host>:7788" \
  --name "<display-name>" \
  --labels macbook,remote \
  --default
```

`hack node pair` now auto-bootstraps passwordless SSH for the provided source.
If you need to repair SSH outside pairing, run:

```bash
hack node ssh setup --source "<user@remote-host>"
```

Validate:

```bash
hack node list
hack node status --node <node-id>
hack node routes status
```

## Step 3: route a project to the remote node

From your project directory on the host machine:

```bash
hack config set "controlPlane.execution.mode" "local_edit_remote_run"
hack config set "controlPlane.execution.nodeId" "<node-id>"
hack up --target auto
```

## Step 4: verify remote execution

```bash
hack dispatch run \
  --project <name|id> \
  --node default \
  --branch <branch> \
  --runner generic \
  -- "pwd"
```

If this project is private and the remote node cannot clone it directly, repair native Git access
on the remote machine first:

```bash
gh auth login
```

Optional remote check:

```bash
ssh <user@remote-host> 'hack node workspace list --json'
```

Controller route bridge check:

```bash
hack node routes status --json
```

## macOS app note

Hack Desktop v3 no longer exposes remote-node and topology management as a supported UI surface.
Use the CLI for remote pairing and route repair.

## Common fixes

1. `Could not auto-detect --endpoint`:
   - pass `--endpoint` explicitly.
2. `command not found: hack` during pairing:
   - install `hack` on remote or pass `--remote-hack` with the full path.
3. `Connection closed by ... port 22`:
   - confirm username and shell access with `ssh <user@host> "echo ok"`.
4. Local project URL fails after remote dispatch (`https://<project>.hack`):
   - run `hack node routes status` then `hack node routes repair`.
   - if global proxy is down, run `hack global up` and retry.
5. Remote bootstrap fails on a private repo:
   - configure native Git access on the remote first.
   - verify `git clone` or `gh auth status` works outside Hack, then retry.
