import { expect, test } from "bun:test";

import { resolveAllowedDevOrigins } from "../src/lib/next-dev-origins";

test("resolveAllowedDevOrigins derives routed dev hosts from configured urls", () => {
  expect(
    resolveAllowedDevOrigins({
      env: {
        NEXT_PUBLIC_HACK_WEB_APP_BASE_URL: "https://hack-cli.hack",
        HACK_WEB_APP_BASE_URL: "https://hack-cli.hack",
        BETTER_AUTH_TRUSTED_ORIGINS:
          "https://hack-cli.hack, https://hack-cli.hack.gy",
      },
    })
  ).toEqual(["hack-cli.hack", "hack-cli.hack.gy"]);
});

test("resolveAllowedDevOrigins accepts direct host entries and wildcards", () => {
  expect(
    resolveAllowedDevOrigins({
      env: {
        HACK_LOCAL_DEV_HOST: "hack-cli.hack",
        BETTER_AUTH_TRUSTED_ORIGINS: "*.hack-cli.hack.gy",
      },
    })
  ).toEqual(["hack-cli.hack", "*.hack-cli.hack.gy"]);
});

test("resolveAllowedDevOrigins ignores invalid and empty values", () => {
  expect(
    resolveAllowedDevOrigins({
      env: {
        NEXT_PUBLIC_HACK_WEB_APP_BASE_URL: "not a url",
        HACK_LOCAL_DEV_HOST: "",
        BETTER_AUTH_TRUSTED_ORIGINS: "   ",
      },
    })
  ).toEqual([]);
});
