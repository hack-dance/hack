# Follow native service logs (under verification)

Native live logs are available in next.16 **under verification**. Real-VM
acceptance for authored and adopted projects remains pending. Use a disposable
project; this page describes the released command contract, not a confirmed
application result.

Start the project and wait for the service to be ready, then select one service:

```sh
hack-next logs api --follow --tail 50 --path /absolute/project
hack-next logs api --follow --since 10m --json --path /absolute/project
```

Replace `api` with a declared service. Follow is the default. `--tail` accepts
0–1000 lines (default 200); `--tail 0` reads only new lines. `--since` accepts a
timestamp or duration. Its time window is still limited by the selected tail.
For a finite snapshot, use `--no-follow` instead.

Plain output preserves stdout/stderr. JSON uses `start`, `log` and `end` events
with `backend: "native"`. The follower pins one saved container and start
generation; it does not switch to a replacement after restart.

| Result | Meaning |
| --- | --- |
| Ctrl-C, exit 130 | Stops the reader only; the project keeps running. |
| Stream EOF with a confirmed stop/removal, exit 0 | The selected service's read has ended. |
| `native_log_stopped_idle`, exit 1 | The stopped service's stream stayed open for five idle seconds; its final tail may be incomplete. |
| `native_log_stream_uncertain` | Transport ended without proof of a confirmed service stop. |
| `native_log_container_restarted` | A different start generation was observed; start a new follower. |
| `native_log_selection_changed` | The saved selection or readiness changed; it does not wait for startup. |
| `native_log_tty_unsupported` | Following a TTY-configured service is refused. |
| Output pipe closes, exit 0 | Stops the reader quietly, for example when piping to `head -1`. |

The reader holds no mutation lease and does not reserve the lifecycle lock
against `up`, `down` or `restart`. No stream result grants cleanup authority.
Multiple services, Loki queries, `--until`, profiles and unsupported flags are
refused by name. Lines above 64 Ki characters retain a prefix marked
`[truncated]`; a trailing fragment is marked `[partial]`. JSON also carries
`truncated: true` or `partial: true`.

Read [the limits](limits.md) and the
[full log contract](authored-commands.md#followed-service-logs) before scripting
exit handling or JSON. Linux stand-in tests cover framing and cancellation;
actual Engine EOF and provider behavior still need Apple Silicon acceptance.

Source: [next.16 followed-service log contract](https://github.com/hack-dance/hack/blob/b21c3b189841c1a3cbb8af2b76414fa347dc7057/docs/reference/native-authored-commands.md#followed-service-logs).
