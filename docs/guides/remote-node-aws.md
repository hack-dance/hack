# AWS Node Bootstrap Guide

Use this guide to register an EC2-hosted runtime as a `hack` remote node using the built-in AWS provider flow.

If this is your first remote node, start with [Remote node quickstart](remote-node-quickstart.md) for core concepts.

## Quick Start

### Fastest path (macOS app)

1. Open **Settings → Extensions → AWS**.
2. Save defaults for:
   - region
   - instance id or tag selector
   - SSH source
   - gateway endpoint
3. Click **Bootstrap node now**.
4. Open **Settings → System → Topology** and verify the node is registered.

### CLI path (explicit instance id)

```bash
hack node provider aws bootstrap \
  --instance-id "i-0123456789abcdef0" \
  --region us-east-1 \
  --source "ec2-user@runner.internal" \
  --endpoint "https://runner.example.internal" \
  --name "aws-runner-1" \
  --labels aws,linux \
  --default
```

### CLI path (tag lookup + profile)

```bash
hack node provider aws bootstrap \
  --instance-tag-value "event-agent-qa-runner" \
  --instance-tag-key Name \
  --region us-east-1 \
  --profile qa \
  --source "ec2-user@runner.internal" \
  --endpoint "https://runner.example.internal" \
  --bootstrap-command "sudo systemctl start hack-node"
```

### CLI path (uses saved AWS defaults)

If your AWS defaults are already stored in global config:

```bash
hack node provider aws bootstrap --default
```

## macOS App Workflow

In Hack Desktop:

1. Open **Settings → Extensions → AWS**.
2. Confirm the provider is enabled.
3. Set defaults:
   - AWS region
   - instance id, or tag key + tag value
   - SSH source
   - gateway endpoint
   - optional node name, labels, and bootstrap command
4. Click **Save defaults**.
5. Click **Bootstrap node now**.
6. Validate the result card.
7. Open **Topology** and confirm the node is visible, healthy, and optionally marked as default.

## What The Command Does

`hack node provider aws bootstrap` performs these steps:

1. Resolves the target EC2 instance by instance id or tag selector.
2. Starts the instance if it is stopped.
3. Waits for EC2 state + SSM readiness.
4. Optionally runs `--bootstrap-command` over SSM for host preparation.
5. Executes `hack node init --json` over SSM on the remote host.
6. Registers the returned node bundle on the controller.
7. Probes node health and stores endpoint + SSH source metadata for parity flows.

## Required Prerequisites

1. The controller has AWS credentials that can access EC2 + SSM in the target account/region.
2. The EC2 instance has SSM enabled and is online.
3. The remote host already has `hack` installed and the gateway available, unless your bootstrap command installs or starts it.
4. The controller can reach the provided gateway endpoint.
5. The controller can SSH to the provided `source` when you want Mutagen sync or devcontainer attach parity.

## Flags

- `--instance-id <id>`: target a specific EC2 instance.
- `--instance-tag-key <key>`: tag key used with tag lookup (defaults to `Name`).
- `--instance-tag-value <value>`: tag value used to resolve an instance.
- `--region <region>`: AWS region to query.
- `--profile <profile>`: optional shared AWS config profile.
- `--bootstrap-command <cmd>`: optional SSM command to prepare the host before `hack node init`.
- `--source <user@host>`: required SSH source for source-backed parity flows.
- `--endpoint <url>`: required gateway endpoint the controller can reach.
- `--name <name>`: optional node display name.
- `--labels <csv>`: optional node labels.
- `--default`: set the resulting node as the default controller node.
- `--json`: machine-readable output.

## Validation Checklist

After bootstrap:

```bash
hack node list
hack node status --node <node-id>
hack dispatch run --node <node-id> --project <project> --branch <branch> --runner generic -- "pwd"
```

Pin a project to remote workspace offload:

