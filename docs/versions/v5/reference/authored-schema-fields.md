# Authored schema fields

The published next.5 authored schemas describe project and local override documents. They are distinct from [legacy configuration fields](configuration-fields.md). See [Native configuration import](../../reference/native-config-import.md) for the admitted import subset and [Authored commands](../../reference/native-authored-commands.md) for semantic validation.

A valid document shape does not establish runtime admission or provider availability. Defaults here are JSON-schema defaults, not promises of a running service. Requiredness is relative to the containing object or union variant: an optional parent remains optional. Dynamic maps are not a closed list of project-defined names. Definition names are authoring types, not internal transport APIs.

## Project document

[Pinned machine schema](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/packages/config-compiler/generated/hack.project.schema.json). Each pointer identifies a field declaration in that schema, including definitions and union variants.

| Field / schema pointer | Type or reference | Required here | Default | Meaning / constraints |
| --- | --- | --- | --- | --- |
| `configs`<br />`/properties/configs` | `{ [name]: FileConfig }` | No | Not declared |  {"additionalProperties":{"$ref":"#/$defs/FileConfig"}} |
| `environment`<br />`/properties/environment` | `EnvironmentSelection` | No | `{}` |  |
| `host`<br />`/properties/host` | `HostConfig` | No | Not declared |  |
| `host_bindings`<br />`/properties/host_bindings` | `{ [name]: HostBindingTarget }` | No | Not declared |  {"additionalProperties":{"$ref":"#/$defs/HostBindingTarget"}} |
| `jobs`<br />`/properties/jobs` | `{ [name]: Workload & schema-defined }` | No | `{}` |  {"additionalProperties":{"allOf":[{"$ref":"#/$defs/Workload"},{"properties":{"restart":{"properties":{"kind":{"enum":["no","on-failure"]}}}}}]}} |
| `name`<br />`/properties/name` | `string` | Yes | Not declared |  |
| `networks`<br />`/properties/networks` | `{ [name]: Network }` | No | Not declared |  {"additionalProperties":{"$ref":"#/$defs/Network"}} |
| `open`<br />`/properties/open` | `OpenConfig` | No | Not declared |  |
| `profiles`<br />`/properties/profiles` | `array<string>` | No | `[]` |  |
| `routes`<br />`/properties/routes` | `Routes` | No | Not declared |  |
| `schema_version`<br />`/properties/schema_version` | `integer` | Yes | Not declared |  {"minimum":1,"maximum":1} |
| `secrets`<br />`/properties/secrets` | `{ [name]: FileSecret }` | No | Not declared |  {"additionalProperties":{"$ref":"#/$defs/FileSecret"}} |
| `services`<br />`/properties/services` | `{ [name]: Workload }` | No | `{}` |  {"additionalProperties":{"$ref":"#/$defs/Workload"}} |
| `source`<br />`/properties/source` | `Source` | No | `{"mode":"host-mounted","root":"."}` |  |
| `storage`<br />`/properties/storage` | `{ [name]: Storage }` | No | `{}` |  {"additionalProperties":{"$ref":"#/$defs/Storage"}} |
| `worktree`<br />`/properties/worktree` | `WorktreePolicy` | No | `{"auto_branch":true,"inherit_local":true}` |  |
| `context`<br />`/$defs/Build/properties/context` | `string` | Yes | Not declared |  |
| `dockerfile`<br />`/$defs/Build/properties/dockerfile` | `string` | No | `"Dockerfile"` |  |
| `target`<br />`/$defs/Build/properties/target` | `string` | No | Not declared |  |
| `exec`<br />`/$defs/Command/anyOf/0/properties/exec` | `array<string>` | Yes | Not declared |  {"minItems":1} |
| `shell`<br />`/$defs/Command/anyOf/1/properties/shell` | `string` | Yes | Not declared |  |
| `condition`<br />`/$defs/Dependency/anyOf/0/properties/condition` | `ServiceCondition` | Yes | Not declared |  |
| `service`<br />`/$defs/Dependency/anyOf/0/properties/service` | `string` | Yes | Not declared |  |
| `condition`<br />`/$defs/Dependency/anyOf/1/properties/condition` | `JobCondition` | Yes | Not declared |  |
| `job`<br />`/$defs/Dependency/anyOf/1/properties/job` | `string` | Yes | Not declared |  |
| `kind`<br />`/$defs/EndpointReference/oneOf/0/properties/kind` | `"route"` | Yes | Not declared |  {"const":"route"} |
| `name`<br />`/$defs/EndpointReference/oneOf/0/properties/name` | `string` | Yes | Not declared |  |
| `kind`<br />`/$defs/EndpointReference/oneOf/1/properties/kind` | `"service"` | Yes | Not declared |  {"const":"service"} |
| `name`<br />`/$defs/EndpointReference/oneOf/1/properties/name` | `string` | Yes | Not declared |  |
| `port`<br />`/$defs/EndpointReference/oneOf/1/properties/port` | `integer` | Yes | Not declared |  {"minimum":1,"maximum":65535} |
| `protocol`<br />`/$defs/EndpointReference/oneOf/1/properties/protocol` | `EndpointProtocol` | Yes | Not declared |  |
| `kind`<br />`/$defs/EndpointReference/oneOf/2/properties/kind` | `"host_binding"` | Yes | Not declared |  {"const":"host_binding"} |
| `name`<br />`/$defs/EndpointReference/oneOf/2/properties/name` | `string` | Yes | Not declared |  {"minLength":1,"maxLength":63,"pattern":"^[a-z0-9]+(?:-[a-z0-9]+)*$"} |
| `exec`<br />`/$defs/Entrypoint/anyOf/0/properties/exec` | `array<string>` | Yes | Not declared |  |
| `shell`<br />`/$defs/Entrypoint/anyOf/1/properties/shell` | `string` | Yes | Not declared |  {"minLength":1} |
| `default_overlay`<br />`/$defs/EnvironmentSelection/properties/default_overlay` | `string` | No | Not declared |  {"pattern":"^[a-z0-9]+(?:-[a-z0-9]+)*$"} |
| `literal`<br />`/$defs/EnvironmentValue/anyOf/0/properties/literal` | `string` | Yes | Not declared |  |
| `default`<br />`/$defs/EnvironmentValue/anyOf/1/properties/default` | `string` | Yes | Not declared |  |
| `env_ref`<br />`/$defs/EnvironmentValue/anyOf/2/properties/env_ref` | `string` | Yes | Not declared |  {"pattern":"^[A-Z_][A-Z0-9_]*$"} |
| `unset`<br />`/$defs/EnvironmentValue/anyOf/3/properties/unset` | `True` | Yes | Not declared |  |
| `endpoint`<br />`/$defs/EnvironmentValue/anyOf/4/properties/endpoint` | `EndpointReference` | Yes | Not declared |  |
| `file`<br />`/$defs/FileConfig/properties/file` | `string` | Yes | Not declared |  |
| `file`<br />`/$defs/FileSecret/anyOf/0/properties/file` | `string` | Yes | Not declared |  |
| `env_ref`<br />`/$defs/FileSecret/anyOf/1/properties/env_ref` | `string` | Yes | Not declared |  |
| `kind`<br />`/$defs/HostBindingTarget/oneOf/0/properties/kind` | `"host"` | Yes | Not declared |  {"const":"host"} |
| `port`<br />`/$defs/HostBindingTarget/oneOf/0/properties/port` | `integer` | Yes | Not declared |  {"minimum":1,"maximum":65535} |
| `protocol`<br />`/$defs/HostBindingTarget/oneOf/0/properties/protocol` | `EndpointProtocol` | Yes | Not declared |  |
| `hostname`<br />`/$defs/HostBindingTarget/oneOf/1/properties/hostname` | `string` | Yes | Not declared |  {"minLength":1,"maxLength":253} |
| `kind`<br />`/$defs/HostBindingTarget/oneOf/1/properties/kind` | `"external"` | Yes | Not declared |  {"const":"external"} |
| `port`<br />`/$defs/HostBindingTarget/oneOf/1/properties/port` | `integer` | Yes | Not declared |  {"minimum":1,"maximum":65535} |
| `protocol`<br />`/$defs/HostBindingTarget/oneOf/1/properties/protocol` | `EndpointProtocol` | Yes | Not declared |  |
| `down`<br />`/$defs/HostConfig/properties/down` | `HostHooks` | No | `{"after":[],"before":[]}` |  |
| `processes`<br />`/$defs/HostConfig/properties/processes` | `{ [name]: HostProcess }` | No | `{}` |  {"additionalProperties":{"$ref":"#/$defs/HostProcess"}} |
| `up`<br />`/$defs/HostConfig/properties/up` | `HostHooks` | No | `{"after":[],"before":[]}` |  |
| `kind`<br />`/$defs/HostEnvTarget/oneOf/0/properties/kind` | `"host"` | Yes | Not declared |  {"const":"host"} |
| `kind`<br />`/$defs/HostEnvTarget/oneOf/1/properties/kind` | `"workload"` | Yes | Not declared |  {"const":"workload"} |
| `name`<br />`/$defs/HostEnvTarget/oneOf/1/properties/name` | `string` | Yes | Not declared |  |
| `command`<br />`/$defs/HostHook/properties/command` | `Command` | Yes | Not declared |  |
| `cwd`<br />`/$defs/HostHook/properties/cwd` | `string` | No | `"."` |  |
| `env_target`<br />`/$defs/HostHook/properties/env_target` | `HostEnvTarget` | No | `{"kind":"host"}` |  |
| `environment`<br />`/$defs/HostHook/properties/environment` | `{ [name]: EnvironmentValue }` | No | `{}` |  {"additionalProperties":{"$ref":"#/$defs/EnvironmentValue"}} |
| `name`<br />`/$defs/HostHook/properties/name` | `string` | Yes | Not declared |  |
| `after`<br />`/$defs/HostHooks/properties/after` | `array<HostHook>` | No | `[]` |  |
| `before`<br />`/$defs/HostHooks/properties/before` | `array<HostHook>` | No | `[]` |  |
| `command`<br />`/$defs/HostProcess/properties/command` | `Command` | Yes | Not declared |  |
| `cwd`<br />`/$defs/HostProcess/properties/cwd` | `string` | No | `"."` |  |
| `env_target`<br />`/$defs/HostProcess/properties/env_target` | `HostEnvTarget` | No | `{"kind":"host"}` |  |
| `environment`<br />`/$defs/HostProcess/properties/environment` | `{ [name]: EnvironmentValue }` | No | `{}` |  {"additionalProperties":{"$ref":"#/$defs/EnvironmentValue"}} |
| `exit`<br />`/$defs/HostProcess/properties/exit` | `HostExit` | No | `"stop_on_down"` |  |
| `singleton`<br />`/$defs/HostProcess/properties/singleton` | `HostSingleton` | No | Not declared |  |
| `startup`<br />`/$defs/HostProcess/properties/startup` | `HostStartup` | No | `"up"` |  |
| `on_conflict`<br />`/$defs/HostSingleton/properties/on_conflict` | `HostConflict` | No | `"fail"` |  |
| `ports`<br />`/$defs/HostSingleton/properties/ports` | `array<integer>` | Yes | Not declared |  {"minItems":1,"uniqueItems":true} |
| `hostname`<br />`/$defs/HttpRoute/properties/hostname` | `string` | Yes | Not declared |  |
| `port`<br />`/$defs/HttpRoute/properties/port` | `integer` | Yes | Not declared |  {"minimum":1,"maximum":65535} |
| `protocol`<br />`/$defs/HttpRoute/properties/protocol` | `HttpProtocol` | No | `"http"` |  |
| `service`<br />`/$defs/HttpRoute/properties/service` | `string` | Yes | Not declared |  |
| `access`<br />`/$defs/Mount/anyOf/0/properties/access` | `Access` | Yes | Not declared |  |
| `source`<br />`/$defs/Mount/anyOf/0/properties/source` | `string` | Yes | Not declared |  |
| `target`<br />`/$defs/Mount/anyOf/0/properties/target` | `string` | Yes | Not declared |  |
| `access`<br />`/$defs/Mount/anyOf/1/properties/access` | `Access` | Yes | Not declared |  |
| `storage`<br />`/$defs/Mount/anyOf/1/properties/storage` | `string` | Yes | Not declared |  |
| `target`<br />`/$defs/Mount/anyOf/1/properties/target` | `string` | Yes | Not declared |  |
| `access`<br />`/$defs/Mount/anyOf/2/properties/access` | `Access` | Yes | Not declared |  |
| `config`<br />`/$defs/Mount/anyOf/2/properties/config` | `string` | Yes | Not declared |  |
| `gid`<br />`/$defs/Mount/anyOf/2/properties/gid` | `integer` | No | Not declared |  {"minimum":0} |
| `mode`<br />`/$defs/Mount/anyOf/2/properties/mode` | `string` | No | `"0444"` |  {"pattern":"^0[0-7]{3}$"} |
| `target`<br />`/$defs/Mount/anyOf/2/properties/target` | `string` | Yes | Not declared |  |
| `uid`<br />`/$defs/Mount/anyOf/2/properties/uid` | `integer` | No | Not declared |  {"minimum":0} |
| `access`<br />`/$defs/Mount/anyOf/3/properties/access` | `Access` | Yes | Not declared |  |
| `gid`<br />`/$defs/Mount/anyOf/3/properties/gid` | `integer` | No | Not declared |  {"minimum":0} |
| `mode`<br />`/$defs/Mount/anyOf/3/properties/mode` | `string` | No | `"0444"` |  {"pattern":"^0[0-7]{3}$"} |
| `secret`<br />`/$defs/Mount/anyOf/3/properties/secret` | `string` | Yes | Not declared |  |
| `target`<br />`/$defs/Mount/anyOf/3/properties/target` | `string` | Yes | Not declared |  |
| `uid`<br />`/$defs/Mount/anyOf/3/properties/uid` | `integer` | No | Not declared |  {"minimum":0} |
| `internal`<br />`/$defs/Network/properties/internal` | `boolean` | No | `false` |  |
| `aliases`<br />`/$defs/NetworkAttachment/properties/aliases` | `array<string>` | No | Not declared |  |
| `prefer`<br />`/$defs/OpenConfig/properties/prefer` | `OpenPreference` | No | `"auto"` |  |
| `command`<br />`/$defs/Readiness/oneOf/0/properties/command` | `Command` | Yes | Not declared |  |
| `interval`<br />`/$defs/Readiness/oneOf/0/properties/interval` | `string` | Yes | Not declared |  |
| `kind`<br />`/$defs/Readiness/oneOf/0/properties/kind` | `"exec"` | Yes | Not declared |  {"const":"exec"} |
| `retries`<br />`/$defs/Readiness/oneOf/0/properties/retries` | `integer` | Yes | Not declared |  {"minimum":1,"maximum":4294967295} |
| `timeout`<br />`/$defs/Readiness/oneOf/0/properties/timeout` | `string` | Yes | Not declared |  |
| `interval`<br />`/$defs/Readiness/oneOf/1/properties/interval` | `string` | Yes | Not declared |  |
| `kind`<br />`/$defs/Readiness/oneOf/1/properties/kind` | `"http"` | Yes | Not declared |  {"const":"http"} |
| `path`<br />`/$defs/Readiness/oneOf/1/properties/path` | `string` | Yes | Not declared |  |
| `port`<br />`/$defs/Readiness/oneOf/1/properties/port` | `integer` | Yes | Not declared |  {"minimum":1,"maximum":65535} |
| `retries`<br />`/$defs/Readiness/oneOf/1/properties/retries` | `integer` | Yes | Not declared |  {"minimum":1,"maximum":4294967295} |
| `timeout`<br />`/$defs/Readiness/oneOf/1/properties/timeout` | `string` | Yes | Not declared |  |
| `interval`<br />`/$defs/Readiness/oneOf/2/properties/interval` | `string` | Yes | Not declared |  |
| `kind`<br />`/$defs/Readiness/oneOf/2/properties/kind` | `"tcp"` | Yes | Not declared |  {"const":"tcp"} |
| `port`<br />`/$defs/Readiness/oneOf/2/properties/port` | `integer` | Yes | Not declared |  {"minimum":1,"maximum":65535} |
| `retries`<br />`/$defs/Readiness/oneOf/2/properties/retries` | `integer` | Yes | Not declared |  {"minimum":1,"maximum":4294967295} |
| `timeout`<br />`/$defs/Readiness/oneOf/2/properties/timeout` | `string` | Yes | Not declared |  |
| `kind`<br />`/$defs/Restart/oneOf/0/properties/kind` | `"no"` | Yes | Not declared |  {"const":"no"} |
| `kind`<br />`/$defs/Restart/oneOf/1/properties/kind` | `"always"` | Yes | Not declared |  {"const":"always"} |
| `kind`<br />`/$defs/Restart/oneOf/2/properties/kind` | `"unless-stopped"` | Yes | Not declared |  {"const":"unless-stopped"} |
| `kind`<br />`/$defs/Restart/oneOf/3/properties/kind` | `"on-failure"` | Yes | Not declared |  {"const":"on-failure"} |
| `max_retries`<br />`/$defs/Restart/oneOf/3/properties/max_retries` | `integer` | No | Not declared |  {"minimum":1,"maximum":4294967295} |
| `domain`<br />`/$defs/RouteAlias/anyOf/0/properties/domain` | `string` | Yes | Not declared |  |
| `origin`<br />`/$defs/RouteAlias/anyOf/1/properties/origin` | `string` | Yes | Not declared |  |
| `aliases`<br />`/$defs/Routes/properties/aliases` | `{ [name]: RouteAlias }` | No | `{}` |  {"additionalProperties":{"$ref":"#/$defs/RouteAlias"}} |
| `domain`<br />`/$defs/Routes/properties/domain` | `string` | No | Not declared |  |
| `http`<br />`/$defs/Routes/properties/http` | `{ [name]: HttpRoute }` | No | `{}` |  {"additionalProperties":{"$ref":"#/$defs/HttpRoute"}} |
| `oauth_alias`<br />`/$defs/Routes/properties/oauth_alias` | `string` | No | Not declared |  |
| `origin`<br />`/$defs/Routes/properties/origin` | `string` | No | Not declared |  |
| `grace`<br />`/$defs/Shutdown/properties/grace` | `string` | No | Not declared |  {"pattern":"^[0-9]*[1-9][0-9]*(?:ms\|s\|m\|h)$"} |
| `signal`<br />`/$defs/Shutdown/properties/signal` | `ShutdownSignal` | No | Not declared |  |
| `mode`<br />`/$defs/Source/properties/mode` | `SourceMode` | No | `"host-mounted"` |  |
| `root`<br />`/$defs/Source/properties/root` | `string` | No | `"."` |  |
| `kind`<br />`/$defs/Storage/properties/kind` | `StorageKind` | Yes | Not declared |  |
| `scope`<br />`/$defs/Storage/properties/scope` | `StorageScope` | Yes | Not declared |  |
| `build`<br />`/$defs/Workload/properties/build` | `Build` | No | Not declared |  |
| `command`<br />`/$defs/Workload/properties/command` | `Command` | No | Not declared |  |
| `depends_on`<br />`/$defs/Workload/properties/depends_on` | `array<Dependency>` | No | `[]` |  |
| `entrypoint`<br />`/$defs/Workload/properties/entrypoint` | `Entrypoint` | No | Not declared |  |
| `environment`<br />`/$defs/Workload/properties/environment` | `{ [name]: EnvironmentValue }` | No | `{}` |  {"additionalProperties":{"$ref":"#/$defs/EnvironmentValue"}} |
| `image`<br />`/$defs/Workload/properties/image` | `string` | No | Not declared |  |
| `init`<br />`/$defs/Workload/properties/init` | `boolean` | No | Not declared |  |
| `mounts`<br />`/$defs/Workload/properties/mounts` | `array<Mount>` | No | `[]` |  |
| `networks`<br />`/$defs/Workload/properties/networks` | `{ [name]: NetworkAttachment }` | No | Not declared |  {"additionalProperties":{"$ref":"#/$defs/NetworkAttachment"}} |
| `profiles`<br />`/$defs/Workload/properties/profiles` | `array<string>` | No | `[]` |  |
| `pull_policy`<br />`/$defs/Workload/properties/pull_policy` | `PullPolicy` | No | Not declared |  |
| `readiness`<br />`/$defs/Workload/properties/readiness` | `Readiness` | No | Not declared |  |
| `restart`<br />`/$defs/Workload/properties/restart` | `Restart` | No | Not declared |  |
| `shutdown`<br />`/$defs/Workload/properties/shutdown` | `Shutdown` | No | Not declared |  |
| `working_directory`<br />`/$defs/Workload/properties/working_directory` | `string` | No | Not declared |  |
| `pull_policy`<br />`/$defs/Workload/oneOf/0/properties/pull_policy` | `"always" \| "never" \| "missing"` | No | Not declared |  {"enum":["always","never","missing"]} |
| `pull_policy`<br />`/$defs/Workload/oneOf/1/properties/pull_policy` | `"build"` | No | Not declared |  {"const":"build"} |
| `auto_branch`<br />`/$defs/WorktreePolicy/properties/auto_branch` | `boolean` | No | `true` |  |
| `inherit_local`<br />`/$defs/WorktreePolicy/properties/inherit_local` | `boolean` | No | `true` |  |
| `restart`<br />`/properties/jobs/additionalProperties/allOf/1/properties/restart` | `schema-defined` | No | Not declared |  |
| `kind`<br />`/properties/jobs/additionalProperties/allOf/1/properties/restart/properties/kind` | `"no" \| "on-failure"` | No | Not declared |  {"enum":["no","on-failure"]} |

