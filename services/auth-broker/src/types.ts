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
  readonly installationIds: readonly string[];
};

export type GitHubOAuthFlow = {
  readonly id: string;
  readonly state: string;
  readonly profileId: string;
  readonly setDefault: boolean;
  readonly deviceCodeHash: string;
  readonly authorizeUrl: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly redirectUri: string;
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
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly completedAt?: string;
  readonly claimedAt?: string;
  readonly accountLogin?: string;
  readonly accountName?: string;
  readonly accountId?: string;
  readonly installationIds?: readonly string[];
  readonly token?: string;
  readonly tokenExpiresAt?: string;
  readonly error?: string;
};
