# Run remote supervisor jobs

Use the gateway API to run commands and stream logs remotely.

## Prereqs

- Gateway enabled (`hack gateway setup`)
- Write token + `allowWrites` enabled
- `HACK_GATEWAY_URL` set to your tunnel/forwarded gateway base URL

```bash
hack config set --global 'controlPlane.gateway.allowWrites' true
hack x gateway token-create --scope write
```

## Create a job

```bash
curl -H "Authorization: Bearer $HACK_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST \
  "$HACK_GATEWAY_URL/control-plane/projects/$PROJECT_ID/jobs" \
  -d '{"runner":"generic","command":["bash","-lc","echo hello"]}'
```

## Stream logs + events

Connect to:

```
ws(s)://<gateway-host>/control-plane/projects/$PROJECT_ID/jobs/$JOB_ID/stream
```

Send a hello frame:

```json
{"type":"hello","logsFrom":0,"eventsFrom":0}
```

See `../gateway-api.md` for the full event format and shell protocol.
