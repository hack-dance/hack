import { describe, expect, test } from "bun:test";

import { buildHackDesktopDeepLink } from "../src/modules/github-oauth/service.ts";

describe("github oauth callback deep link", () => {
  test("builds deep link with required fields", () => {
    const deepLink = buildHackDesktopDeepLink({
      flowId: "flow_123",
      profileId: "default",
      status: "complete",
    });
    const url = new URL(deepLink);
    expect(url.protocol).toBe("hack:");
    expect(url.hostname).toBe("auth");
    expect(url.pathname).toBe("/github/callback");
    expect(url.searchParams.get("flowId")).toBe("flow_123");
    expect(url.searchParams.get("profileId")).toBe("default");
    expect(url.searchParams.get("status")).toBe("complete");
    expect(url.searchParams.get("installationId")).toBeNull();
  });

  test("includes installation id when provided", () => {
    const deepLink = buildHackDesktopDeepLink({
      flowId: "flow_abc",
      profileId: "work",
      status: "install_required",
      installationId: "123456",
    });
    const url = new URL(deepLink);
    expect(url.searchParams.get("installationId")).toBe("123456");
  });
});
