# V5 prerelease channel

V5 native prereleases use a separate release and installation channel. Stable
Homebrew `hack` keeps its existing executable and state. A candidate is selected
explicitly through `hack-next`; installing one does not migrate a project, start a
VM, install DNS or trust, or replace stable Hack.

The first supported package is for Apple Silicon macOS. Provider installation,
native project adaptations and host routing remain explicit prerequisites in the
[native candidate guide](native-candidate.md). A packaged candidate is not a claim
of full Compose parity, lower resource use, or compatibility with every project.

## Versions and artifacts

Candidate versions have the form `5.0.0-next.N`, where `N` is a positive integer
without leading zeros. The matching Git tag is `v5.0.0-next.N`. Each version is
immutable: a failed or superseded release gets a new number rather than replacing
its tag or assets.

The native archive is named `hack-5.0.0-next.N-darwin-arm64-native.tar.gz`. It
contains the complete frontend, executor, guest relay, launcher, provider pins,
guide, checksums and `prerelease.json` provenance. The compiled frontend reports
the candidate version. The provenance records the exact source commit and
platform; filenames alone do not establish either.

Verify the archive checksum and every bundled file before executing the candidate.
The macOS executable signatures are ad-hoc code-integrity checks. They do not
establish a publisher identity or Apple notarization. The pinned official GitHub
release is the distribution source.

## Prepare and publish

Preparation and publication are separate operations. Preparation validates the
version and source, builds the complete native package, and retains reviewable
artifacts without creating a Git tag or release.

After the channel workflow is merged into `next`, dispatch the existing `Release`
workflow on that branch with an explicit version and its full commit SHA:

```sh
gh workflow run release.yml --ref next \
  -f channel=prerelease \
  -f prerelease_version=5.0.0-next.1 \
  -f source_revision=FULL_NEXT_COMMIT_SHA \
  -f publish_prerelease=false
```

Use the intended candidate's actual SHA in place of `FULL_NEXT_COMMIT_SHA` and an
unused version number. Download the `v5-prerelease-VERSION` Actions artifact from
that run to review the archive, provenance and checksum. The reusable candidate
workflow resolves from the same commit as its caller; no new default-branch
workflow registration is needed for this entry point.

A local versioned build uses the same native bundle builder and requires a clean,
committed source checkout:

```sh
mise exec -- scripts/build-native-candidate.sh /absolute/new/candidate-bundle \
  --version=5.0.0-next.1
```

This builds software and provenance only; it does not reserve the version number,
create a tag, or publish a release.

Publication requires an explicit publish request for the exact protected `next`
commit, successful checks for that commit, and approval through a configured
`v5-prerelease` GitHub environment. An environment without required reviewers is
not an approval gate. Publication refuses missing protection or approval, changed
source, failed checks, and an existing tag or release.

To request publication after reviewing the candidate, dispatch the same command
with `publish_prerelease=true`. The workflow checks protection and exact-head CI
before scheduling review, then checks the head, checks, human approval and tag
absence again before publication. Only the first attempt of a workflow run can
publish. If publication fails after creating a tag, preserve it for inspection
and use a new version; do not force-push or overwrite it.

Candidate releases are marked as GitHub prereleases and excluded from “latest.”
They never update the stable Homebrew formula. The stable release workflow rejects
prerelease tags; stable semantic releases continue to use `main`.

The branch dispatch and same-commit workflow selection follow GitHub's
[manual dispatch](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
and [reusable workflow](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)
contracts. The publish build runs on the Apple Silicon `macos-15` runner; application
VM tests remain on a separately qualified native host.

## Install, upgrade and return to stable

Use the [candidate installer guide](candidate-install.md) for the explicit
version-pinned installation commands and lifecycle controls. The installer keeps
candidate bundles and homes separate from stable `hack` and `~/.hack`; it does not
change shell configuration or silently select a candidate.

An upgrade retains the previous bundle and home. Selection changes require the
owning candidate CLI to confirm quiescence. A running runtime, timeout, malformed
receipt or uncertain ownership blocks the switch. Stop owned applications through
their ordinary commands before retrying; a failed probe is not evidence of an idle
runtime.

Rollback selects a retained, verified candidate installation. Each installation
keeps its own home; selecting a different one does not copy VM disks, credentials
or application data. Returning to stable selects the existing stable executable
and its original Docker state. Preserve candidate data for a later retry rather
than trying to make a v4 executable read v5 receipts.

Before accepting a candidate for a project, verify normal start, status, logs,
exec, run, restart and retaining shutdown, then exercise its browser sign-in,
data-backed pages and assets. Record the bundle version and source commit with
the result. Unit tests, hosted CI and a responding health endpoint do not replace
that application check.
