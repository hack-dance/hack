import { describe, expect, test } from "bun:test";

import {
  buildBrokerAccountBridgeUrl,
  normalizeAppReturnUrl,
} from "../src/lib/auth-handoff";

describe("web auth handoff helpers", () => {
  test("buildBrokerAccountBridgeUrl preserves flow context and the final return target", () => {
    const url = buildBrokerAccountBridgeUrl({
      authBrokerBaseUrl: "https://auth.hack-cli.hack",
      appBaseUrl: "https://hack-cli.hack",
      flowId: "flow-123",
      deviceCode: "device-123",
      finalReturnUrl: "hack://auth/complete",
    });

    expect(url).toBe(
      "https://auth.hack-cli.hack/auth/account?bridge=1&flowId=flow-123&deviceCode=device-123&redirect=https%3A%2F%2Fhack-cli.hack%2Fauth%2Faccount%3FflowId%3Dflow-123%26deviceCode%3Ddevice-123%26redirect%3Dhack%253A%252F%252Fauth%252Fcomplete"
    );
  });

  test("normalizeAppReturnUrl accepts desktop protocols and trusted web origins while rejecting unknown origins", () => {
    const trustedOrigins = [
      "https://hack-cli.hack",
      "https://*.hack-cli.hack",
      "https://hack-cli-preview.vercel.app",
    ] as const;

    expect(
      normalizeAppReturnUrl({
        value: "hack://auth/complete",
        appBaseUrl: "https://hack-cli.hack",
        trustedOrigins,
      })
    ).toBe("hack://auth/complete");
    expect(
      normalizeAppReturnUrl({
        value: "https://hack-cli-preview.vercel.app/account",
        appBaseUrl: "https://hack-cli.hack",
        trustedOrigins,
      })
    ).toBe("https://hack-cli-preview.vercel.app/account");
    expect(
      normalizeAppReturnUrl({
        value: "https://evil.example.com/phish",
        appBaseUrl: "https://hack-cli.hack",
        trustedOrigins,
      })
    ).toBeNull();
  });
});
