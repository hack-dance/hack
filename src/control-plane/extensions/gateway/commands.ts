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
    handler: async ({ args }) => {
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

function parseTokenCreateArgs(opts: {
  readonly args: readonly string[];
}): TokenCreateParseResult {
  let label: string | undefined;
  let scope: GatewayTokenScope = "read";

  const takeValue = (
    _token: string,
    value: string | undefined
  ): string | null => {
    if (!value || value.startsWith("-")) {
      return null;
    }
    return value;
  };

  for (let i = 0; i < opts.args.length; i += 1) {
    const token = opts.args[i] ?? "";
    if (token === "--") {
      const rest = opts.args.slice(i + 1);
      if (rest.length > 0 && !label) {
        label = normalizeLabel(rest[0] ?? "");
      }
      break;
    }

    if (token === "--write") {
      scope = "write";
      continue;
    }

    if (token.startsWith("--scope=")) {
      const value = token.slice("--scope=".length).trim();
      const parsed = parseScope(value);
      if (!parsed) {
        return { ok: false, error: "Invalid --scope (use read|write)." };
      }
      scope = parsed;
      continue;
    }

    if (token === "--scope") {
      const value = takeValue(token, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--scope requires a value." };
      }
      const parsed = parseScope(value);
      if (!parsed) {
        return { ok: false, error: "Invalid --scope (use read|write)." };
      }
      scope = parsed;
      i += 1;
      continue;
    }

    if (token.startsWith("--label=")) {
      label = normalizeLabel(token.slice("--label=".length));
      continue;
    }

    if (token === "--label") {
      const value = takeValue(token, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--label requires a value." };
      }
      label = normalizeLabel(value);
      i += 1;
      continue;
    }

    if (token.startsWith("-")) {
      return { ok: false, error: `Unknown option: ${token}` };
    }

    if (!label) {
      label = normalizeLabel(token);
      continue;
    }

    return { ok: false, error: `Unexpected argument: ${token}` };
  }

  return {
    ok: true,
    value: {
      ...(label ? { label } : {}),
      scope,
    },
  };
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
