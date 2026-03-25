import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    activeOrganizationId: text("active_organization_id"),
    activeTeamId: text("active_team_id"),
  },
  (table) => ({
    userIdIndex: index("session_user_id_idx").on(table.userId),
  })
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userIdIndex: index("account_user_id_idx").on(table.userId),
    providerAccountUnique: uniqueIndex("account_provider_account_idx").on(
      table.providerId,
      table.accountId
    ),
  })
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    identifierIndex: index("verification_identifier_idx").on(table.identifier),
  })
);

export const organization = pgTable(
  "organization",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    logo: text("logo"),
    metadata: text("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    slugIndex: uniqueIndex("organization_slug_idx").on(table.slug),
  })
);

export const member = pgTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    organizationIdIndex: index("member_organization_id_idx").on(
      table.organizationId
    ),
    userIdIndex: index("member_user_id_idx").on(table.userId),
    uniqueMembership: uniqueIndex("member_organization_user_idx").on(
      table.organizationId,
      table.userId
    ),
  })
);

export const invitation = pgTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    email: text("email").notNull(),
    role: text("role"),
    teamId: text("team_id"),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id),
  },
  (table) => ({
    organizationIdIndex: index("invitation_organization_id_idx").on(
      table.organizationId
    ),
    emailIndex: index("invitation_email_idx").on(table.email),
  })
);

export const team = pgTable(
  "team",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    organizationIdIndex: index("team_organization_id_idx").on(
      table.organizationId
    ),
  })
);

export const teamMember = pgTable(
  "team_member",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => team.id),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    teamIdIndex: index("team_member_team_id_idx").on(table.teamId),
    userIdIndex: index("team_member_user_id_idx").on(table.userId),
    uniqueMembership: uniqueIndex("team_member_team_user_idx").on(
      table.teamId,
      table.userId
    ),
  })
);

export const orgAdminOrganizations = pgTable(
  "org_admin_organizations",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    slugIndex: index("org_admin_organizations_slug_idx").on(table.slug),
  })
);

export const orgAdminTeams = pgTable(
  "org_admin_teams",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => orgAdminOrganizations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    organizationIdIndex: index("org_admin_teams_organization_id_idx").on(
      table.organizationId
    ),
    slugIndex: index("org_admin_teams_slug_idx").on(table.slug),
  })
);

export const orgAdminMemberships = pgTable(
  "org_admin_memberships",
  {
    id: text("id").primaryKey(),
    scope: text("scope").notNull(),
    state: text("state").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => orgAdminOrganizations.id, { onDelete: "cascade" }),
    teamId: text("team_id").references(() => orgAdminTeams.id, {
      onDelete: "cascade",
    }),
    userId: text("user_id"),
    email: text("email"),
    target: text("target").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    organizationIdIndex: index("org_admin_memberships_organization_id_idx").on(
      table.organizationId
    ),
    teamIdIndex: index("org_admin_memberships_team_id_idx").on(table.teamId),
    userIdIndex: index("org_admin_memberships_user_id_idx").on(table.userId),
    targetIndex: index("org_admin_memberships_target_idx").on(table.target),
    stateIndex: index("org_admin_memberships_state_idx").on(table.state),
  })
);

export const orgAdminInvitations = pgTable(
  "org_admin_invitations",
  {
    id: text("id").primaryKey(),
    scope: text("scope").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => orgAdminOrganizations.id, { onDelete: "cascade" }),
    teamId: text("team_id").references(() => orgAdminTeams.id, {
      onDelete: "cascade",
    }),
    email: text("email").notNull(),
    status: text("status").notNull().default("pending"),
    teamTargetsJson: text("team_targets_json").notNull().default("[]"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    organizationIdIndex: index("org_admin_invitations_organization_id_idx").on(
      table.organizationId
    ),
    teamIdIndex: index("org_admin_invitations_team_id_idx").on(table.teamId),
    emailIndex: index("org_admin_invitations_email_idx").on(table.email),
    statusIndex: index("org_admin_invitations_status_idx").on(table.status),
  })
);

export const projectAdminProjects = pgTable(
  "project_admin_projects",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    ownershipMode: text("ownership_mode").notNull(),
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id"),
    ownerSlug: text("owner_slug"),
    ownerName: text("owner_name"),
    managedBy: text("managed_by").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    createdByEmail: text("created_by_email"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    slugIndex: uniqueIndex("project_admin_projects_slug_idx").on(table.slug),
    ownerIdIndex: index("project_admin_projects_owner_id_idx").on(
      table.ownerId
    ),
    createdByUserIdIndex: index(
      "project_admin_projects_created_by_user_id_idx"
    ).on(table.createdByUserId),
  })
);

export const projectAdminAccessGrants = pgTable(
  "project_admin_access_grants",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projectAdminProjects.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    role: text("role").notNull(),
    subjectId: text("subject_id").notNull(),
    subjectSlug: text("subject_slug").notNull(),
    subjectName: text("subject_name").notNull(),
    organizationId: text("organization_id").notNull(),
    teamId: text("team_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    projectIdIndex: index("project_admin_access_grants_project_id_idx").on(
      table.projectId
    ),
    subjectIdIndex: index("project_admin_access_grants_subject_id_idx").on(
      table.subjectId
    ),
  })
);

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
  localAccessSealed: text("local_access_sealed"),
  localAccessUpdatedAt: timestamp("local_access_updated_at", {
    withTimezone: true,
  }),
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

export const betterAuthSchema = {
  user,
  session,
  account,
  verification,
  organization,
  member,
  invitation,
  team,
  teamMember,
} as const;

export const authBrokerSchema = {
  ...betterAuthSchema,
  orgAdminOrganizations,
  orgAdminTeams,
  orgAdminMemberships,
  orgAdminInvitations,
  projectAdminProjects,
  projectAdminAccessGrants,
  linearConnections,
  linearWebhookEvents,
  linearSyncSubscriptions,
} as const;
