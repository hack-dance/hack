# Check a Compose project for native

Native preflight lists the blockers and notes that would affect a Compose-file
project on the native backend, with a fix for each finding. It runs no VM, image
pull or lifecycle hook, and writes nothing to the project.

```sh
hack doctor --native-preflight --path /absolute/project
hack doctor --native-preflight --path /absolute/project --profile dev,ops
hack doctor --native-preflight --path /absolute/project --json
```

Use the profiles your project declares. This mode accepts only `--path`,
`--profile` and `--json` beside `--native-preflight`; it does not run Doctor's
other checks or repairs. Preflight has no `--env` option; it always uses the
project's default environment. `hack up --env <name>`, or a resumed run's
environment, can select different adaptation and dependency files. Authored
native project files take a separate admission path; use `hack config validate`
for them.

Changes intended for next.17: preflight reads allowed caller-shell variables,
decrypts managed env and reads `.env` beside Compose (normally `.hack/.env`),
using the same file checks as native start. A missing decryption key is a
structured blocker with recovery guidance; the command still produces a report.
A project-root `.env` outside the Compose directory is ignored with one notice.
Detached starts omit per-key "unresolved input" notices because owner stdio is
ignored; use this preflight or a foreground start to inspect missing inputs.
See the [environment-file rules](https://github.com/hack-dance/hack/blob/9cd2053affe4f3307703e97d5bb4cd7fc3049830/docs/native/environment-files.md) and
[migration notes](https://github.com/hack-dance/hack/blob/9cd2053affe4f3307703e97d5bb4cd7fc3049830/docs/guides/v5-release-notes.md#next17-what-changed-and-what-to-do)
before upgrading an earlier prerelease.

## Read the result

The CLI checks the selected native adaptation and project-wide host aliases,
then asks the selected native runtime for a read-only project-plan review.
For that full review, run the command through the `hack-next` launcher described
on [Install](../install.md). The review needs no running VM.
The selected runtime also receives a read-only setup inspection. If setup is
incomplete or unavailable, preflight reports a `native_runtime_setup` blocker;
run `hack native setup` before retrying. Without native selection, setup is
reported as unavailable and the runtime review is skipped.

| `runtime_review.status` | Meaning |
| --- | --- |
| `completed` | The runtime review finished. |
| `stopped` | A problem stopped the review early; fix it and rerun for further findings. |
| `skipped` | No usable runtime was selected, or an input problem prevented review. |
| `unavailable` | The selected runtime did not return a review. |

With `--json`, the report is inside `data` of the result envelope. Read `ready`,
`blockers`, `warnings`, `runtime_setup` and `runtime_review`; `ready: true`
requires setup to be ready and the runtime review to complete without blockers.
`ok: true` means the command produced
a report. For a produced report, exit status is 1 when blockers were found and
0 otherwise. Usage refusals exit non-zero without producing a report. An exit
of 0 can still have `ready: false` when the runtime review was skipped or unavailable.

Findings name closed codes, services and fields, with fixed explanations and
fixes; they do not print authored environment values or image names. Fix the
reported blockers, rerun preflight, then follow [Try it](try-it.md) for a disposable
native trial. `hack up` still performs its own admission checks; a clean preflight
does not start services or establish application behavior.

See [What works and known limits](limits.md) and the
[full native reference](full-reference.md) for the capability boundaries.
