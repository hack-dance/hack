import { describe, expect, test } from "bun:test";

import type { BetterAuthRuntime } from "../src/better-auth.ts";
import {
  resolveBetterAuthUserFromGitHubAccount,
  resolveBetterAuthUserFromLinearAccount,
} from "../src/better-auth-link.ts";

type BetterAuthDb = NonNullable<BetterAuthRuntime["db"]>;

function createBetterAuthDb(
  rows: readonly Record<string, unknown>[]
): BetterAuthDb {
  const execute = (async () => ({
    rows: [...rows],
  })) as unknown as BetterAuthDb["execute"];
  return { execute } as unknown as BetterAuthDb;
}

describe("better-auth github account linking", () => {
  test("returns disabled state when Better Auth runtime is not enabled", async () => {
    const result = await resolveBetterAuthUserFromGitHubAccount({
      runtime: {
        enabled: false,
        reason: "not configured",
      },
      account: {
        login: "roodboi",
        installationIds: [],
      },
      autoProvision: true,
    });

    expect(result.state).toBe("disabled");
    expect(result.userId).toBeUndefined();
  });

  test("links a Linear account to an existing Better Auth user by email", async () => {
    const result = await resolveBetterAuthUserFromLinearAccount({
      runtime: {
        enabled: true,
        db: createBetterAuthDb([{ id: "user-linear-1" }]),
      },
      account: {
        accountEmail: "linear@example.com",
        accountEmailVerified: true,
        accountName: "Linear User",
      },
      autoProvision: false,
    });

    expect(result.state).toBe("linked_existing");
    expect(result.userId).toBe("user-linear-1");
  });

  test("rejects unverified provider emails before linking or provisioning", async () => {
    const result = await resolveBetterAuthUserFromLinearAccount({
      runtime: {
        enabled: true,
        db: createBetterAuthDb([{ id: "user-linear-1" }]),
      },
      account: {
        accountEmail: "linear@example.com",
        accountEmailVerified: false,
        accountName: "Linear User",
      },
      autoProvision: true,
    });

    expect(result.state).toBe("email_not_verified");
    expect(result.userId).toBeUndefined();
  });
});