```bash
hack config set "controlPlane.execution.mode" "local_edit_remote_run"
hack config set "controlPlane.execution.nodeId" "<node-id>"
hack up --target auto
```

Optional source-backed parity checks:

```bash
hack node devcontainer up --node <node-id> --project <project> --branch <branch>
hack node devcontainer attach --node <node-id> --id <session-id> --ide vscode --ssh-host <ssh-host>
mutagen sync list
```

## E2E Test Matrix (AWS + EC2 + SSM)

Run this matrix before marking AWS bootstrap stable:

1. **Bootstrap**
   - run `bun run test:e2e:aws`
   - confirm node id and endpoint are returned
2. **Registry + probe**
   - `hack node list`
   - `hack node status --node <node-id>`
3. **Dispatch execution**
   - `hack dispatch run --node <node-id> --project <project> --branch <branch> --runner generic -- "uname -a"`
4. **Remote workspace offload**
   - set `controlPlane.execution.mode=local_edit_remote_run`
   - run `hack up --target auto`
   - confirm run artifacts include sync metadata when Mutagen is active
5. **Devcontainer smoke**
   - `hack node devcontainer up --node <node-id> --project <project> --branch <branch>`
   - attach from local IDE and verify shell commands execute

### Automated E2E Runner

Use the bundled runner for repeatable CLI validation:

```bash
bun run test:e2e:aws
```

Required environment:

- `HACK_AWS_E2E_REGION`
- `HACK_AWS_E2E_SOURCE`
- `HACK_AWS_E2E_ENDPOINT`
- exactly one of:
  - `HACK_AWS_E2E_INSTANCE_ID`
  - `HACK_AWS_E2E_INSTANCE_TAG_VALUE`

Optional overrides:

- `HACK_AWS_E2E_INSTANCE_TAG_KEY=Name`
- `HACK_AWS_E2E_PROFILE=<aws-profile>`
- `HACK_AWS_E2E_BOOTSTRAP_COMMAND=<command>`
- `HACK_AWS_E2E_NODE_NAME=<node-name>`
- `HACK_AWS_E2E_LABELS=aws,e2e`
- `HACK_AWS_E2E_DEFAULT_NODE=true`
- `HACK_AWS_E2E_PROJECT=<project-name-or-id>`
- `HACK_AWS_E2E_BRANCH=<branch>`
- `HACK_AWS_E2E_RUN_COMMAND=<shell-command>`
- `HACK_AWS_E2E_DEVCONTAINER=true`

If `HACK_AWS_E2E_PROJECT` is set, the runner also exercises a dispatch command against the bootstrapped node. If `HACK_AWS_E2E_DEVCONTAINER=true`, it also runs `hack node devcontainer up`.

## Troubleshooting

1. `AWS bootstrap requires exactly one of --instance-id or --instance-tag-value`
   - Cause: both selectors were set, or neither was set.
   - Fix: choose one target selector.
2. `SSM readiness timed out`
   - Cause: the instance is not online in SSM yet, or the instance role/agent is broken.
   - Fix: verify SSM agent health and IAM permissions on the instance.
3. `bootstrap command failed`
   - Cause: the pre-init command returned non-zero.
   - Fix: inspect the surfaced stdout/stderr in the JSON output and rerun with a corrected command.
4. Node appears in the registry but Mutagen/devcontainer flows do not work
   - Cause: `source` metadata is missing or not reachable over SSH.
   - Fix: bootstrap again with a valid `--source`, then verify `hack node ssh setup --source <user@host>`.
5. Node is healthy but the project still runs locally
   - Cause: project default behavior is still `local`.
   - Fix: set `controlPlane.execution.mode=local_edit_remote_run`, or use explicit remote actions/flags when available.

## Current Limitations

1. v1 AWS support targets existing EC2 instances over SSM only.
2. `hack` does not provision EC2, IAM, security groups, or AWS networking for you.
3. Project-specific env hydration and service orchestration still belong in repo-owned automation.
