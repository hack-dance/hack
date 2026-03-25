import { expect, test } from "bun:test";

type WebPackageManifest = {
  readonly name: string;
  readonly scripts: Record<string, string>;
};

const packageManifest = (await Bun.file(
  new URL("../package.json", import.meta.url)
).json()) as WebPackageManifest;

test("web package exposes reproducible workspace tasks", () => {
  expect(packageManifest.name).toBe("@hack/web");
  expect(packageManifest.scripts).toEqual(
    expect.objectContaining({
      build: "next build",
      check:
        "cd ../.. && bunx ultracite check apps/web/app apps/web/src apps/web/tests",
      dev: "next dev",
      start: "next start",
      test: "bun test",
      typecheck: "bunx tsc -p tsconfig.json --noEmit",
    })
  );
});
