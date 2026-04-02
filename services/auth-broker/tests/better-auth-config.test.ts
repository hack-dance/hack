import { describe, expect, test } from "bun:test";

import { resolveBetterAuthGitHubCallbackUrl } from "@/better-auth.ts";

describe("better auth callback config", () => {
  test("keeps the browser GitHub callback under the Better Auth base path", () => {
    expect(
      resolveBetterAuthGitHubCallbackUrl({
        betterAuthBaseUrl: "https://auth.hack-cli.hack.gy",
      })
    ).toBe("https://auth.hack-cli.hack.gy/api/auth/callback/github");
  });
});
