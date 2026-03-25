---
kind: linear-project-status-update
linearProjectId: "7a3c8adf-ede5-4d3a-8779-9c32695c76bf"
title: Mission freeze for optional web control plane
linearId: "5c842fc1-164f-4f1e-b4bf-d7305ca1133b"
slug: mission-freeze-optional-web-control-plane
archived: false
updatedAt: "2026-03-25T15:08:58.123Z"
date: "2026-03-24"
publishedAt: "2026-03-25T15:08:58.123Z"
health: onTrack
---
## Summary

Seeded the frozen mission closeout scope and created the missing optional-web-control-plane issue hierarchy under the bound Hack Linear project.

## Open at mission start

- HACK-457 — Dogfood the Hack App Linear project through Hack-native planning and sync flows
- HACK-458 — Improve autosync, webhook delivery, and operator visibility for Linear sync
- HACK-463 — Harden the Docker Desktop primary path and remove fragile Orbstack assumptions
- HACK-470 — Connect team and organization administration to env sharing and project ownership
- HACK-471 — Separate local-only versus broker or cloud-mediated admin operations
- HACK-474 — Define the proposed runtime architecture, interfaces, and build-versus-borrow boundaries
- HACK-475 — Produce a separation plan so runtime R&D informs but does not block the current hardening roadmap
- HACK-558 — Support multiline env values in Hack plaintext env workflow

## Mission-created optional web control plane hierarchy

- HACK-559 — Optional web control plane delivery tracker
  - HACK-560 — Shared auth and web foundation
  - HACK-561 — Org, team, and project administration
  - HACK-562 — GitHub and Linear integration management
  - HACK-563 — Env status, CLI optionality, and closeout

## Audit notes

- The authoritative frozen scope lives in `linear-closeout-scope.json` in the mission directory.
- Repo-bound project documents and milestones were pulled into `.hack/linear/projects/7a3c8adf-ede5-4d3a-8779-9c32695c76bf/` so later workers can use canonical artifacts instead of legacy paths.