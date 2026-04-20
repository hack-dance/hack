# Prerequisite Detection Matrix

The supported v3 prerequisite matrix is local-first.

## Checks

| Check | Domain | Meaning | Guidance |
| --- | --- | --- | --- |
| `docker_cli` | Docker | Docker CLI is installed | Install Docker Desktop or OrbStack |
| `docker_daemon` | Docker | Docker engine is reachable | Start the backend or run `hack global install` |
| `global_bootstrap` | Global | `~/.hack` global stack exists | Run `hack global install` |
| `global_services` | Global | DNS/TLS/logging services are reachable | Run `hack global up` |
| `mux_backend` | Sessions | The selected mux backend is installed | Install tmux or zellij, or change `sessions.mux` |
| `tmux_binary` | Sessions | tmux exists for tmux-specific flows | Install tmux |

## Command groups

| Commands | Expected checks |
| --- | --- |
| `hack global install` | `docker_cli`, `docker_daemon` |
| `hack global up`, `hack global status`, `hack global logs` | `docker_cli`, `docker_daemon`, `global_bootstrap` |
| `hack up`, `hack down`, `hack restart`, `hack ps`, `hack logs`, `hack open` | `docker_cli`, `docker_daemon` |
| `hack doctor` | all relevant local checks |
| `hack session` | `mux_backend` |

Broker-backed and hosted integration prerequisites were removed with the v3 simplification reset.

In v3, `hack doctor` also checks local project-runtime hygiene. When it detects missing registry
entries or orphaned runtime containers, it should guide operators to `hack projects prune`.
For modern env repos, it also checks whether materialized `.hack/.env` compatibility output is
stale and guides operators to `hack env materialize` when the state file or input digests drift.
