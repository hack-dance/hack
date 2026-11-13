# Native followed-log acceptance

Log following remains **available under verification** until the current changes
pass against authored and adopted projects on a real Apple Silicon VM. Portable
fake Engine and process tests do not qualify the VM relay or macOS kqueue.

For the authored case, copy
[`native-log-follow.project.json`](../../tests/fixtures/native-log-follow.project.json)
to an isolated project's `.hack/hack.project.json`. It needs an ARM64 Alpine image
with `/bin/sh`, `/bin/true` and `sleep`; pin or substitute the harness's already
acquired image for `alpine:3.21`. `web` emits stdout once per second; `db` emits
stderr once per five seconds. Both use explicit exec readiness. No mounts, secrets,
host commands, published ports or database persistence are needed: `db` is a
stderr-only stand-in, not a database qualification.

Use the current compiled CLI and runtime with the harness's native selection.
Start the project and wait for both services to be Ready. Repeat these checks on
the adopted fixture as well:

1. After `down`, run `logs web --follow --json`. Require exit 1, only compact
   JSON objects on stdout (if a session started, exactly one start and one named
   end), and no appended global error envelope. Invalid tail arguments report on
   stderr with empty stdout in native follow mode.
2. While running, `logs db --follow --tail 0 | head -1` receives service stderr
   through stdout. Once head closes, the follower exits 0 without waiting five
   seconds for the next line; no native reader remains. Check the compiled macOS
   binary so the kqueue FFI load is exercised.
3. Compare plain `logs web --no-follow --tail 1` with followed lines: raw application
   text, no service prefix or Engine timestamp. With `--timestamps`, verify the
   timestamp prefix and JSON `entry.timestamp`, including nanoseconds.
4. Exercise `--since 1s`, `--tail 0`, a quiet service and a TTY-configured adopted
   service. Since and tail appear in the Engine request; TTY refuses by name.
   Repeat the 70,000-byte stdout and stderr bursts while the guest is busy.
   If a follower fails, record its end reason, phase and fixed diagnostic (no log
   payload). `periodic-check` with a timeout points to container inspection;
   `frame-header` or `http-framing` points to decoding. Fragmentation fixtures
   passing does not qualify this busy-guest case or prove the observed failure fixed.
5. Keep one JSON follower through `restart`. Require one `notice` with reason
   `native_log_restarted`, then fresh-container lines, with no second start or
   replay of the previous generation. Plain restart notices go to stderr.
   For adopted restore, record the retained run ID and replacement container ID;
   the follower must reattach even when the run and provider owner are unchanged.
   More than 1000 startup lines may lose their oldest prefix by the documented bound.
   Repeat with a stop that takes more than 30 seconds: reattach must still work
   within the 30-second wait after the old service ends.
6. Run `down` with followers attached. Require prompt exit 0, one stderr stopped
   notice, `end.reason: "native_log_service_stopped"`, and no reader left. Compare
   down latency without making a performance claim from a single pair.
   Also kill the fixture's restart after the old service stops but before Ready,
   then run `down` while its advisory marker remains unexpired. With no replacement container,
   the follower waits at most 30 seconds and ends with
   `native_log_restart_unavailable`, exit 1.
7. Produce a line over 64 Ki characters, a partial final line, and a timestamped
   line over the Engine's 16 KiB partial-frame boundary. Require truncation plus
   continuation, `[partial]` where appropriate, and no embedded Engine timestamp
   prefixes or timestamp contribution to the payload limit. A stopped transport
   that never reaches EOF must end with `native_log_stopped_idle`, exit 1 and a
   named end, not a clean stop; its last validated prefix remains marked partial.
8. Exercise Ctrl-C (130), frontend death, native reader loss, VM loss and a slow
   consumer. Only confirmed stopped/absent state plus real EOF is a clean stop.
   Ordinary end delivery waits for the consumer; cancellation stays bounded.

Keep the exact CLI/runtime revisions and both project results in the PR. Only
passing runs for both authored and adopted projects permit changing the
limits/README status to supported.
