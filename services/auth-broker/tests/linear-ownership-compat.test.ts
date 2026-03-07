import { expect, test } from "bun:test";

import {
  readStoredConnectionOwnership,
  toConnectionRecord,
} from "../src/modules/linear-connections/service.ts";
import {
  readStoredDeliveryOwnership,
  toWebhookDelivery,
} from "../src/modules/linear-sync-store/service.ts";

type LinearConnectionRow =
  typeof import("../src/db/schema.ts").linearConnections.$inferSelect;
type LinearWebhookDeliveryRow =
  typeof import("../src/db/schema.ts").linearWebhookEvents.$inferSelect;

test("toConnectionRecord prefers first-class ownership columns and strips legacy metadata keys", () => {
  const row: LinearConnectionRow = {
    id: "conn-1",
    connectionKey: "profile:work",
    profileId: "work",
    accountId: null,
    accountName: null,
    accountEmail: "linear@example.com",
    authRef: null,
    betterAuthUserId: "user-1",
    betterAuthOrganizationId: "org-column",
    betterAuthTeamId: "team-column",
    organizationId: "linear-org",
    teamId: "linear-team",
    localAccessSealed: null,
    localAccessUpdatedAt: null,
    metadataJson: JSON.stringify({
      _betterAuthOrganizationId: "org-legacy",
      _betterAuthTeamId: "team-legacy",
      organizationName: "Hack Dance",
    }),
    createdAt: new Date("2026-03-06T00:00:00.000Z"),
    updatedAt: new Date("2026-03-06T00:00:00.000Z"),
  };

  const record = toConnectionRecord({ row });
  expect(record.betterAuthOrganizationId).toBe("org-column");
  expect(record.betterAuthTeamId).toBe("team-column");
  expect(record.metadata).toEqual({ organizationName: "Hack Dance" });
});

test("toConnectionRecord falls back to legacy ownership metadata when structured columns are absent", () => {
  const row: LinearConnectionRow = {
    id: "conn-2",
    connectionKey: "profile:legacy",
    profileId: "legacy",
    accountId: null,
    accountName: null,
    accountEmail: null,
    authRef: null,
    betterAuthUserId: "user-2",
    betterAuthOrganizationId: null,
    betterAuthTeamId: null,
    organizationId: null,
    teamId: null,
    localAccessSealed: null,
    localAccessUpdatedAt: null,
    metadataJson: JSON.stringify({
      _betterAuthOrganizationId: "org-legacy",
      _betterAuthTeamId: "team-legacy",
    }),
    createdAt: new Date("2026-03-06T00:00:00.000Z"),
    updatedAt: new Date("2026-03-06T00:00:00.000Z"),
  };

  const record = toConnectionRecord({ row });
  expect(record.betterAuthOrganizationId).toBe("org-legacy");
  expect(record.betterAuthTeamId).toBe("team-legacy");
});

test("readStoredConnectionOwnership tolerates invalid JSON", () => {
  expect(readStoredConnectionOwnership({ raw: "{" })).toEqual({
    betterAuthOrganizationId: null,
    betterAuthTeamId: null,
  });
});

test("toWebhookDelivery prefers first-class ownership columns and falls back to legacy payload keys", () => {
  const row: LinearWebhookDeliveryRow = {
    id: "delivery-1",
    deliveryKey: "key-1",
    profileId: "work",
    projectId: "project-1",
    teamId: "linear-team",
    issueId: "issue-1",
    issueIdentifier: "HACK-1",
    eventType: "Issue",
    action: "update",
    status: "pending",
    payloadJson: JSON.stringify({
      path: "/linear/webhooks",
      rawBody: "{}",
      payload: { type: "Issue" },
      signatureVerified: true,
      webhookTimestamp: "2026-03-06T00:00:00.000Z",
      _betterAuthOrganizationId: "org-legacy",
      _betterAuthTeamId: "team-legacy",
    }),
    applyError: null,
    claimedBy: null,
    betterAuthUserId: "user-1",
    betterAuthOrganizationId: "org-column",
    betterAuthTeamId: "team-column",
    organizationId: "linear-org",
    ownerTeamId: "linear-team",
    createdAt: new Date("2026-03-06T00:00:00.000Z"),
    updatedAt: new Date("2026-03-06T00:00:00.000Z"),
    appliedAt: null,
  };

  const delivery = toWebhookDelivery({ row });
  expect(delivery.betterAuthOrganizationId).toBe("org-column");
  expect(delivery.betterAuthTeamId).toBe("team-column");
});

test("toWebhookDelivery falls back to legacy payload ownership keys when structured columns are absent", () => {
  const row: LinearWebhookDeliveryRow = {
    id: "delivery-2",
    deliveryKey: "key-2",
    profileId: null,
    projectId: null,
    teamId: null,
    issueId: null,
    issueIdentifier: null,
    eventType: "Issue",
    action: "create",
    status: "pending",
    payloadJson: JSON.stringify({
      path: "/linear/webhooks",
      rawBody: "{}",
      payload: { type: "Issue" },
      signatureVerified: true,
      webhookTimestamp: "2026-03-06T00:00:00.000Z",
      _betterAuthOrganizationId: "org-legacy",
      _betterAuthTeamId: "team-legacy",
    }),
    applyError: null,
    claimedBy: null,
    betterAuthUserId: "user-2",
    betterAuthOrganizationId: null,
    betterAuthTeamId: null,
    organizationId: null,
    ownerTeamId: null,
    createdAt: new Date("2026-03-06T00:00:00.000Z"),
    updatedAt: new Date("2026-03-06T00:00:00.000Z"),
    appliedAt: null,
  };

  const delivery = toWebhookDelivery({ row });
  expect(delivery.betterAuthOrganizationId).toBe("org-legacy");
  expect(delivery.betterAuthTeamId).toBe("team-legacy");
});

test("readStoredDeliveryOwnership tolerates invalid JSON", () => {
  expect(readStoredDeliveryOwnership({ payloadJson: "{" })).toEqual({
    betterAuthOrganizationId: null,
    betterAuthTeamId: null,
  });
});
