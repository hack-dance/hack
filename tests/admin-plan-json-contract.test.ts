import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdminPlan } from "../src/commands/global-admin-plan.ts";
import { MACHINE_SCHEMAS } from "../src/lib/machine-output.ts";
import { machineData, machineError } from "./helpers/machine-output.ts";
import { registerScopedModuleMock } from "./helpers/scoped-module-mock.ts";

let plan: AdminPlan;
let root: string;
let env: Record<string, string | undefined>;
const planner = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/commands/global-admin-plan.ts",
  overrides: {
    planGlobalInstall: async () => plan,
    planGlobalTrust: async () => plan,
  },
});
beforeAll(() => planner.activate());
afterAll(() => planner.deactivate());
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-plan-json-"));
  const keys = [
    "HOME",
    "HACK_HOME",
    "HACK_RUNTIME_BACKEND",
    "HACK_CANDIDATE_ENTRYPOINT",
    "HACK_LOGGER",
    "HACK_DAEMON_AUTOSTART_DISABLE",
  ];
  env = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) {
    Reflect.deleteProperty(process.env, key);
  }
  process.env.HOME = root;
  process.env.HACK_HOME = join(root, "state");
  process.env.HACK_LOGGER = "console";
  process.env.HACK_DAEMON_AUTOSTART_DISABLE = "1";
});
afterEach(async () => {
  mock.restore();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  await rm(root, { recursive: true, force: true });
});

for (const command of ["install", "trust"] as const) {
  test.each([
    "complete",
    "refused",
    "incomplete",
  ] as const)(`${command} plan %s follows its JSON result contract`, async (outcome) => {
    plan = {
      schema: MACHINE_SCHEMAS.globalAdminPlan,
      command,
      platform: "linux",
      complete: outcome === "complete",
      refused: outcome === "refused" ? "Host selection refused" : null,
      blocked:
        outcome === "incomplete"
          ? [
              {
                phase: "host",
                reason: "Unknown",
                prerequisite: "Re-check host state",
              },
            ]
          : [],
      steps: [],
    };
    let stdout = "";
    spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("plan contract executed a child");
    });
    const { runCli } = await import("../src/cli/run.ts");
    const code = await runCli(["global", command, "--plan", "--json"]);
    expect(code).toBe(
      outcome === "complete" ? 0 : outcome === "refused" ? 1 : 3
    );
    if (outcome === "complete") {
      expect(machineData(stdout, MACHINE_SCHEMAS.globalAdminPlan)).toEqual(
        plan
      );
    } else {
      expect(
        machineError(
          stdout,
          outcome === "refused" ? "E_PLAN_REFUSED" : "E_PLAN_INCOMPLETE"
        ).detail.plan
      ).toEqual(plan);
    }
    expect(spawn).not.toHaveBeenCalled();
  });
}
