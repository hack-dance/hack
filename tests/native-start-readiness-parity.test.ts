import { expect, test } from "bun:test";
import { nativeCacheInitializers } from "../src/backends/native-project-cache.ts";
import { reviewedNativeRoutes } from "../src/backends/native-project-routing.ts";
import { nativeReadinessArgs } from "../src/backends/native-project-start.ts";
import { isRecord } from "../src/lib/guards.ts";
import cases from "./fixtures/native-start-readiness.json";

/** Rust independently checks these snapshots against its actual plans. */
test("CLI start readiness matches the runtime's shared Compose fixtures", () => {
  for (const fixture of cases) {
    const specs: Record<string, Record<string, unknown>> = {};
    for (const [name, spec] of Object.entries(fixture.compose.services)) {
      expect(isRecord(spec)).toBe(true);
      if (isRecord(spec)) {
        specs[name] = spec;
      }
    }
    const plan = { services: fixture.reviewed_services };
    const args = nativeReadinessArgs({
      specs,
      plan,
      initializers: nativeCacheInitializers(plan),
      routed: reviewedNativeRoutes({ plan, specs, capacity: 32 }).services,
    });
    const goals = Object.fromEntries(
      args.filter((_, index) => index % 2 === 1).map((goal) => goal.split("="))
    );
    expect(goals, fixture.name).toEqual(fixture.goals);
  }
});
