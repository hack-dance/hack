import { expect, test } from "bun:test";

import { __testOnly } from "../src/control-plane/extensions/tickets/tickets-git-channel.ts";

test("mergeTicketEventLogs dedupes by event id and preserves chronological order", () => {
  const merged = __testOnly.mergeTicketEventLogs({
    existing: [
      JSON.stringify({
        eventId: "event-2",
        ts: 2,
        ticketId: "T-00002",
        type: "ticket.created",
      }),
      JSON.stringify({
        eventId: "event-3",
        ts: 3,
        ticketId: "T-00003",
        type: "ticket.created",
      }),
      "",
    ].join("\n"),
    incoming: [
      JSON.stringify({
        eventId: "event-1",
        ts: 1,
        ticketId: "T-00001",
        type: "ticket.created",
      }),
      JSON.stringify({
        eventId: "event-2",
        ts: 2,
        ticketId: "T-00002",
        type: "ticket.created",
      }),
      "",
    ].join("\n"),
  });

  const lines = merged
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as { readonly eventId: string; readonly ts: number }
    );

  expect(lines.map((line) => line.eventId)).toEqual([
    "event-1",
    "event-2",
    "event-3",
  ]);
  expect(lines.map((line) => line.ts)).toEqual([1, 2, 3]);
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
