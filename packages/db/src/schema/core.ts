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
