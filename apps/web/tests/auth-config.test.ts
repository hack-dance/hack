import { describe, expect, test } from "bun:test";

import {
  buildAuthBrokerProxyUrl,
  buildBrokerBetterAuthProviderCallbackUrl,
  buildBrokerGitHubCallbackUrl,
} from "../src/lib/auth-config";

describe("web auth config helpers", () => {
  test("builds internal proxy URLs against the broker service", () => {
    expect(
      buildAuthBrokerProxyUrl({
        authBrokerProxyBaseUrl: "http://auth-broker:8080",
        path: "/v1/auth/providers",
      })
    ).toBe("http://auth-broker:8080/v1/auth/providers");
  });

  test("distinguishes custom broker OAuth callbacks from Better Auth callbacks", () => {
    expect(
      buildBrokerGitHubCallbackUrl({
        authBrokerBaseUrl: "https://auth.hack-cli.hack.gy",
      })
    ).toBe("https://auth.hack-cli.hack.gy/gh/callback");

    expect(
      buildBrokerBetterAuthProviderCallbackUrl({
        authBrokerBaseUrl: "https://auth.hack-cli.hack.gy",
        providerId: "github",
      })
    ).toBe("https://auth.hack-cli.hack.gy/api/auth/callback/github");
  });
});
