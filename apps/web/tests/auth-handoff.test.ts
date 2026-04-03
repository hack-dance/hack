import { describe, expect, test } from "bun:test";

import {
  buildBrokerBrowserStartUrl,
  normalizeAppReturnUrl,
  resolveInitialAuthFlowKind,
  shouldAutoNavigateToReturnUrl,
} from "../src/lib/auth-handoff";

describe("web auth handoff helpers", () => {
  test("buildBrokerBrowserStartUrl preserves flow context and the final return target", () => {
    const url = buildBrokerBrowserStartUrl({
      authBrokerBaseUrl: "https://auth.hack-cli.hack",
      appBaseUrl: "https://hack-cli.hack",
      flowId: "flow-123",
      deviceCode: "device-123",
      finalReturnUrl: "hack://auth/complete",
      providerId: "github",
    });

    expect(url).toBe(
      "https://auth.hack-cli.hack/v1/auth/session/browser/start?provider=github&redirect=https%3A%2F%2Fhack-cli.hack%2Fauth%2Faccount%3FflowId%3Dflow-123%26deviceCode%3Ddevice-123%26redirect%3Dhack%253A%252F%252Fauth%252Fcomplete"
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

  test("shouldAutoNavigateToReturnUrl keeps trusted web deep links auto-returnable", () => {
    expect(
      shouldAutoNavigateToReturnUrl({
        value: "hack://auth/complete",
      })
    ).toBe(true);
    expect(
      shouldAutoNavigateToReturnUrl({
        value: "https://hack-cli.hack/account",
      })
    ).toBe(true);
    expect(
      shouldAutoNavigateToReturnUrl({
        value: "https://hack-cli-preview.vercel.app/account",
      })
    ).toBe(true);
  });

  test("resolveInitialAuthFlowKind auto-confirms browser-owned account redirects after the web session cookie is set", () => {
    expect(
      resolveInitialAuthFlowKind({
        mode: "account",
        browserSessionAuthenticated: true,
        redirect: "https://hack-cli.hack/account?org=hack",
      })
    ).toBe("ready");
    expect(
      resolveInitialAuthFlowKind({
        mode: "account",
        browserSessionAuthenticated: true,
        redirect: null,
      })
    ).toBe("ready");
    expect(
      resolveInitialAuthFlowKind({
        mode: "account",
        flowId: "flow-123",
        deviceCode: "device-123",
        browserSessionAuthenticated: true,
        redirect: "https://hack-cli.hack/account?org=hack",
      })
    ).toBe("polling");
  });
});
