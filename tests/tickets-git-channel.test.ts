import { expect, test } from "bun:test";

import { __testOnly } from "../src/control-plane/extensions/tickets/tickets-git-channel.ts";

test("mergeTicketEventLogs dedupes by event id and preserves chronological order", () => {
  const merged = __testOnly.mergeTicketEventLogs({
    existing: [
      JSON.stringify({
        eventId: "event-2",
        schemaVersion: 1,
        ts: 2,
        occurredAt: "2026-03-13T00:00:02.000Z",
        recordedAt: "2026-03-13T00:00:02.000Z",
        sourceSystem: "hack",
        sourceOperation: "ticket.created",
        idempotencyKey: "event-2",
        ticketId: "T-00002",
        eventType: "ticket.created",
        type: "ticket.created",
        payload: {},
      }),
      JSON.stringify({
        eventId: "event-3",
        schemaVersion: 1,
        ts: 3,
        occurredAt: "2026-03-13T00:00:03.000Z",
        recordedAt: "2026-03-13T00:00:03.000Z",
        sourceSystem: "hack",
        sourceOperation: "ticket.created",
        idempotencyKey: "event-3",
        ticketId: "T-00003",
        eventType: "ticket.created",
        type: "ticket.created",
        payload: {},
      }),
      "",
    ].join("\n"),
    incoming: [
      JSON.stringify({
        eventId: "event-1",
        schemaVersion: 1,
        ts: 1,
        occurredAt: "2026-03-13T00:00:01.000Z",
        recordedAt: "2026-03-13T00:00:01.000Z",
        sourceSystem: "linear",
        sourceOperation: "issue.import",
        idempotencyKey: "linear:issue:1",
        ticketId: "T-00001",
        eventType: "ticket.created",
        type: "ticket.created",
        payload: {},
      }),
      JSON.stringify({
        eventId: "event-2",
        schemaVersion: 1,
        ts: 2,
        occurredAt: "2026-03-13T00:00:02.000Z",
        recordedAt: "2026-03-13T00:00:02.000Z",
        sourceSystem: "hack",
        sourceOperation: "ticket.created",
        idempotencyKey: "event-2",
        ticketId: "T-00002",
        eventType: "ticket.created",
        type: "ticket.created",
        payload: {},
      }),
      "",
    ].join("\n"),
  });

  const lines = merged
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          readonly eventId: string;
          readonly ts: number;
          readonly schemaVersion: number;
          readonly sourceSystem: string;
          readonly sourceOperation: string;
          readonly idempotencyKey: string;
          readonly eventType: string;
        }
    );

  expect(lines.map((line) => line.eventId)).toEqual([
    "event-1",
    "event-2",
    "event-3",
  ]);
  expect(lines.map((line) => line.ts)).toEqual([1, 2, 3]);
  expect(lines[0]).toMatchObject({
    schemaVersion: 1,
    sourceSystem: "linear",
    sourceOperation: "issue.import",
    idempotencyKey: "linear:issue:1",
    eventType: "ticket.created",
  });
});

test("mergeTicketEventLogs preserves normalized journal envelope fields", () => {
  const merged = __testOnly.mergeTicketEventLogs({
    existing: [
      JSON.stringify({
        eventId: "event-2",
        schemaVersion: 1,
        ts: 2,
        occurredAt: "2026-03-13T10:00:02.000Z",
        recordedAt: "2026-03-13T10:00:03.000Z",
        ticketId: "T-00002",
        type: "ticket.created",
        sourceSystem: "linear",
        sourceOperation: "webhook_pull",
        idempotencyKey: "linear:event-2",
      }),
      "",
    ].join("\n"),
    incoming: [
      JSON.stringify({
        eventId: "event-1",
        schemaVersion: 1,
        ts: 1,
        occurredAt: "2026-03-13T10:00:01.000Z",
        recordedAt: "2026-03-13T10:00:01.500Z",
        ticketId: "T-00001",
        type: "ticket.created",
        sourceSystem: "hack",
        sourceOperation: "local_command",
        idempotencyKey: "hack:event-1",
      }),
      "",
    ].join("\n"),
  });

  const lines = merged
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  expect(lines).toEqual([
    expect.objectContaining({
      eventId: "event-1",
      schemaVersion: 1,
      sourceSystem: "hack",
      sourceOperation: "local_command",
      idempotencyKey: "hack:event-1",
    }),
    expect.objectContaining({
      eventId: "event-2",
      schemaVersion: 1,
      sourceSystem: "linear",
      sourceOperation: "webhook_pull",
      idempotencyKey: "linear:event-2",
    }),
  ]);
});

test("resolvePushRefForCheckoutRef prefers legacy branch when checkout came from legacy tracking ref", () => {
  const pushRef = __testOnly.resolvePushRefForCheckoutRef({
    checkoutRef: "refs/remotes/origin/__legacy__/hack/tickets",
    remoteRef: "refs/hack/tickets",
    legacyTrackingRef: "refs/remotes/origin/__legacy__/hack/tickets",
    legacyRemoteRef: "refs/heads/hack/tickets",
  });

  expect(pushRef).toBe("refs/heads/hack/tickets");
});

test("resolvePushRefForCheckoutRef keeps hidden ref when checkout came from hidden tracking ref", () => {
  const pushRef = __testOnly.resolvePushRefForCheckoutRef({
    checkoutRef: "origin/hack/tickets",
    remoteRef: "refs/hack/tickets",
    legacyTrackingRef: "refs/remotes/origin/__legacy__/hack/tickets",
    legacyRemoteRef: "refs/heads/hack/tickets",
  });

  expect(pushRef).toBe("refs/hack/tickets");
});

test("resolveLocalCheckoutFallback blocks stale local fallback when fetch failure must be surfaced", () => {
  const result = __testOnly.resolveLocalCheckoutFallback({
    fetchFailure: "git fetch failed: origin unavailable",
    allowFetchFailureFallback: false,
    preferredTrackingRef: "refs/remotes/origin/__legacy__/hack/tickets",
    remoteRef: "refs/hack/tickets",
    legacyTrackingRef: "refs/remotes/origin/__legacy__/hack/tickets",
    legacyRemoteRef: "refs/heads/hack/tickets",
  });

  expect(result).toEqual({
    ok: false,
    error: "git fetch failed: origin unavailable",
  });
});

test("resolveLocalCheckoutFallback preserves the legacy push ref when local fallback is allowed", () => {
  const result = __testOnly.resolveLocalCheckoutFallback({
    fetchFailure: "git fetch failed: origin unavailable",
    allowFetchFailureFallback: true,
    preferredTrackingRef: "refs/remotes/origin/__legacy__/hack/tickets",
    remoteRef: "refs/hack/tickets",
    legacyTrackingRef: "refs/remotes/origin/__legacy__/hack/tickets",
    legacyRemoteRef: "refs/heads/hack/tickets",
  });

  expect(result).toEqual({
    ok: true,
    pushRef: "refs/heads/hack/tickets",
  });
});

test("resolveLegacyImportFetchResult surfaces non-missing legacy fetch failures", () => {
  const result = __testOnly.resolveLegacyImportFetchResult({
    missing: false,
    error: "fatal: remote transport failed",
  });

  expect(result).toEqual({
    ok: false,
    error: "git fetch failed: fatal: remote transport failed",
  });
});

test("resolveLegacyImportFetchResult ignores missing legacy refs", () => {
  const result = __testOnly.resolveLegacyImportFetchResult({
    missing: true,
    error: "fatal: couldn't find remote ref refs/heads/hack/tickets",
  });

  expect(result).toEqual({
    ok: true,
    imported: false,
  });
});
