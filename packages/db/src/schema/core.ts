import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Remote nodes known by the control-plane.
 */
export const remoteNodes = pgTable("remote_nodes", {
  id: uuid("id").defaultRandom().primaryKey(),
  nodeId: text("node_id").notNull().unique(),
  name: text("name").notNull(),
  endpoint: text("endpoint").notNull(),
  status: text("status").notNull().default("unknown"),
  labelsJson: text("labels_json").notNull().default("[]"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Dispatched runs for audit and artifact linkage.
 */
export const dispatchRuns = pgTable("dispatch_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: text("run_id").notNull().unique(),
  nodeId: text("node_id").notNull(),
  projectId: text("project_id").notNull(),
  branch: text("branch"),
  status: text("status").notNull().default("queued"),
  summaryJson: text("summary_json").notNull().default("{}"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

/**
 * GitHub account connections for profile routing in dispatch/PR automation.
 */
export const githubConnections = pgTable("github_connections", {
  id: uuid("id").defaultRandom().primaryKey(),
  profileId: text("profile_id").notNull().unique(),
  accountLogin: text("account_login").notNull(),
  installationIdsJson: text("installation_ids_json").notNull().default("[]"),
  authRef: text("auth_ref").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Durable Linear connection ownership records for future access control,
 * routing diagnostics, and usage attribution.
 */
export const linearConnections = pgTable("linear_connections", {
  id: uuid("id").defaultRandom().primaryKey(),
  connectionKey: text("connection_key").notNull().unique(),
  profileId: text("profile_id"),
  accountId: text("account_id"),
  accountName: text("account_name"),
  accountEmail: text("account_email"),
  authRef: text("auth_ref"),
  betterAuthUserId: text("better_auth_user_id"),
  betterAuthOrganizationId: text("better_auth_organization_id"),
  betterAuthTeamId: text("better_auth_team_id"),
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

/**
 * Explicit local-user <-> Linear-user mappings used during assignee sync.
 */
export const linearAssigneeMappings = pgTable("linear_assignee_mappings", {
  id: uuid("id").defaultRandom().primaryKey(),
  mappingKey: text("mapping_key").notNull().unique(),
  profileId: text("profile_id").notNull(),
  linearTeamId: text("linear_team_id"),
  localAssignee: text("local_assignee").notNull(),
  linearUserId: text("linear_user_id"),
  linearUserName: text("linear_user_name"),
  linearUserEmail: text("linear_user_email"),
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

/**
 * Verified Linear webhook deliveries waiting to be applied by a local client.
 */
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
  betterAuthOrganizationId: text("better_auth_organization_id"),
  betterAuthTeamId: text("better_auth_team_id"),
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

/**
 * Future opt-in autosync subscriptions keyed by connection/project/team scope.
 */
export const linearSyncSubscriptions = pgTable("linear_sync_subscriptions", {
  id: uuid("id").defaultRandom().primaryKey(),
  subscriptionKey: text("subscription_key").notNull().unique(),
  profileId: text("profile_id").notNull(),
  projectId: text("project_id"),
  teamId: text("team_id"),
  mode: text("mode").notNull().default("manual"),
  status: text("status").notNull().default("active"),
  betterAuthUserId: text("better_auth_user_id"),
  betterAuthOrganizationId: text("better_auth_organization_id"),
  betterAuthTeamId: text("better_auth_team_id"),
  configJson: text("config_json").notNull().default("{}"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
