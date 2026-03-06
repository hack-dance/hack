import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const linearConnections = pgTable("linear_connections", {
  id: uuid("id").defaultRandom().primaryKey(),
  connectionKey: text("connection_key").notNull().unique(),
  profileId: text("profile_id"),
  accountId: text("account_id"),
  accountName: text("account_name"),
  accountEmail: text("account_email"),
  authRef: text("auth_ref"),
  betterAuthUserId: text("better_auth_user_id"),
  organizationId: text("organization_id"),
  teamId: text("team_id"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const linearWebhookEvents = pgTable("linear_webhook_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  deliveryKey: text("delivery_key").notNull().unique(),
  profileId: text("profile_id"),
  projectId: text("project_id"),
  teamId: text("team_id"),
  issueId: text("issue_id"),
  issueIdentifier: text("issue_identifier"),
  eventType: text("event_type"),
  action: text("action"),
  status: text("status").notNull().default("pending"),
  payloadJson: text("payload_json").notNull().default("{}"),
  applyError: text("apply_error"),
  claimedBy: text("claimed_by"),
  betterAuthUserId: text("better_auth_user_id"),
  organizationId: text("organization_id"),
  ownerTeamId: text("owner_team_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
});
