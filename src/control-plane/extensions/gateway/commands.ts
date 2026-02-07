import { resolveDaemonPaths } from "../../../daemon/paths.ts";
import { display } from "../../../ui/display.ts";
import type { ExtensionCommand } from "../types.ts";
import type { GatewayTokenScope } from "./tokens.ts";
import {
  createGatewayToken,
  listGatewayTokens,
  revokeGatewayToken,
} from "./tokens.ts";

export const GATEWAY_COMMANDS: readonly ExtensionCommand[] = [
  {
    name: "token-create",
    summary: "Create a gateway token",
    scope: "global",
    handler: async ({ ctx, args }) => {
      const parsed = parseTokenCreateArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }
      const { label, scope } = parsed.value;
      const paths = resolveDaemonPaths({});
      const issued = await createGatewayToken({
        rootDir: paths.root,
        ...(label ? { label } : {}),
        scope,
      });

      await display.kv({
        title: "Gateway token",
        entries: [
          ["id", issued.record.id],
          ["label", issued.record.label ?? ""],
          ["scope", issued.record.scope],
          ["created_at", issued.record.createdAt],
          ["token", issued.token],
        ],
      });

      ctx.logger.info({
        message: "Store this token securely; it cannot be recovered once lost.",
      });
      return 0;
    },
  },
  {
    name: "token-list",
    summary: "List gateway tokens",
    scope: "global",
    handler: async ({ args: _args }) => {
      const paths = resolveDaemonPaths({});
      const tokens = await listGatewayTokens({ rootDir: paths.root });

      if (tokens.length === 0) {
        await display.panel({
          title: "Gateway tokens",
          tone: "info",
          lines: ["No tokens found."],
        });
        return 0;
      }

      await display.table({
        columns: ["Id", "Scope", "Label", "Created", "Last Used", "Revoked"],
        rows: tokens.map((token) => [
          token.id,
          token.scope,
          token.label ?? "",
          token.createdAt,
          token.lastUsedAt ?? "",
          token.revokedAt ?? "",
        ]),
      });
      return 0;
    },
  },
  {
    name: "token-revoke",
    summary: "Revoke a gateway token by id",
    scope: "global",
    handler: async ({ ctx, args }) => {
      const tokenId = (args[0] ?? "").trim();
      if (!tokenId) {
        ctx.logger.error({
          message: "Usage: hack x gateway token-revoke <token-id>",
        });
        return 1;
      }

      const paths = resolveDaemonPaths({});
      const revoked = await revokeGatewayToken({
        rootDir: paths.root,
        tokenId,
      });
      if (!revoked) {
        ctx.logger.warn({
          message: `Token not found or already revoked: ${tokenId}`,
        });
        return 1;
      }

      ctx.logger.success({ message: `Revoked token ${tokenId}` });
      return 0;
    },
  },
];

type TokenCreateArgs = {
  readonly label?: string;
  readonly scope: GatewayTokenScope;
};

type TokenCreateParseResult =
  | { readonly ok: true; readonly value: TokenCreateArgs }
  | { readonly ok: false; readonly error: string };

type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

function parseTokenCreateArgs(opts: {
  readonly args: readonly string[];
}): TokenCreateParseResult {
  const state: { label?: string; scope: GatewayTokenScope } = { scope: "read" };

  for (let i = 0; i < opts.args.length; i += 1) {
    const token = opts.args[i] ?? "";

    if (token === "--") {
      const rest = opts.args.slice(i + 1);
      if (rest.length > 0 && !state.label) {
        state.label = normalizeLabel(rest[0] ?? "");
      }
      break;
    }

    const parsed = parseTokenCreateToken({
      token,
      next: opts.args[i + 1],
      state,
    });
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }

    state.label = parsed.value.state.label;
    state.scope = parsed.value.state.scope;
    i += parsed.value.consume;
  }

  return {
    ok: true,
    value: {
      ...(state.label ? { label: state.label } : {}),
      scope: state.scope,
    },
  };
}

type TokenCreateState = {
  readonly label?: string;
  readonly scope: GatewayTokenScope;
};

function parseTokenCreateToken(opts: {
  readonly token: string;
  readonly next: string | undefined;
  readonly state: TokenCreateState;
}): ParseResult<{
  readonly state: TokenCreateState;
  readonly consume: number;
}> {
  if (opts.token === "--write") {
    return {
      ok: true,
      value: { state: { ...opts.state, scope: "write" }, consume: 0 },
    };
  }

  const scopeInline = parseInlineFlag({ token: opts.token, name: "--scope" });
  if (scopeInline) {
    const scope = parseScope(scopeInline);
    if (!scope) {
      return { ok: false, error: "Invalid --scope (use read|write)." };
    }
    return { ok: true, value: { state: { ...opts.state, scope }, consume: 0 } };
  }

  if (opts.token === "--scope") {
    const scopeValue = takeFlagValue({ token: opts.token, value: opts.next });
    if (!scopeValue) {
      return { ok: false, error: "--scope requires a value." };
    }
    const scope = parseScope(scopeValue);
    if (!scope) {
      return { ok: false, error: "Invalid --scope (use read|write)." };
    }
    return { ok: true, value: { state: { ...opts.state, scope }, consume: 1 } };
  }

  const labelInline = parseInlineFlag({ token: opts.token, name: "--label" });
  if (labelInline !== null) {
    return {
      ok: true,
      value: {
        state: { ...opts.state, label: normalizeLabel(labelInline) },
        consume: 0,
      },
    };
  }

  if (opts.token === "--label") {
    const labelValue = takeFlagValue({ token: opts.token, value: opts.next });
    if (!labelValue) {
      return { ok: false, error: "--label requires a value." };
    }
    return {
      ok: true,
      value: {
        state: { ...opts.state, label: normalizeLabel(labelValue) },
        consume: 1,
      },
    };
  }

  if (opts.token.startsWith("-")) {
    return { ok: false, error: `Unknown option: ${opts.token}` };
  }

  if (!opts.state.label) {
    return {
      ok: true,
      value: {
        state: { ...opts.state, label: normalizeLabel(opts.token) },
        consume: 0,
      },
    };
  }

  return { ok: false, error: `Unexpected argument: ${opts.token}` };
}

function parseInlineFlag(opts: {
  readonly token: string;
  readonly name: string;
}): string | null {
  const prefix = `${opts.name}=`;
  if (!opts.token.startsWith(prefix)) {
    return null;
  }
  return opts.token.slice(prefix.length).trim();
}

function takeFlagValue(opts: {
  readonly token: string;
  readonly value: string | undefined;
}): string | null {
  if (!opts.value || opts.value.startsWith("-")) {
    return null;
  }
  return opts.value;
}

function parseScope(value: string): GatewayTokenScope | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "read") {
    return "read";
  }
  if (normalized === "write") {
    return "write";
  }
  return null;
}

function normalizeLabel(value: string): string | undefined {
  const raw = value.trim();
  return raw.length > 0 ? raw : undefined;
}
