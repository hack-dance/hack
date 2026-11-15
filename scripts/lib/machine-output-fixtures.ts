import { errorResult } from "../../src/lib/cli-result.ts";
import {
  MACHINE_SCHEMAS,
  machineSuccess,
} from "../../src/lib/machine-output.ts";

/** Minimal payloads for cross-language boundary tests, not runtime-state fixtures. */
export function machineOutputFixtures() {
  const plan = {
    command: "install",
    platform: "linux",
    refused: null,
    complete: true,
    blocked: [],
    steps: [],
  };
  const success = (
    schema: (typeof MACHINE_SCHEMAS)[keyof typeof MACHINE_SCHEMAS],
    data: object
  ) => machineSuccess({ schema, data });
  return {
    "activity.json": success(MACHINE_SCHEMAS.activity, {
      version: 1,
      entries: [],
    }),
    "version.json": success(MACHINE_SCHEMAS.version, {
      version: "5.0.0",
      channel: "stable",
      install_kind: "standalone",
      binary_path: "/example/bin/hack",
    }),
    "projects-observe.json": success(MACHINE_SCHEMAS.projectsObserve, {
      observe: true,
      runtime_requested: false,
      runtime_ok: false,
      projects: [],
    }),
    "global-status-observe.json": success(MACHINE_SCHEMAS.globalStatusObserve, {
      observe: true,
      docker: { state: "not_running" },
      summary: { ok: "unknown" },
    }),
    "global-install-plan.json": success(MACHINE_SCHEMAS.globalAdminPlan, plan),
    "global-trust-plan.json": success(MACHINE_SCHEMAS.globalAdminPlan, {
      ...plan,
      command: "trust",
    }),
    "plan-incomplete.json": errorResult({
      code: "E_PLAN_INCOMPLETE",
      message: "Administrator plan is incomplete.",
      detail: {
        plan: {
          ...plan,
          schema: MACHINE_SCHEMAS.globalAdminPlan,
          complete: false,
        },
      },
    }),
  };
}
