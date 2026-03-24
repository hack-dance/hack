import { describe, expect, test } from "bun:test";

import {
  createBetterAuthProviderMetadata,
  createSharedBetterAuthContract,
  createWebAuthStartupConfig,
  isTrustedAuthOrigin,
  resolveBetterAuthSocialProviderOptions,
  resolveBetterAuthSocialProviders,
} from "../src/index.ts";

describe("shared better auth contract", () => {
  test("broker and web startup reuse the same enabled-provider metadata", () => {
    const socialProviders = resolveBetterAuthSocialProviders({
      betterAuthGitHubClientId: "github-client-id",
      betterAuthGitHubClientSecret: "github-client-secret",
    });
    const contract = createSharedBetterAuthContract({
      socialProviders,
      authBaseUrl: "https://auth.hack.broker",
      publicBaseUrl: "http://127.0.0.1:8080",
      localDevHost: "hack-cli.hack",
      trustedOrigins: [
        "https://hack-cli-preview.vercel.app",
        "https://hack.dance",
      ],
    });
    const brokerMetadata = createBetterAuthProviderMetadata({
      enabled: true,
      contract,
    });
    const webStartupConfig = createWebAuthStartupConfig({
      authBrokerBaseUrl: "https://auth.hack.broker",
      contract,
    });

    expect(
      resolveBetterAuthSocialProviderOptions({
        betterAuthGitHubClientId: "github-client-id",
        betterAuthGitHubClientSecret: "github-client-secret",
      })
    ).toEqual({
      github: {
        clientId: "github-client-id",
        clientSecret: "github-client-secret",
      },
    });
    expect(brokerMetadata.socialProviders).toEqual([
      {
        id: "github",
        label: "GitHub",
      },
    ]);
    expect(brokerMetadata.socialProviders).not.toContainEqual({
      id: "google",
      label: "Google",
    });
    expect(webStartupConfig.betterAuth).toEqual(brokerMetadata);
    expect(webStartupConfig.authBrokerBaseUrl).toBe("https://auth.hack.broker");
  });

  test("trusted origins allow local hack hosts and deploy origins while rejecting unknown origins", () => {
    const contract = createSharedBetterAuthContract({
      socialProviders: [],
      authBaseUrl: "https://auth.hack.broker",
      publicBaseUrl: "http://127.0.0.1:8080",
      localDevHost: "hack-cli.hack",
      trustedOrigins:
        "https://hack-cli-preview.vercel.app,https://hack.dance, https://*.hack-cloud.test",
    });

    expect(contract.trustedOrigins).toEqual([
      "https://auth.hack.broker",
      "http://127.0.0.1:8080",
      "https://hack-cli.hack",
      "https://*.hack-cli.hack",
      "https://hack-cli.hack.gy",
      "https://*.hack-cli.hack.gy",
      "https://hack-cli-preview.vercel.app",
      "https://hack.dance",
      "https://*.hack-cloud.test",
    ]);
    expect(
      isTrustedAuthOrigin({
        origin: "https://hack-cli.hack",
        trustedOrigins: contract.trustedOrigins,
      })
    ).toBe(true);
    expect(
      isTrustedAuthOrigin({
        origin: "https://web.hack-cli.hack",
        trustedOrigins: contract.trustedOrigins,
      })
    ).toBe(true);
    expect(
      isTrustedAuthOrigin({
        origin: "https://hack-cli.hack.gy",
        trustedOrigins: contract.trustedOrigins,
      })
    ).toBe(true);
    expect(
      isTrustedAuthOrigin({
        origin: "http://127.0.0.1:8080",
        trustedOrigins: contract.trustedOrigins,
      })
    ).toBe(true);
    expect(
      isTrustedAuthOrigin({
        origin: "https://hack-cli-preview.vercel.app",
        trustedOrigins: contract.trustedOrigins,
      })
    ).toBe(true);
    expect(
      isTrustedAuthOrigin({
        origin: "https://preview.hack-cloud.test",
        trustedOrigins: contract.trustedOrigins,
      })
    ).toBe(true);
    expect(
      isTrustedAuthOrigin({
        origin: "https://evil.example.com",
        trustedOrigins: contract.trustedOrigins,
      })
    ).toBe(false);
  });
});
