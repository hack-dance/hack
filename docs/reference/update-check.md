# Read-only update check

`hack update --check --json --observe` says whether a newer Hack release exists
for the running CLI and how this install would upgrade. It works for every
install kind, including Homebrew and the `hack-next` candidate launcher, which
`hack update` itself refuses to modify.

It makes one bounded read of the public GitHub releases API (10 seconds). It
never downloads, installs, prompts, writes files, looks Hack up on PATH, or
contacts hackd, Docker or a VM.

```json
{
  "ok": true,
  "data": {
    "current": "5.0.0-next.17",
    "channel": "next",
    "latest": "5.0.0-next.18",
    "available": true,
    "install_kind": "candidate",
    "upgrade_command": [
      "/example/user/.hack-next/bin/hack-next",
      "--manager",
      "upgrade",
      "--version",
      "5.0.0-next.18"
    ],
    "reason": null,
    "schema": "hack.update-check.v1"
  }
}
```

| Field | Meaning |
| --- | --- |
| `current`, `channel` | The running CLI, as in [`hack version --json`](./version.md). |
| `latest` | Stable channel: GitHub's latest release. Next channel: the newest non-draft `-next.N` release with the same major version on the first page of the release list (up to 100, newest created first). `null` when unknown. |
| `available` | `true` when `latest` is newer than `current`, `false` when not, `null` when unknown. |
| `install_kind` | `candidate` under a candidate launcher; otherwise the [version identity](./version.md) kind (`homebrew`, `standalone`, `source`, `symlink`, `dev-wrapper`, `unknown`). |
| `upgrade_command` | The argv to run in a terminal, only when `available` is `true` and this install has a supported path: a native `hack-next` launch → that channel root's own `bin/hack-next --manager upgrade --version` (the root comes from the executor the launcher pinned, and the launcher file must exist); stable Homebrew → `brew upgrade hack-dance/tap/hack`; stable standalone → that binary's `update`. Otherwise `null`, including a Compose-backend `hack-next` launch (no root is exported), other candidate launchers (such as a bundle's `hack-v5`) and next-channel Homebrew or standalone installs, whose update paths install stable. |
| `reason` | `null` when `latest` and `available` are known; else `network-unavailable`, `release-unavailable` (error response, no matching release, an unexpected tag, or a full next-channel page that cannot rule out a newer release) or `version-unrecognized` (a version other than `X.Y.Z` or `X.Y.Z-next.N`). |

The release list is ordered by creation time, not version, and the check reads
one page. A newer candidate on that page is reported as available. "Not
available" is reported only when the page is not full or contains the running
version's own release, so every release created after it is on the page.

Known false negative: GitHub's creation time is when the release (or its draft)
was created. A newer candidate whose release was created *before* the running
version's release, and that a full page has pushed onto page two, is not seen;
the check then reports `available: false`. Hack's release workflow creates
releases in version order, so this needs a release drafted out of order. Treat
`available: false` as "no newer release in the current listing", not proof.

Unknown is not "up to date": an offline machine reports `available: null`, still
with exit 0, because the observation itself succeeded. `upgrade_command` is
advice, not permission: review it and run it yourself. `hack update` (without
`--observe`) keeps its existing output and refusals.

`--observe` requires `--check` and `--json`, and cannot be combined with
`--yes` or `--tag`; those return `E_USAGE` before any network read. See
[Machine-readable output](./machine-readable-output.md).
