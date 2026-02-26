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

      if (parsed.value.json) {
        process.stdout.write(
          `${JSON.stringify({ token: issued.token, record: issued.record }, null, 2)}\n`
        );
        return 0;
      }

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
    handler: async ({ ctx, args }) => {
      const parsed = parseTokenListArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }
      const paths = resolveDaemonPaths({});
      const tokens = await listGatewayTokens({ rootDir: paths.root });

      if (parsed.value.json) {
        process.stdout.write(`${JSON.stringify({ tokens }, null, 2)}\n`);
        return 0;
      }

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
      const parsed = parseTokenRevokeArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const paths = resolveDaemonPaths({});
      const revoked = await revokeGatewayToken({
        rootDir: paths.root,
        tokenId: parsed.value.tokenId,
      });
      if (parsed.value.json) {
        process.stdout.write(
          `${JSON.stringify({ id: parsed.value.tokenId, revoked }, null, 2)}\n`
        );
        return revoked ? 0 : 1;
      }
      if (!revoked) {
        ctx.logger.warn({
          message: `Token not found or already revoked: ${parsed.value.tokenId}`,
        });
        return 1;
      }

      ctx.logger.success({ message: `Revoked token ${parsed.value.tokenId}` });
      return 0;
    },
  },
];

type TokenCreateArgs = {
  readonly label?: string;
  readonly scope: GatewayTokenScope;
  readonly json: boolean;
};

type TokenListArgs = {
  readonly json: boolean;
};

type TokenListParseResult =
  | { readonly ok: true; readonly value: TokenListArgs }
  | { readonly ok: false; readonly error: string };

type TokenRevokeArgs = {
  readonly tokenId: string;
  readonly json: boolean;
};

type TokenRevokeParseResult =
  | { readonly ok: true; readonly value: TokenRevokeArgs }
  | { readonly ok: false; readonly error: string };

type TokenCreateParseResult =
  | { readonly ok: true; readonly value: TokenCreateArgs }
  | { readonly ok: false; readonly error: string };

type TokenCreateParseState = {
  label?: string;
  scope: GatewayTokenScope;
  json: boolean;
};

function takeArgValue(input: {
  readonly value: string | undefined;
}): string | null {
  if (!input.value || input.value.startsWith("-")) {
    return null;
  }
  return input.value;
}

function applyTokenCreateOption(input: {
  readonly token: string;
  readonly nextValue: string | undefined;
  readonly state: TokenCreateParseState;
}):
  | { readonly ok: true; readonly consumed: 0 | 1 }
  | { readonly ok: false; readonly error: string } {
  if (input.token === "--write") {
    input.state.scope = "write";
    return { ok: true, consumed: 0 };
  }
  if (input.token === "--json") {
    input.state.json = true;
    return { ok: true, consumed: 0 };
  }
  if (input.token.startsWith("--scope=")) {
    const parsedScope = parseScope(input.token.slice("--scope=".length).trim());
    if (!parsedScope) {
      return { ok: false, error: "Invalid --scope (use read|write)." };
    }
    input.state.scope = parsedScope;
    return { ok: true, consumed: 0 };
  }
  if (input.token === "--scope") {
    const value = takeArgValue({ value: input.nextValue });
    if (!value) {
      return { ok: false, error: "--scope requires a value." };
    }
    const parsedScope = parseScope(value);
    if (!parsedScope) {
      return { ok: false, error: "Invalid --scope (use read|write)." };
    }
    input.state.scope = parsedScope;
    return { ok: true, consumed: 1 };
  }
  if (input.token.startsWith("--label=")) {
    input.state.label = normalizeLabel(input.token.slice("--label=".length));
    return { ok: true, consumed: 0 };
  }
  if (input.token === "--label") {
    const value = takeArgValue({ value: input.nextValue });
    if (!value) {
      return { ok: false, error: "--label requires a value." };
    }
    input.state.label = normalizeLabel(value);
    return { ok: true, consumed: 1 };
  }
  return { ok: false, error: `Unknown option: ${input.token}` };
}

function parseTokenCreateArgs(opts: {
  readonly args: readonly string[];
}): TokenCreateParseResult {
  const state: TokenCreateParseState = {
    scope: "read",
    json: false,
  };

  for (let i = 0; i < opts.args.length; i += 1) {
    const token = opts.args[i] ?? "";
    if (token === "--") {
      const rest = opts.args.slice(i + 1);
      if (rest.length > 0 && !state.label) {
        state.label = normalizeLabel(rest[0] ?? "");
      }
      break;
    }
    if (token.startsWith("-")) {
      const parsedOption = applyTokenCreateOption({
        token,
        nextValue: opts.args[i + 1],
        state,
      });
      if (!parsedOption.ok) {
        return { ok: false, error: parsedOption.error };
      }
      i += parsedOption.consumed;
      continue;
    }
    if (!state.label) {
      state.label = normalizeLabel(token);
      continue;
    }
    return { ok: false, error: `Unexpected argument: ${token}` };
  }

  return {
    ok: true,
    value: {
      ...(state.label ? { label: state.label } : {}),
      scope: state.scope,
      json: state.json,
    },
  };
}

function parseTokenListArgs(opts: {
  readonly args: readonly string[];
}): TokenListParseResult {
  let json = false;
  for (const token of opts.args) {
    if (token === "--json") {
      json = true;
      continue;
    }
    return { ok: false, error: `Unknown option: ${token}` };
  }
  return { ok: true, value: { json } };
}

function parseTokenRevokeArgs(opts: {
  readonly args: readonly string[];
}): TokenRevokeParseResult {
  let tokenId: string | null = null;
  let json = false;

  for (const token of opts.args) {
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token.startsWith("-")) {
      return { ok: false, error: `Unknown option: ${token}` };
    }
    if (!tokenId) {
      tokenId = token.trim();
      continue;
    }
    return { ok: false, error: `Unexpected argument: ${token}` };
  }

  if (!tokenId) {
    return {
      ok: false,
      error: "Usage: hack x gateway token-revoke <token-id> [--json]",
    };
  }

  return {
    ok: true,
    value: {
      tokenId,
      json,
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
