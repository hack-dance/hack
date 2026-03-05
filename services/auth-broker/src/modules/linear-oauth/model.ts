import { t, type UnwrapSchema } from "elysia";

export const LinearOAuthModel = {
  flowStatusQuery: t.Object({
    deviceCode: t.String(),
    claim: t.Optional(t.String()),
  }),
  startQuery: t.Object({
    profile: t.Optional(t.String()),
    setDefault: t.Optional(t.String()),
    redirect: t.Optional(t.String()),
  }),
  callbackQuery: t.Object({
    code: t.Optional(t.String()),
    state: t.Optional(t.String()),
    error: t.Optional(t.String()),
    error_description: t.Optional(t.String()),
  }),
  refreshBody: t.Object({
    refreshToken: t.String(),
  }),
  flowStatusParams: t.Object({
    flowId: t.String(),
  }),
} as const;

export type LinearOAuthModel = {
  readonly [K in keyof typeof LinearOAuthModel]: UnwrapSchema<
    (typeof LinearOAuthModel)[K]
  >;
};
