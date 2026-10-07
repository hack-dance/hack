import { expect, test } from "bun:test";
import { isRecord } from "../src/lib/guards.ts";
import { renderNativeCompose } from "../src/lib/native-compose-renderer.ts";

/** Rust tests independently recompile the authored fixture and check both typed projections. */
test("NC03 rendering shares the native graph core contract with exactly one dollar escape", async () => {
  const fixture: unknown = await Bun.file(
    new URL(
      "../packages/runtime-core/tests/fixtures/native-plan-graph-core.json",
      import.meta.url
    )
  ).json();
  if (
    !isRecord(fixture) ||
    !isRecord(fixture.plan) ||
    !isRecord(fixture.compose)
  ) {
    throw new Error("Invalid shared native graph fixture");
  }
  const result = renderNativeCompose({
    plan: fixture.plan,
    environmentPlan: fixture.environment_plan,
    projectRoot: "/verified/checkout",
    runtimeIdentity: "adapter-core",
    ownerToken: "c".repeat(32),
    generationIdentity: "a".repeat(32),
    managedValues: { "a.web": {}, "z.seed": {} },
  });
  const web = result.document.services["a.web"];
  const seed = result.document.services["z.seed"];
  expect(web?.command).toEqual(fixture.compose.command);
  expect(web?.entrypoint).toEqual(fixture.compose.entrypoint);
  expect(web?.environment).toEqual(fixture.compose.environment);
  expect(web?.healthcheck).toEqual(fixture.compose.healthcheck);
  expect(web?.depends_on).toEqual(fixture.compose.depends_on);
  expect(seed?.command).toEqual(fixture.compose.job_command);
  expect(seed?.restart).toBe("no");
  expect(Object.keys(result.document.services)).toEqual(["a.web", "z.seed"]);
});
