# Native backend (beta): reference

The detailed material, by topic. Start with the [overview](README.md) and
[try it](try-it.md) if you have not used the native backend yet.

## Install and versions

- [Install a prerelease](../guides/candidate-install.md): the `hack-next` channel,
  running both backends, upgrade and rollback.
- [Prerelease channel](../guides/prereleases.md): versions, platforms and what a
  release contains.
- [Qualify a project on v5](../guides/v5-dogfooding.md): a staged plan for moving
  one project at a time.

## Commands and configuration

- [Native authored commands](../reference/native-authored-commands.md): exactly
  what `up`, `restart`, `down`, `ps`, `logs`, `exec` and `run` do on native.
- [Native config import](../reference/native-config-import.md): preview and adopt
  an existing project's configuration.
- [Native settings files](../guides/native-candidate.md#native-settings-files):
  the committed project file and the per-machine file that replace exported
  variables.

## The full native reference

[The native backend reference](../guides/native-candidate.md) is one long page. These
are its main sections:

| Topic | Section |
| --- | --- |
| Which projects stay on Compose | [Compose projects that stay on the Compose backend](../guides/native-candidate.md#compose-projects-that-stay-on-the-compose-backend) |
| Runtime setup, upgrade and rollback | [Manual candidate upgrade and rollback](../guides/native-candidate.md#manual-candidate-upgrade-and-rollback) |
| How a Compose file is read | [Explicit normalized public Compose input](../guides/native-candidate.md#explicit-normalized-public-compose-input) |
| Container permissions | [Container capabilities and the security model](../guides/native-candidate.md#container-capabilities-and-the-security-model) |
| Pulling images | [Registry image acquisition without Docker](../guides/native-candidate.md#registry-image-acquisition-without-docker) |
| Registry sign-in | [Registry credentials](../guides/native-candidate.md#registry-credentials) |
| Sharing your source tree | [Explicit writable development source](../guides/native-candidate.md#explicit-writable-development-source) |
| What each command supports | [Frontend integration status](../guides/native-candidate.md#frontend-integration-status) |
| Intel-only images | [amd64 emulation with Rosetta 2](../guides/native-candidate.md#amd64-emulation-with-rosetta-2) |
| Source size | [Source size limit](../guides/native-candidate.md#source-size-limit) |
| Local HTTPS | [Optional native HTTPS frontend](../guides/native-candidate.md#optional-native-https-frontend) |
| After a crash | [Explicit cleanup after a dead foreground owner](../guides/native-candidate.md#explicit-cleanup-after-a-dead-foreground-owner) |

## How it works

- [Architecture: backends](../architecture.md#backends) shows the two backends side
  by side.
- [Architecture: native backend internals](../architecture.md#native-backend-internals)
  explains ownership, startup and cleanup with state charts.
- [Model coverage](../reference/v5-model-coverage.md) lists what the formal models
  check and what they do not.
