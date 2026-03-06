export type FlowStatus =
  | "pending"
  | "complete"
  | "error"
  | "expired"
  | "claimed";

export type OAuthProvider = "github" | "linear" | "session";

export type OAuthFlowAccount = {
  readonly login?: string;
  readonly accountHandle?: string;
  readonly accountName?: string;
  readonly accountId?: string;
  readonly accountEmail?: string;
  readonly accountEmailVerified?: boolean;
  readonly organizationId?: string;
  readonly organizationName?: string;
  readonly teamIds?: readonly string[];
  readonly installationIds?: readonly string[];
  readonly betterAuthUserId?: string;
  readonly betterAuthLinkState?:
    | "disabled"
    | "email_not_verified"
    | "missing_email"
    | "linked_existing"
    | "created_new"
    | "not_linked"
    | "error";
};

export type OAuthFlow = {
  readonly id: string;
  readonly provider: OAuthProvider;
  readonly state: string;
  readonly profileId: string;
  readonly setDefault: boolean;
  readonly deviceCodeHash: string;
  readonly authorizeUrl: string;
  readonly codeVerifier?: string;
  readonly appId?: string;
  readonly appSlug?: string;
  readonly appInstallUrl?: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly redirectUri: string;
  installationId?: string;
  status: FlowStatus;
  account?: OAuthFlowAccount;
  token?: string;
  tokenExpiresAt?: string;
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
  managementToken?: string;
  managementTokenExpiresAt?: string;
  error?: string;
  completedAt?: string;
  claimedAt?: string;
};

export type OAuthFlowPublicStatus = {
  readonly id: string;
  readonly provider: OAuthProvider;
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
  readonly accountHandle?: string;
  readonly accountLogin?: string;
  readonly accountName?: string;
  readonly accountId?: string;
  readonly accountEmail?: string;
  readonly accountEmailVerified?: boolean;
  readonly organizationId?: string;
  readonly organizationName?: string;
  readonly teamIds?: readonly string[];
  readonly betterAuthUserId?: string;
  readonly betterAuthLinkState?:
    | "disabled"
    | "email_not_verified"
    | "missing_email"
    | "linked_existing"
    | "created_new"
    | "not_linked"
    | "error";
  readonly installationId?: string;
  readonly installationIds?: readonly string[];
  readonly token?: string;
  readonly tokenExpiresAt?: string;
  readonly refreshToken?: string;
  readonly refreshTokenExpiresAt?: string;
  readonly managementToken?: string;
  readonly managementTokenExpiresAt?: string;
  readonly error?: string;
};

export type GitHubFlowAccount = OAuthFlowAccount;
export type GitHubOAuthFlow = OAuthFlow;
export type GitHubFlowPublicStatus = OAuthFlowPublicStatus;
