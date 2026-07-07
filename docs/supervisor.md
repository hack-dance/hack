# Supervisor (jobs + shells)

> **Status: unsupported experimental.** These surfaces are source-available but outside the supported v3 product contract. They are hidden from default `hack --help` (see `hack help --all`) and print a warning when invoked.

The supervisor is the execution engine behind remote workflows. It can run commands as jobs,
stream logs/events, and host PTY-backed shells. The CLI exposes it locally via `hack x supervisor`
and remotely through the gateway API.

This page documents a beta-adjacent execution surface.
Use [Beta workflows](beta.md) for the guided remote path and [Extensions & reference](reference.md)
for the rest of the command and API material.

## Local usage

```bash
hack x supervisor job-create --project <project> -- command args
hack x supervisor job-create --path <repo-path> -- command args
hack x supervisor job-list
hack x supervisor job-tail <jobId>
hack x supervisor job-cancel <jobId>

hack x supervisor shell --token <write-token>
```

Notes:
- Shells and job creation require a **write** gateway token + `allowWrites` when using the gateway.
- Local `hack x supervisor` commands can run without the gateway.
- `--project` expects a registered project name (slug); use `--project-id` when targeting the gateway directly.

## Remote usage (gateway)

Use the gateway API to create a job and stream logs:

```bash
curl -H "Authorization: Bearer $HACK_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST \
  http://127.0.0.1:7788/control-plane/projects/$PROJECT_ID/jobs \
  -d '{"runner":"generic","command":["bash","-lc","echo hello"]}'
```

Then connect to the job stream via WebSocket:

```
ws://127.0.0.1:7788/control-plane/projects/$PROJECT_ID/jobs/$JOB_ID/stream
```

See `gateway-api.md` for event formats and the shell stream protocol.
