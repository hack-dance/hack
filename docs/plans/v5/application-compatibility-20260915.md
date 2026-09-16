# Application compatibility work, September 15

The registered application remains a 12-service plan with 21 errors. Its source configuration has
not been changed and the candidate has not started it. These are concrete missing behaviors,
not parser errors that can safely be ignored.

| Finding | Supported replacement or remaining implementation |
| --- | --- |
| One external shared network | `x-hack-isolated: true` now provides an explicit candidate-owned internal bridge replacement for an isolated cohort. It does not supply the application's outbound dependencies or shared routing. |
| Nine Caddy route declarations | [Verified guest endpoint discovery](guest-endpoints-20260915.md) now binds destinations to current container/network identities. Host publication, interface reachability and TLS/hostname routing remain open; removing labels alone does not implement routes. |
| Eleven AWS home-directory mounts | Obtain scoped, expiring credentials through a native provider and inject them through the environment launcher. Never mount the host credential directory or use an old receipt as authority. |
| Two environment-file inputs shared by application services | The execution-input compiler still rejects `env_file`; integrate the managed environment resolver without returning values in plans, receipts or logs. |
| Twelve services versus the original eight-service bound | The driver now allows 32 services, with matching probe and receipt bounds. The four-CPU/4-GiB aggregate guard remains; the actual application's resource declarations still need qualification. |
| Editable source and application runtime | Qualify writable build outputs, dependency installation, lifecycle helpers and source updates. Existing filtered, read-only source primitives are not complete development-workflow acceptance. |

The network replacement changes the reviewed network intent and plan identity, with an explicit
warning. Ordinary external declarations still fail. Credentials, route labels, external volumes,
unsupported drivers and malformed options retain their refusals. The Compose input is never
rewritten by planning or enrollment.

The actual application needs outbound services, so the isolated option has not been inserted into
its working configuration. Use the [real-project checkpoint matrix](real-project-checkpoints.md)
to qualify the complete replacement; the original application still has all 21 errors until its
selected configuration supplies the required supported behavior.

The application also enables watcher-related environment names (`CHOKIDAR_USEPOLLING` and
`WATCHPACK_POLLING`) on several development services. Their effective values and CPU cost have not
been measured here. Revisit them after candidate source delivery preserves filesystem notifications;
changing them without edit/rebuild acceptance could reduce CPU by losing updates.
