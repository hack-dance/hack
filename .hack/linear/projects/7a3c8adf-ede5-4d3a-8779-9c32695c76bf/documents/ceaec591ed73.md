---
kind: linear-project-document
linearProjectId: "7a3c8adf-ede5-4d3a-8779-9c32695c76bf"
title: Tickets Normalization And Storage Spec
linearId: df7c847f-1c0d-4674-b9c4-2b72e39e75e0
slug: ceaec591ed73
archived: false
updatedAt: "2026-03-12T15:49:35.745Z"
sortOrder: 4342
---
## Goal

Make Hack Tickets the canonical normalized issue model that can power local-first workflows while syncing cleanly with external systems.

## Target Model

Hack Tickets should remain portable and git-friendly, but no longer depend on a purely in-memory projection of an append-only git log. The target architecture is:

* Append-only journal and durable history.
* SQLite-backed local projection for fast reads, indexing, and extensibility.
* Git-backed portability through hidden ref sync.
* External-link and provenance metadata for Linear, GitHub, Asana, and future sources.

## Required Capabilities

* Rebuild projection deterministically from journal state.
* Support idempotent repeated event application across multiple machines.
* Handle multi-writer sync without duplicating or corrupting state.
* Preserve source lineage and authority decisions for external sync.
* Add first-class markdown-backed ticket documents or spec attachments.

## Sync Posture

Hack Tickets is the normalized core, not a thin wrapper. Adapters map in and out of Linear, GitHub, Asana, and other sources while preserving provenance and conflict state.

## Storage Direction

Git remains the durable portable layer. SQLite becomes the operational read and sync engine. Journal entries must be replayable, inspectable, and safe to sync repeatedly.

## Acceptance Criteria

Tickets can be created, queried, rebuilt, and synced without loss of history. External source changes can be applied idempotently. Multi-machine users converge on the same normalized state, and richer document/spec associations become possible without abandoning markdown portability.