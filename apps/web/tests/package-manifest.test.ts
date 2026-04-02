import { expect, test } from "bun:test";

type WebPackageManifest = {
  readonly name: string;
  readonly scripts: Record<string, string>;
};

const NEXT_ROUTES_IMPORT_PATTERN =
  /import ["']\.\/\.next\/(dev\/)?types\/routes\.d\.ts["'];/;

const packageManifest = (await Bun.file(
  new URL("../package.json", import.meta.url)
).json()) as WebPackageManifest;
const nextEnvSource = await Bun.file(
  new URL("../next-env.d.ts", import.meta.url)
).text();
const tsconfigSource = await Bun.file(
  new URL("../tsconfig.json", import.meta.url)
).text();

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

test("web typecheck inputs stay stable for next-managed dev type generation", () => {
  expect(nextEnvSource).toMatch(NEXT_ROUTES_IMPORT_PATTERN);
  expect(tsconfigSource).toContain(".next/types/**/*.ts");
  expect(tsconfigSource).toContain(".next/dev/types/**/*.ts");
});
