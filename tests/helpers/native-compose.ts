import type {
  EnvironmentPlan,
  Plan,
  Workload,
} from "../../packages/config-compiler/generated/native-config.ts";

export function composeFixture(
  opts: {
    readonly services?: Record<string, Workload>;
    readonly jobs?: Record<string, Workload>;
  } = {}
): {
  plan: Plan;
  environmentPlan: EnvironmentPlan;
  projectRoot: string;
  runtimeIdentity: string;
  ownerToken: string;
  generationIdentity: string;
  managedValues: Record<string, Record<string, string>>;
} {
  const services = opts.services ?? { web: { image: "fixture/web:1" } };
  const jobs = opts.jobs ?? {};
  const names = [...Object.keys(services), ...Object.keys(jobs)];
  return {
    plan: {
      plan_version: 1,
      name: "fixture",
      source: { root: ".", mode: "host-mounted" },
      environment: {},
      worktree: { auto_branch: true, inherit_local: true },
      selected_profiles: [],
      storage: {},
      services,
      jobs,
    },
    environmentPlan: {
      plan_version: 1,
      overlay: null,
      overlay_exists: false,
      complete: true,
      workloads: Object.fromEntries(names.map((name) => [name, {}])),
      warnings: [],
      diagnostics: [],
    },
    projectRoot: "/verified/checkout",
    runtimeIdentity: "nc03-fixture-a",
    ownerToken: "c".repeat(32),
    generationIdentity: "a".repeat(32),
    managedValues: Object.fromEntries(names.map((name) => [name, {}])),
  };
}
