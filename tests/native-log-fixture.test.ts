import { expect, test } from "bun:test";
import { compileNativeConfig } from "../src/lib/native-config-compiler.ts";
import { requireTestConfigCompiler } from "./helpers/test-config-compiler.ts";

const binary = requireTestConfigCompiler();
test("the authored web/db log acceptance fixture compiles without host inputs", async () => {
  const fixture = Bun.file(
    new URL("./fixtures/native-log-follow.project.json", import.meta.url)
  );
  const result = await compileNativeConfig({
    binary,
    input: new Uint8Array(await fixture.arrayBuffer()),
  });
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("Authored log fixture must compile");
  }
  expect(result.plan.services).toHaveProperty("web");
  expect(result.plan.services).toHaveProperty("db");
});
