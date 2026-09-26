# Trace Mapping

Use this note when turning implementation runs into `validate-trace` input.

## Goal

Reduce the production or test trace to just the spec variables. Do not include every log field.

## Recommended process

1. Pick the spec variables first.
2. For each recorded event, derive the state after that event.
3. Emit a JSON object whose keys exactly match the spec variable names.
4. Keep values finite and concrete so TLC can replay them.

## Example

```json
{
  "states": [
    { "phase": "idle", "attempts": 0, "approved": false },
    { "phase": "running", "attempts": 1, "approved": false },
    { "phase": "done", "attempts": 1, "approved": true }
  ]
}
```

## Common mistakes

- Using log event names instead of state snapshots
- Including timestamps or free-form payloads the spec never references
- Renaming fields so they no longer match the spec variables
- Mixing raw implementation enums with different names than the model
