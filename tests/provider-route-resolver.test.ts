import { expect, test } from "bun:test";

import { resolveDispatchRoute } from "../src/control-plane/routing/resolver.ts";
import {
  type ControlPlaneConfig,
  createDefaultControlPlaneConfig,
} from "../src/control-plane/sdk/config.ts";

test("route resolver prefers explicit command node over project node affinity", () => {
  const config = withControlPlaneOverrides({
    nodeId: "project-node",
  });
  const resolved = resolveDispatchRoute({
    config,
    commandNode: "cli-node",
  });
  expect(resolved.nodeDirective?.source).toBe("command_flags");
  expect(resolved.nodeDirective?.nodeId).toBe("cli-node");
});

test("route resolver falls back to project node affinity when command node is unset", () => {
  const config = withControlPlaneOverrides({
    nodeId: "project-node",
  });
  const resolved = resolveDispatchRoute({ config });
  expect(resolved.nodeDirective?.source).toBe("controlPlane.nodeId");
  expect(resolved.nodeDirective?.nodeId).toBe("project-node");
});

test("route resolver applies command profile precedence and warns on provider mismatch", () => {
  const config = withControlPlaneOverrides({
    providers: {
      profiles: {
        "railway/default": {
          provider: "railway",
          enabled: true,
          config: {
            project: "node-runtime",
          },
        },
      },
    },
  });
  const resolved = resolveDispatchRoute({
    config,
    commandProvider: "aws",
    commandProfile: "railway/default",
  });
  expect(resolved.providerRoute.provider).toBe("railway");
  expect(resolved.providerRoute.providerSource).toBe("command_flags");
  expect(
    resolved.diagnostics.some(
      (entry) => entry.code === "provider_profile_mismatch"
    )
  ).toBe(true);
});

test("route resolver uses global default provider when no project/command route exists", () => {
  const config = withControlPlaneOverrides({
    providers: {
      defaultProvider: "aws",
    },
  });
  const resolved = resolveDispatchRoute({ config });
  expect(resolved.providerRoute.provider).toBe("aws");
  expect(resolved.providerRoute.providerSource).toBe("global_defaults");
});

test("route resolver uses provider hard default when no provider selection is configured", () => {
  const config = createDefaultControlPlaneConfig();
  const resolved = resolveDispatchRoute({ config });
  expect(resolved.providerRoute.provider).toBe("railway");
  expect(resolved.providerRoute.providerSource).toBe("provider_hard_default");
});

test("route resolver returns typed diagnostic for missing provider profile", () => {
  const config = withControlPlaneOverrides({
    routing: {
      profile: "railway/missing",
    },
  });
  const resolved = resolveDispatchRoute({ config });
  expect(resolved.hasErrors).toBe(true);
  expect(
    resolved.diagnostics.some((entry) => entry.code === "profile_not_found")
  ).toBe(true);
});

test("route resolver returns typed diagnostic when provider extension is disabled", () => {
  const config = withControlPlaneOverrides({
    providers: {
      defaultProvider: "railway",
    },
    extensions: {
      "dance.hack.railway": {
        enabled: false,
        config: {},
      },
    },
  });
  const resolved = resolveDispatchRoute({ config });
  expect(resolved.hasErrors).toBe(true);
  expect(
    resolved.diagnostics.some((entry) => entry.code === "provider_disabled")
  ).toBe(true);
});

test("route resolver validates railway private mode auth source", () => {
  const withoutAuth = withControlPlaneOverrides({
    providers: {
      profiles: {
        "railway/private": {
          provider: "railway",
          enabled: true,
          config: {
            project: "hack-runtime",
            privateNetworking: true,
          },
        },
      },
    },
    routing: {
      profile: "railway/private",
    },
  });
  const unresolved = resolveDispatchRoute({ config: withoutAuth });
  expect(unresolved.hasErrors).toBe(true);
  expect(
    unresolved.diagnostics.some((entry) => entry.code === "missing_auth_source")
  ).toBe(true);

  const withAuthKey = withControlPlaneOverrides({
    providers: {
      profiles: {
        "railway/private": {
          provider: "railway",
          enabled: true,
          config: {
            project: "hack-runtime",
            privateNetworking: true,
            tailscaleAuthKey: "tskey-auth-test",
          },
        },
      },
    },
    routing: {
      profile: "railway/private",
    },
  });
  const resolved = resolveDispatchRoute({ config: withAuthKey });
  expect(resolved.hasErrors).toBe(false);
});

test("route resolver enables guarded bootstrap only for bootstrap-capable modes", () => {
  const existingOnly = withControlPlaneOverrides({
    routing: {
      mode: "existing_only",
      bootstrap: {
        enabled: true,
        setAsProjectNode: true,
      },
    },
  });
  const existingResolved = resolveDispatchRoute({
    config: existingOnly,
    commandBootstrapIfNeeded: true,
  });
  expect(existingResolved.providerRoute.bootstrapEnabled).toBe(false);

  const preferExisting = withControlPlaneOverrides({
    routing: {
      mode: "prefer_existing_then_bootstrap",
      bootstrap: {
        enabled: true,
        setAsProjectNode: true,
      },
    },
  });
  const preferResolved = resolveDispatchRoute({ config: preferExisting });
  expect(preferResolved.providerRoute.bootstrapEnabled).toBe(true);
  expect(preferResolved.providerRoute.setAsProjectNode).toBe(true);

  const bootstrapOnly = withControlPlaneOverrides({
    routing: {
      mode: "bootstrap_only",
      bootstrap: {
        enabled: false,
      },
    },
  });
  const bootstrapResolved = resolveDispatchRoute({ config: bootstrapOnly });
  expect(bootstrapResolved.providerRoute.bootstrapEnabled).toBe(true);
});

function withControlPlaneOverrides(
  overrides: Record<string, unknown>
): ControlPlaneConfig {
  const base = createDefaultControlPlaneConfig() as unknown as Record<
    string,
    unknown
  >;
  const merged = mergeRecords({
    base,
    override: overrides,
  });
  return merged as ControlPlaneConfig;
}

function mergeRecords(input: {
  readonly base: Record<string, unknown>;
  readonly override: Record<string, unknown>;
}): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input.base };
  for (const [key, value] of Object.entries(input.override)) {
    if (value === undefined) {
      continue;
    }
    const existing = out[key];
    if (isObject(existing) && isObject(value)) {
      out[key] = mergeRecords({
        base: existing,
        override: value,
      });
      continue;
    }
    out[key] = value;
  }
  return out;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