### Type definitions

References in the property table use the following names. A question mark marks an optional property within its object. Array notation includes the element type. Object alternatives remain subject to their required/not constraints.

| Definition | Shape / allowed values |
| --- | --- |
| `Access` | `"read-only" \| "read-write"` |
| `Build` | `{ context: string; dockerfile?: string; target?: string }` |
| `Command` | `{ exec: array<string> } \| { shell: string }` |
| `Dependency` | `{ condition: ServiceCondition; service: string } \| { condition: JobCondition; job: string }` |
| `EndpointProtocol` | `"http" \| "https" \| "tcp"` |
| `EndpointReference` | `{ kind: "route"; name: string } \| { kind: "service"; name: string; port: integer; protocol: EndpointProtocol } \| { kind: "host_binding"; name: string }` |
| `Entrypoint` | `{ exec: array<string> } \| { shell: string }` |
| `EnvironmentSelection` | `{ default_overlay?: string }` |
| `EnvironmentValue` | `{ literal: string } \| { default: string } \| { env_ref: string } \| { unset: True } \| { endpoint: EndpointReference }` |
| `FileConfig` | `{ file: string }` |
| `FileSecret` | `{ file: string } \| { env_ref: string }` |
| `HostBindingTarget` | `{ kind: "host"; port: integer; protocol: EndpointProtocol } \| { hostname: string; kind: "external"; port: integer; protocol: EndpointProtocol }` |
| `HostConfig` | `{ down?: HostHooks; processes?: { [name]: HostProcess }; up?: HostHooks }` |
| `HostConflict` | `"fail" \| "adopt"` |
| `HostEnvTarget` | `{ kind: "host" } \| { kind: "workload"; name: string }` |
| `HostExit` | `"stop_on_down"` |
| `HostHook` | `{ command: Command; cwd?: string; env_target?: HostEnvTarget; environment?: { [name]: EnvironmentValue }; name: string }` |
| `HostHooks` | `{ after?: array<HostHook>; before?: array<HostHook> }` |
| `HostProcess` | `{ command: Command; cwd?: string; env_target?: HostEnvTarget; environment?: { [name]: EnvironmentValue }; exit?: HostExit; singleton?: HostSingleton; startup?: HostStartup }` |
| `HostSingleton` | `{ on_conflict?: HostConflict; ports: array<integer> }` |
| `HostStartup` | `"up"` |
| `HttpProtocol` | `"http" \| "https"` |
| `HttpRoute` | `{ hostname: string; port: integer; protocol?: HttpProtocol; service: string }` |
| `JobCondition` | `"completed"` |
| `Mount` | `{ access: Access; source: string; target: string } \| { access: Access; storage: string; target: string } \| { access: Access; config: string; gid?: integer; mode?: string; target: string; uid?: integer } \| { access: Access; gid?: integer; mode?: string; secret: string; target: string; uid?: integer }` |
| `Network` | `{ internal?: boolean }` |
| `NetworkAttachment` | `{ aliases?: array<string> }` |
| `OpenConfig` | `{ prefer?: OpenPreference }` |
| `OpenPreference` | `"auto" \| "alias" \| "dev"` |
| `PullPolicy` | `"always" \| "never" \| "missing" \| "build"` |
| `Readiness` | `{ command: Command; interval: string; kind: "exec"; retries: integer; timeout: string } \| { interval: string; kind: "http"; path: string; port: integer; retries: integer; timeout: string } \| { interval: string; kind: "tcp"; port: integer; retries: integer; timeout: string }` |
| `Restart` | `{ kind: "no" } \| { kind: "always" } \| { kind: "unless-stopped" } \| { kind: "on-failure"; max_retries?: integer }` |
| `RouteAlias` | `{ domain: string } \| { origin: string }` |
| `Routes` | `{ aliases?: { [name]: RouteAlias }; domain?: string; http?: { [name]: HttpRoute }; oauth_alias?: string; origin?: string }` |
| `ServiceCondition` | `"started" \| "ready"` |
| `Shutdown` | `{ grace?: string; signal?: ShutdownSignal }` |
| `ShutdownSignal` | `"SIGHUP" \| "SIGTERM" \| "SIGINT" \| "SIGQUIT" \| "SIGILL" \| "SIGTRAP" \| "SIGABRT" \| "SIGBUS" \| "SIGFPE" \| "SIGKILL" \| "SIGUSR1" \| "SIGSEGV" \| "SIGUSR2" \| "SIGPIPE" \| "SIGALRM" \| "SIGSTKFLT" \| "SIGCHLD" \| "SIGCONT" \| "SIGSTOP" \| "SIGTSTP" \| "SIGTTIN" \| "SIGTTOU" \| "SIGURG" \| "SIGXCPU" \| "SIGXFSZ" \| "SIGVTALRM" \| "SIGPROF" \| "SIGWINCH" \| "SIGIO" \| "SIGPWR" \| "SIGSYS"` |
| `Source` | `{ mode?: SourceMode; root?: string }` |
| `SourceMode` | `"host-mounted"` |
| `Storage` | `{ kind: StorageKind; scope: StorageScope }` |
| `StorageKind` | `"persistent"` |
| `StorageScope` | `"worktree"` |
| `True` | `true` |
| `Workload` | `{ build?: Build; command?: Command; depends_on?: array<Dependency>; entrypoint?: Entrypoint; environment?: { [name]: EnvironmentValue }; image?: string; init?: boolean; mounts?: array<Mount>; networks?: { [name]: NetworkAttachment }; profiles?: array<string>; pull_policy?: PullPolicy; readiness?: Readiness; restart?: Restart; shutdown?: Shutdown; working_directory?: string }; {"oneOf":[{"not":{"required":["build"]},"properties":{"pull_policy":{"enum":["always","never","missing"]}},"required":["image"]},{"not":{"required":["image"]},"properties":{"pull_policy":{"const":"build"}},"required":["build"]}]}` |
| `WorktreePolicy` | `{ auto_branch?: boolean; inherit_local?: boolean }` |

