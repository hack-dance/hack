import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

type PackageJson = {
  readonly dependencies?: Record<string, string>;
};

describe("auth broker package manifest", () => {
  test("declares runtime packages required by better-auth", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as PackageJson;

    expect(packageJson.dependencies?.["better-auth"]).toBeDefined();
    expect(
      packageJson.dependencies?.["@better-auth/drizzle-adapter"]
    ).toBeDefined();
  });
});
