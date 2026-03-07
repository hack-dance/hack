import { t, type UnwrapSchema } from "elysia";

/**
 * Shared request models for GitHub OAuth routes.
 */
export const GitHubOAuthModel = {
  flowStatusQuery: t.Object({
    deviceCode: t.String(),
    claim: t.Optional(t.String()),
    requireInstallation: t.Optional(t.String()),
  }),
  startQuery: t.Object({
    profile: t.Optional(t.String()),
    setDefault: t.Optional(t.String()),
    redirect: t.Optional(t.String()),
    requireInstallation: t.Optional(t.String()),
    desktopRedirectUrl: t.Optional(t.String()),
  }),
  callbackQuery: t.Object({
    code: t.Optional(t.String()),
    state: t.Optional(t.String()),
    error: t.Optional(t.String()),
    error_description: t.Optional(t.String()),
    installation_id: t.Optional(t.String()),
    setup_action: t.Optional(t.String()),
  }),
  flowStatusParams: t.Object({
    flowId: t.String(),
  }),
} as const;

/**
 * Optional schema-to-static mapping for service/controller boundaries.
 */
export type GitHubOAuthModel = {
  readonly [K in keyof typeof GitHubOAuthModel]: UnwrapSchema<
    (typeof GitHubOAuthModel)[K]
  >;
};