### Workload variants

A workload requires exactly one of image and build. Supplying both or neither is invalid. Other property defaults do not remove this oneOf requirement.

| Variant | Required | Forbidden | pull_policy when supplied |
| --- | --- | --- | --- |
| Existing image | image | build | always, never or missing |
| Build context | build | image | build only |

The pull_policy variant restrictions constrain supplied values; they do not make the optional pull_policy property required.

## Local override document

[Pinned machine schema](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/packages/config-compiler/generated/hack.local.schema.json). Each pointer identifies a field declaration in that schema, including definitions and union variants.

| Field / schema pointer | Type or reference | Required here | Default | Meaning / constraints |
| --- | --- | --- | --- | --- |
| `environment`<br />`/properties/environment` | `LocalEnvironment` | No | `{}` |  |
| `host_bindings`<br />`/properties/host_bindings` | `{ [name]: HostBindingTarget \| null }` | No | Not declared |  {"additionalProperties":{"anyOf":[{"$ref":"#/$defs/HostBindingTarget"},{"type":"null"}]}} |
| `open`<br />`/properties/open` | `LocalOpen` | No | Not declared |  |
| `routes`<br />`/properties/routes` | `LocalRoutes` | No | Not declared |  |
| `schema_version`<br />`/properties/schema_version` | `integer` | Yes | Not declared |  {"minimum":1,"maximum":1} |
| `kind`<br />`/$defs/HostBindingTarget/oneOf/0/properties/kind` | `"host"` | Yes | Not declared |  {"const":"host"} |
| `port`<br />`/$defs/HostBindingTarget/oneOf/0/properties/port` | `integer` | Yes | Not declared |  {"minimum":1,"maximum":65535} |
| `protocol`<br />`/$defs/HostBindingTarget/oneOf/0/properties/protocol` | `EndpointProtocol` | Yes | Not declared |  |
| `hostname`<br />`/$defs/HostBindingTarget/oneOf/1/properties/hostname` | `string` | Yes | Not declared |  {"minLength":1,"maxLength":253} |
| `kind`<br />`/$defs/HostBindingTarget/oneOf/1/properties/kind` | `"external"` | Yes | Not declared |  {"const":"external"} |
| `port`<br />`/$defs/HostBindingTarget/oneOf/1/properties/port` | `integer` | Yes | Not declared |  {"minimum":1,"maximum":65535} |
| `protocol`<br />`/$defs/HostBindingTarget/oneOf/1/properties/protocol` | `EndpointProtocol` | Yes | Not declared |  |
| `default_overlay`<br />`/$defs/LocalEnvironment/properties/default_overlay` | `['string', 'null']` | No | Not declared |  {"pattern":"^[a-z0-9]+(?:-[a-z0-9]+)*$"} |
| `prefer`<br />`/$defs/LocalOpen/properties/prefer` | `OpenPreference` | No | Not declared |  |
| `domain`<br />`/$defs/LocalRoutes/properties/domain` | `string` | No | Not declared |  |

### Type definitions

References in the property table use the following names. A question mark marks an optional property within its object. Array notation includes the element type. Object alternatives remain subject to their required/not constraints.

| Definition | Shape / allowed values |
| --- | --- |
| `EndpointProtocol` | `"http" \| "https" \| "tcp"` |
| `HostBindingTarget` | `{ kind: "host"; port: integer; protocol: EndpointProtocol } \| { hostname: string; kind: "external"; port: integer; protocol: EndpointProtocol }` |
| `LocalEnvironment` | `{ default_overlay?: ['string', 'null'] }` |
| `LocalOpen` | `{ prefer?: OpenPreference }` |
| `LocalRoutes` | `{ domain?: string }` |
| `OpenPreference` | `"auto" \| "alias" \| "dev"` |

