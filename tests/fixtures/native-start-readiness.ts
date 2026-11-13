import { nativeCacheInitializers } from "../../src/backends/native-project-cache.ts";
import { reviewedNativeRoutes } from "../../src/backends/native-project-routing.ts";
import { nativeReadinessArgs } from "../../src/backends/native-project-start.ts";
import { isRecord } from "../../src/lib/guards.ts";

/** Rust's contract test supplies its actual plan and the corresponding public specs. */
const timeout = setTimeout(() => process.exit(2), 10_000);
try {
  const input: unknown = await Bun.stdin.json();
  if (!(isRecord(input) && isRecord(input.specs))) {
    throw new Error("Invalid readiness fixture.");
  }
  const specs: Record<string, Record<string, unknown>> = {};
  for (const [name, spec] of Object.entries(input.specs)) {
    if (!isRecord(spec)) {
      throw new Error("Invalid readiness service fixture.");
    }
    specs[name] = spec;
  }
  const plan = input.plan;
  const goals = nativeReadinessArgs({
    specs,
    plan,
    initializers: nativeCacheInitializers(plan),
    routed: reviewedNativeRoutes({ plan, specs, capacity: 32 }).services,
  });
  const entries = goals
    .filter((_, index) => index % 2 === 1)
    .map((goal) => goal.split("="));
  process.stdout.write(JSON.stringify(Object.fromEntries(entries)));
} finally {
  clearTimeout(timeout);
}
