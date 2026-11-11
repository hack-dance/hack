# Global settings

Machine-wide settings live in `~/.hack/hack.config.json`. Use the CLI instead of
editing the file by hand:

```bash
hack config get --global sessions.mux
hack config set --global sessions.mux tmux
```

Automatic settings updates, including `hack env backend use`, create a missing
global config but refuse to replace an existing unreadable file, malformed JSON or
a non-object JSON value. An empty file is invalid JSON. Repair the reported file
before retrying; a failed update preserves its contents.

Common settings:

- `sessions.mux` (default `auto`; `auto|tmux|zellij|none`) — multiplexer for `hack session`.
- `controlPlane.tui.logs.maxEntries` (default `2000`) — log buffer cap in `hack tui`.
- `controlPlane.tui.logs.maxLines` (default `400`) — rendered log lines cap.
- `controlPlane.tui.logs.historyTailStep` (default `200`) — history page size.
- `controlPlane.usage.watchIntervalMs` (default `2000`) — sample interval for `hack usage --watch`.
- `controlPlane.usage.historySize` (default `24`) — sample history for `hack usage --watch`.

Project-level settings live in `.hack/hack.config.json` and override global ones
where both apply. Settings for the unsupported gateway, cluster and cloud-provider
extensions also live here under `controlPlane.*`; see
[unsupported retained surfaces](../extensions.md).
