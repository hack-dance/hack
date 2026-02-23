import { describe, expect, test } from "bun:test";

import { resolveBetterAuthUserFromGitHubAccount } from "../src/better-auth-link.ts";

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
});
