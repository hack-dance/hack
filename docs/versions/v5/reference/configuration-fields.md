# Configuration fields

This reference describes v5 (next.5). Use [Environment and secrets](../../env.md) and [Lifecycle](../../lifecycle.md) for workflows. Fields below come from the version-pinned schema and readers, not a newer checkout.

The published native launcher accepts a narrower authored project model. This legacy JSON/Compose reference does not establish native feature support. Start with [Native configuration import](../../reference/native-config-import.md) and the authored schemas linked from [Reference](overview.md).

## Project JSON

The legacy project file is `.hack/hack.config.json`. Requiredness below is relative to the containing schema object or union variant. An optional parent does not become required because a child is required. Repeated paths describe different variants. The schema requires `name` and `dev_host`; the reader has compatibility fallbacks. A schema constraint is not proof the reader validates it. No schema default is declared for these fields.

| Field | Type | Within this variant | Constraints | Schema location | Evidence |
| --- | --- | --- | --- | --- | --- |
| `$schema` | `string` | Optional | — | `#/properties/$schema` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `name` | `string` | Required | — | `#/properties/name` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `dev_host` | `string` | Required | — | `#/properties/dev_host` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `defaultEnvConfig` | `string` | Optional | — | `#/properties/defaultEnvConfig` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `default_env_config` | `string` | Optional | — | `#/properties/default_env_config` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `logs` | `object` | Optional | `{"additionalProperties":true}` | `#/properties/logs` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `logs.follow_backend` | `string` | Optional | `{"enum":["compose","loki"]}` | `#/properties/logs/properties/follow_backend` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `logs.snapshot_backend` | `string` | Optional | `{"enum":["compose","loki"]}` | `#/properties/logs/properties/snapshot_backend` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `logs.clear_on_down` | `boolean` | Optional | — | `#/properties/logs/properties/clear_on_down` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `logs.retention_period` | `string` | Optional | — | `#/properties/logs/properties/retention_period` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `internal` | `object` | Optional | `{"additionalProperties":true}` | `#/properties/internal` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `internal.dns` | `boolean` | Optional | — | `#/properties/internal/properties/dns` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `internal.tls` | `boolean` | Optional | — | `#/properties/internal/properties/tls` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `internal.extra_hosts` | `object` | Optional | `{"additionalProperties":{"type":"string"}}` | `#/properties/internal/properties/extra_hosts` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `oauth` | `object` | Optional | `{"additionalProperties":true}` | `#/properties/oauth` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `oauth.enabled` | `boolean` | Optional | — | `#/properties/oauth/properties/enabled` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `oauth.tld` | `string` | Optional | — | `#/properties/oauth/properties/tld` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `open` | `object` | Optional | `{"additionalProperties":true}` | `#/properties/open` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `open.prefer` | `string` | Optional | `{"enum":["auto","alias","dev"]}` | `#/properties/open/properties/prefer` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `worktree` | `object` | Optional | `{"additionalProperties":true}` | `#/properties/worktree` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `worktree.auto_branch` | `boolean` | Optional | — | `#/properties/worktree/properties/auto_branch` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `worktree.inherit_local` | `boolean` | Optional | — | `#/properties/worktree/properties/inherit_local` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `sessions` | `object` | Optional | `{"additionalProperties":true}` | `#/properties/sessions` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `sessions.mux` | `string` | Optional | `{"enum":["auto","tmux","zellij","none"]}` | `#/properties/sessions/properties/mux` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `startup` | `array` | Optional | — | `#/properties/startup` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `startup[].name` | `string` | Optional | — | `#/properties/startup/items/anyOf/1/properties/name` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `startup[].run` | `string` | Optional | — | `#/properties/startup/items/anyOf/1/properties/run` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `startup[].command` | `string` | Optional | — | `#/properties/startup/items/anyOf/1/properties/command` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `startup[].cwd` | `string` | Optional | — | `#/properties/startup/items/anyOf/1/properties/cwd` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `startup[].persistent` | `boolean` | Optional | — | `#/properties/startup/items/anyOf/1/properties/persistent` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `startup[].singleton` | `object` | Optional | `{"additionalProperties":false}` | `#/properties/startup/items/anyOf/1/properties/singleton` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `startup[].singleton.ports` | `array` | Required | `{"minItems":1,"uniqueItems":true}` | `#/properties/startup/items/anyOf/1/properties/singleton/properties/ports` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `startup[].singleton.onConflict` | `string` | Optional | `{"enum":["adopt","fail"]}` | `#/properties/startup/items/anyOf/1/properties/singleton/properties/onConflict` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle` | `object` | Optional | `{"additionalProperties":false}` | `#/properties/lifecycle` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.up` | `object` | Optional | `{"additionalProperties":false}` | `#/properties/lifecycle/properties/up` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.up.before` | `array` | Optional | — | `#/properties/lifecycle/properties/up/properties/before` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.up.before[].name` | `string` | Optional | — | `#/properties/lifecycle/properties/up/properties/before/items/anyOf/1/properties/name` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.up.before[].command` | `string` | Required | — | `#/properties/lifecycle/properties/up/properties/before/items/anyOf/1/properties/command` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.up.before[].cwd` | `string` | Optional | — | `#/properties/lifecycle/properties/up/properties/before/items/anyOf/1/properties/cwd` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.up.before[].persistent` | `boolean` | Optional | — | `#/properties/lifecycle/properties/up/properties/before/items/anyOf/1/properties/persistent` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.up.before[].singleton` | `object` | Optional | `{"additionalProperties":false}` | `#/properties/lifecycle/properties/up/properties/before/items/anyOf/1/properties/singleton` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.up.before[].singleton.ports` | `array` | Required | `{"minItems":1,"uniqueItems":true}` | `#/properties/lifecycle/properties/up/properties/before/items/anyOf/1/properties/singleton/properties/ports` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.up.before[].singleton.onConflict` | `string` | Optional | `{"enum":["adopt","fail"]}` | `#/properties/lifecycle/properties/up/properties/before/items/anyOf/1/properties/singleton/properties/onConflict` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.up.after` | `array` | Optional | — | `#/properties/lifecycle/properties/up/properties/after` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.up.after[].name` | `string` | Optional | — | `#/properties/lifecycle/properties/up/properties/after/items/anyOf/1/properties/name` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.up.after[].command` | `string` | Required | — | `#/properties/lifecycle/properties/up/properties/after/items/anyOf/1/properties/command` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.up.after[].cwd` | `string` | Optional | — | `#/properties/lifecycle/properties/up/properties/after/items/anyOf/1/properties/cwd` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.up.after[].persistent` | `boolean` | Optional | — | `#/properties/lifecycle/properties/up/properties/after/items/anyOf/1/properties/persistent` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.up.after[].singleton` | `object` | Optional | `{"additionalProperties":false}` | `#/properties/lifecycle/properties/up/properties/after/items/anyOf/1/properties/singleton` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.up.after[].singleton.ports` | `array` | Required | `{"minItems":1,"uniqueItems":true}` | `#/properties/lifecycle/properties/up/properties/after/items/anyOf/1/properties/singleton/properties/ports` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.up.after[].singleton.onConflict` | `string` | Optional | `{"enum":["adopt","fail"]}` | `#/properties/lifecycle/properties/up/properties/after/items/anyOf/1/properties/singleton/properties/onConflict` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.down` | `object` | Optional | `{"additionalProperties":false}` | `#/properties/lifecycle/properties/down` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.down.before` | `array` | Optional | — | `#/properties/lifecycle/properties/down/properties/before` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.down.before[].name` | `string` | Optional | — | `#/properties/lifecycle/properties/down/properties/before/items/anyOf/1/properties/name` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.down.before[].command` | `string` | Required | — | `#/properties/lifecycle/properties/down/properties/before/items/anyOf/1/properties/command` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.down.before[].cwd` | `string` | Optional | — | `#/properties/lifecycle/properties/down/properties/before/items/anyOf/1/properties/cwd` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.down.before[].persistent` | `boolean` | Optional | — | `#/properties/lifecycle/properties/down/properties/before/items/anyOf/1/properties/persistent` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.down.before[].singleton` | `object` | Optional | `{"additionalProperties":false}` | `#/properties/lifecycle/properties/down/properties/before/items/anyOf/1/properties/singleton` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.down.before[].singleton.ports` | `array` | Required | `{"minItems":1,"uniqueItems":true}` | `#/properties/lifecycle/properties/down/properties/before/items/anyOf/1/properties/singleton/properties/ports` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.down.before[].singleton.onConflict` | `string` | Optional | `{"enum":["adopt","fail"]}` | `#/properties/lifecycle/properties/down/properties/before/items/anyOf/1/properties/singleton/properties/onConflict` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.down.after` | `array` | Optional | — | `#/properties/lifecycle/properties/down/properties/after` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.down.after[].name` | `string` | Optional | — | `#/properties/lifecycle/properties/down/properties/after/items/anyOf/1/properties/name` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.down.after[].command` | `string` | Required | — | `#/properties/lifecycle/properties/down/properties/after/items/anyOf/1/properties/command` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.down.after[].cwd` | `string` | Optional | — | `#/properties/lifecycle/properties/down/properties/after/items/anyOf/1/properties/cwd` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.down.after[].persistent` | `boolean` | Optional | — | `#/properties/lifecycle/properties/down/properties/after/items/anyOf/1/properties/persistent` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.down.after[].singleton` | `object` | Optional | `{"additionalProperties":false}` | `#/properties/lifecycle/properties/down/properties/after/items/anyOf/1/properties/singleton` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.down.after[].singleton.ports` | `array` | Required | `{"minItems":1,"uniqueItems":true}` | `#/properties/lifecycle/properties/down/properties/after/items/anyOf/1/properties/singleton/properties/ports` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.down.after[].singleton.onConflict` | `string` | Optional | `{"enum":["adopt","fail"]}` | `#/properties/lifecycle/properties/down/properties/after/items/anyOf/1/properties/singleton/properties/onConflict` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.processes` | `array` | Optional | — | `#/properties/lifecycle/properties/processes` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.processes[].name` | `string` | Required | — | `#/properties/lifecycle/properties/processes/items/properties/name` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.processes[].command` | `string` | Required | — | `#/properties/lifecycle/properties/processes/items/properties/command` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.processes[].cwd` | `string` | Optional | — | `#/properties/lifecycle/properties/processes/items/properties/cwd` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.processes[].singleton` | `object` | Optional | `{"additionalProperties":false}` | `#/properties/lifecycle/properties/processes/items/properties/singleton` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.processes[].singleton.ports` | `array` | Required | `{"minItems":1,"uniqueItems":true}` | `#/properties/lifecycle/properties/processes/items/properties/singleton/properties/ports` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `lifecycle.processes[].singleton.onConflict` | `string` | Optional | `{"enum":["adopt","fail"]}` | `#/properties/lifecycle/properties/processes/items/properties/singleton/properties/onConflict` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `controlPlane` | `object` | Optional | `{"additionalProperties":true}` | `#/properties/controlPlane` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `controlPlane.tui` | `object` | Optional | `{"additionalProperties":true}` | `#/properties/controlPlane/properties/tui` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `controlPlane.tui.logs` | `object` | Optional | `{"additionalProperties":true}` | `#/properties/controlPlane/properties/tui/properties/logs` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `controlPlane.tui.logs.maxEntries` | `number` | Optional | — | `#/properties/controlPlane/properties/tui/properties/logs/properties/maxEntries` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `controlPlane.tui.logs.maxLines` | `number` | Optional | — | `#/properties/controlPlane/properties/tui/properties/logs/properties/maxLines` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `controlPlane.tui.logs.historyTailStep` | `number` | Optional | — | `#/properties/controlPlane/properties/tui/properties/logs/properties/historyTailStep` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `controlPlane.usage` | `object` | Optional | `{"additionalProperties":true}` | `#/properties/controlPlane/properties/usage` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `controlPlane.usage.watchIntervalMs` | `number` | Optional | — | `#/properties/controlPlane/properties/usage/properties/watchIntervalMs` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `controlPlane.usage.historySize` | `number` | Optional | — | `#/properties/controlPlane/properties/usage/properties/historySize` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `controlPlane.daemon` | `object` | Optional | `{"additionalProperties":true}` | `#/properties/controlPlane/properties/daemon` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |
| `controlPlane.daemon.autoStart` | `boolean` | Optional | — | `#/properties/controlPlane/properties/daemon/properties/autoStart` | [source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/templates.ts#L401) |


### Aliases and selection

Prefer `env.defaultOverlay` for the default overlay. The reader checks `env.defaultOverlay` before `env.default_overlay`; nested env selection precedes legacy `defaultEnvConfig`, which in turn precedes `default_env_config`. These nested fields are read even though the legacy generated schema does not enumerate the `env` object. `worktree.autoBranch` is an alias of `worktree.auto_branch`. Use one spelling rather than conflicting aliases.

`worktree.inheritLocal` is also read as an alias of `worktree.inherit_local` in this version. It controls eligible local configuration inheritance in the legacy linked-worktree path; it does not make every ignored file or native state inheritable.

### Effective fallbacks

| Field | Fallback | Scope |
| --- | --- | --- |
| `logs.follow_backend` | `"compose"` | consumer fallback, not schema default |
| `logs.snapshot_backend` | `"loki"` | consumer fallback, can fall back or be explicitly forced |
| `startup[].persistent` | `false` | reader/workflow default documented in lifecycle |
| `worktree.auto_branch` | `true` | reader/caller default; linked checkouts only |
| `values.global` | `{}` | parser normalization |
| `environment` | `null` | selected layer environment fallback, not a fixed literal |
| `branchRegistry.branches` | `[]` | missing-file writer default, not proof invalid files are rewritten |


Log preferences are not forced backend selection. Follow mode prefers Compose; snapshots prefer Loki, with consumer-specific fallback. `startup[].persistent` defaults false. Linked-worktree auto-branch selection defaults on in the legacy Compose path; an ordinary checkout remains the base instance. Follow the runtime-specific command guide.

### Hooks and processes

`startup` accepts string shorthand or objects. Startup objects require at least one of `run` or `command`. The reader prefers `run` and drops entries whose selected command is empty. They accept optional `name`/`cwd`, and `persistent` (false by default). `lifecycle.up.before/after` and `lifecycle.down.before/after` are hook arrays; their command-object variants require `command`. Do not transfer the startup-only `run` spelling to every hook. `lifecycle.processes` names long-lived processes and requires `name` and `command`. `singleton.ports` contains unique positive ports; `singleton.onConflict` selects `adopt` or `fail`. Read [Lifecycle](../../lifecycle.md) for working-directory origins, ordering, ownership and failure behavior.

### Scope exclusions

Retained gateway, cluster, supervisor, shared/broker ownership and extension-manager fields are not a supported hosted product API. Legacy secret-backend strategy fields are separate from the managed YAML format below. Neither permissive unknown keys nor a retained schema field makes a backend qualified. Internal daemon, guest and compiler transport types are not public API specifications.

## Managed environment YAML

Files such as `.hack/hack.env.default.yaml` use `values`, not the older JSON `vars` format. Use `hack env` to manage values and [Share environment and secrets](../guides/share-environment.md) for key handling. Examples must use placeholders, never real secret values.

| Field | Type / requirement |
| --- | --- |
| `version` | literal 1; required |
| `environment` | string; optional; reader falls back to selected file/layer environment |
| `secretsprovider` | literal project_key; required |
| `values` | scope-to-entry map; required object |
| `values.{scope}` | key-to-value map; each scope must be an object; omitted global normalized to {} |
| `values.{scope}.{KEY}` | string \| number \| boolean \| null \| secure object; null accepted by parser and removal during later merge; scalar/secure accepted |
| `values.{scope}.{KEY}.secure` | nonempty string; required for object-valued stored entry; ciphertext format is interpreted elsewhere |


`version: 1`, `secretsprovider: project_key`, and an object `values` are required. Each scope is an object. Scope names match `^[a-z0-9][a-z0-9._-]*$`; keys match `^[A-Z_][A-Z0-9_]*$`. Missing `values.global` becomes an empty object. The environment falls back to the selected layer; an example containing `environment: default` does not establish a universal default. Secure values require a nonempty `secure` string; valid shape alone does not prove decryption or key availability.

This version accepts YAML null as a removal marker.

The parser selects recognized fields; this is not a closed JSON-schema promise. The legacy `hack.env.json` schema describes a different file format.

## Branch registry

`.hack/hack.branches.json` records CLI-managed branch metadata, not live container ownership. Use branch commands rather than hand-editing runtime directories.

| Field | Type | Schema requirement | Constraints |
| --- | --- | --- | --- |
| `$schema` | `string` | Optional | `{}` |
| `version` | `integer` | Required | `{"const":1}` |
| `branches` | `array` | Required | `{}` |
| `branches[].name` | `string` | Required | `{"minLength":1}` |
| `branches[].slug` | `string` | Required | `{"pattern":"^[a-z0-9][a-z0-9-]*$","minLength":1}` |
| `branches[].note` | `string` | Optional | `{}` |
| `branches[].created_at` | `string` | Optional | `{"format":"date-time"}` |
| `branches[].last_used_at` | `string` | Optional | `{"format":"date-time"}` |


`name` is the human/Git branch name; `slug` is its runtime-safe identifier. `note` is an annotation. Usage updates fill a missing `created_at` and refresh `last_used_at`; neither timestamp proves a running instance or permits deleting data. A missing registry starts empty. Invalid JSON is reported. The parser drops invalid entries and narrows recognized fields, so it does not enforce every schema pattern/date format/unknown-key constraint.
