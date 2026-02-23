export type FlowStatus =
  | "pending"
  | "complete"
  | "error"
  | "expired"
  | "claimed";

export type GitHubFlowAccount = {
  readonly login: string;
  readonly accountName?: string;
  readonly accountId?: string;
  readonly accountEmail?: string;
  readonly installationIds: readonly string[];
  readonly betterAuthUserId?: string;
  readonly betterAuthLinkState?:
    | "disabled"
    | "missing_email"
    | "linked_existing"
    | "created_new"
    | "not_linked"
    | "error";
};

export type GitHubOAuthFlow = {
  readonly id: string;
  readonly state: string;
  readonly profileId: string;
  readonly setDefault: boolean;
  readonly deviceCodeHash: string;
  readonly authorizeUrl: string;
  readonly appId?: string;
  readonly appSlug?: string;
  readonly appInstallUrl?: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly redirectUri: string;
  installationId?: string;
  status: FlowStatus;
  account?: GitHubFlowAccount;
  token?: string;
  tokenExpiresAt?: string;
  error?: string;
  completedAt?: string;
  claimedAt?: string;
};

export type GitHubFlowPublicStatus = {
  readonly id: string;
  readonly status: FlowStatus;
  readonly profileId: string;
  readonly setDefault: boolean;
  readonly appId?: string;
  readonly appSlug?: string;
  readonly appInstallUrl?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly completedAt?: string;
  readonly claimedAt?: string;
  readonly accountLogin?: string;
  readonly accountName?: string;
  readonly accountId?: string;
  readonly accountEmail?: string;
  readonly betterAuthUserId?: string;
  readonly betterAuthLinkState?:
    | "disabled"
    | "missing_email"
    | "linked_existing"
    | "created_new"
    | "not_linked"
    | "error";
  readonly installationId?: string;
  readonly installationIds?: readonly string[];
  readonly token?: string;
  readonly tokenExpiresAt?: string;
  readonly error?: string;
};
