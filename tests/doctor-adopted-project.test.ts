import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildDoctorRemediationPlanLines } from "../src/commands/doctor.ts";
import {
  ADOPTED_PROJECT_NOT_APPLICABLE_CHECKS,
  ADOPTED_PROJECT_NOT_APPLICABLE_MESSAGE,
  findDoctorAdoptedProject,
  preflightDoctorProject,
} from "../src/lib/doctor-adopted-project.ts";
import { selectLegacyComposeAdoptedRoot } from "../src/lib/native-compose-adoption-command.ts";
import { inspectLegacyComposeAdoptionSelection } from "../src/lib/native-compose-adoption-marker.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";
import {
  leaveRetainedSourceBindOperationPending,
  retainedSourceBindFixture,
  SOURCE_BIND_CANARY,
} from "./helpers/retained-source-bind-adoption.ts";

/**
 * HACK-1311: `hack doctor` in an adopted (`hack config adopt`) project. The
 * adoption owns the project's Compose inputs, so ordinary discovery refuses
 * the project as native input; doctor must select it explicitly, report it
 * with closed messages, and plan `--fix` without throwing. The fixture is the
 * synthetic retained source-bind adoption (no real engine).
 */
let h: Awaited<ReturnType<typeof retainedSourceBindFixture>>;
beforeEach(async () => {
  h = await retainedSourceBindFixture();
});
afterEach(async () => {
  await h.cleanup();
});

/** Prepares and publishes the adoption: the project is now adopted. */
async function adopt(): Promise<void> {
  const store = await h.store();
  try {
    const generation = await store.prepare({ binary: h.compiler });
    await store.publish({ generation, binary: h.compiler });
  } finally {
    await store.close();
  }
  expect(
    await inspectLegacyComposeAdoptionSelection({ projectRoot: h.root })
  ).toBe("active");
}

const receiptPath = () =>
  join(h.root, ".hack/.internal/legacy-compose-adoption-v1/receipt.json");

/** Read-only `doctor --json` in a private HOME and HACK_HOME, stub engine only. */
async function doctorJson(): Promise<{
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const cli = resolve(import.meta.dir, "..", "index.ts");
  const state = join(h.outer, "state");
  await mkdir(state, { recursive: true });
  const child = Bun.spawn(
    [process.execPath, cli, "doctor", "--path", h.root, "--json"],
    {
      cwd: h.root,
      env: privateCliEnv({
        root: h.outer,
        env: {
          HACK_HOME: state,
          HACK_GLOBAL_CONFIG_PATH: join(state, "hack.config.json"),
          HACK_NO_INTERACTIVE: "1",
          HACK_LOGGER: "console",
          XDG_CACHE_HOME: join(h.outer, "cache"),
          PATH: `${h.outer}:/usr/bin:/bin`,
        },
      }),
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exit, stdout, stderr };
}

type JsonCheck = {
  readonly id: string;
  readonly status: string;
  readonly detail: string;
  readonly durationMs: number;
};

test("doctor reports an adopted project with closed messages instead of refusing it as native input (HACK-1311)", async () => {
  await adopt();
  const receipt = await readFile(receiptPath(), "utf8");
  const run = await doctorJson();
  expect(run.stdout + run.stderr).not.toContain("E_NATIVE_PROJECT");
  expect(run.stdout + run.stderr).not.toContain(SOURCE_BIND_CANARY);
  const parsed: unknown = JSON.parse(run.stdout);
  expect(parsed).toMatchObject({ ok: true });
  const checks = (parsed as { data: { checks: JsonCheck[] } }).data.checks;
  const byId = new Map(checks.map((check) => [check.id, check]));

  expect(byId.get("project")).toEqual({
    id: "project",
    status: "ok",
    detail: `Adopted Compose project at ${join(h.root, ".hack")} ('hack config adopt'). Its Compose inputs belong to the adoption; adopted commands support retained-container start, restart, stop, ps, logs and exec.`,
    durationMs: expect.any(Number),
  });
  // Checks that do not read the adoption's inputs still run.
  expect(byId.get("env key")?.status).toBe("ok");
  expect(byId.get("generated files")?.status).toBe("ok");
  expect(byId.get("compose env at rest")).toMatchObject({
    status: "ok",
    detail: "No generated Compose env override",
  });
  // The adoption owns .hack/, so its committed .gitignore is not audited.
  expect(byId.get("hack gitignore")).toMatchObject({
    status: "ok",
    detail: ADOPTED_PROJECT_NOT_APPLICABLE_MESSAGE,
  });
  // The rest are skipped with doctor's `ok` skip convention (a skip that
  // applies by design, like "Skipped (not a git checkout)"), never warnings
  // and never discovery failures.
  expect(ADOPTED_PROJECT_NOT_APPLICABLE_MESSAGE).toBe(
    "Skipped (adopted Compose project: its inputs belong to 'hack config adopt')"
  );
  expect(ADOPTED_PROJECT_NOT_APPLICABLE_CHECKS).toHaveLength(12);
  for (const name of ADOPTED_PROJECT_NOT_APPLICABLE_CHECKS) {
    expect(byId.get(name)).toMatchObject({
      status: "ok",
      detail: ADOPTED_PROJECT_NOT_APPLICABLE_MESSAGE,
    });
  }
  for (const name of [
    "project",
    "agent integrations",
    "sessions mux",
    "env key",
    "generated files",
    "compose env at rest",
    ...ADOPTED_PROJECT_NOT_APPLICABLE_CHECKS,
  ]) {
    expect(byId.get(name)?.status).not.toBe("error");
  }
  // Read-only: the adoption is unchanged and no retained container moved.
  expect(await readFile(receiptPath(), "utf8")).toBe(receipt);
  expect(
    (await h.commands()).filter(
      (args) =>
        args[0] === "container" && ["start", "stop"].includes(args[1] ?? "")
    )
  ).toEqual([]);
}, 120_000);

test("the doctor --fix plan for an adopted project says what it leaves alone instead of throwing (HACK-1311)", async () => {
  await adopt();
  const receipt = await readFile(receiptPath(), "utf8");
  // From a subdirectory too: selection walks up to the adopted root.
  for (const startDir of [h.root, join(h.root, "source")]) {
    const plan = await buildDoctorRemediationPlanLines({
      startDir,
      migrateEnvConfig: true,
    });
    expect(plan).toEqual([
      "1. Review and repair global Docker networks, CoreDNS, CA, host TLS env, and daemon drift where needed.",
      "2. Leave the adopted Compose project's inputs, retained containers and adoption state to 'hack config adopt'; --fix changes none of them.",
      "3. Skip env migration because an adopted Compose project's env config belongs to 'hack config adopt'.",
    ]);
  }
  expect(await readFile(receiptPath(), "utf8")).toBe(receipt);
}, 60_000);

/** The global `--fix` step every plan starts with. */
const GLOBAL_FIX_STEP =
  "1. Review and repair global Docker networks, CoreDNS, CA, host TLS env, and daemon drift where needed.";

/** The adopted-project `--fix` plan, the same for an active or pending adoption. */
const ADOPTED_FIX_PLAN = [
  GLOBAL_FIX_STEP,
  "2. Leave the adopted Compose project's inputs, retained containers and adoption state to 'hack config adopt'; --fix changes none of them.",
  "3. Skip env migration because an adopted Compose project's env config belongs to 'hack config adopt'.",
];

test("doctor reports a pending adoption as a project warning that asks for recovery, and plans --fix without touching it (HACK-1311)", async () => {
  await adopt();
  await leaveRetainedSourceBindOperationPending(h);
  expect(
    await inspectLegacyComposeAdoptionSelection({ projectRoot: h.root })
  ).toBe("pending");
  const receipt = await readFile(receiptPath(), "utf8");
  const engineCommands = (await h.commands()).length;

  const run = await doctorJson();
  expect(run.stdout + run.stderr).not.toContain("E_NATIVE_PROJECT");
  expect(run.stdout + run.stderr).not.toContain(SOURCE_BIND_CANARY);
  const parsed: unknown = JSON.parse(run.stdout);
  // A warning, not an error: doctor still exits ok.
  expect(parsed).toMatchObject({ ok: true });
  const checks = (parsed as { data: { checks: JsonCheck[] } }).data.checks;
  const byId = new Map(checks.map((check) => [check.id, check]));
  expect(byId.get("project")).toEqual({
    id: "project",
    status: "warn",
    detail: `Adopted Compose project at ${join(h.root, ".hack")} has a pending or interrupted adoption operation. Use explicit adoption recovery before other project commands; values omitted.`,
    durationMs: expect.any(Number),
  });
  expect(byId.get("generated files")?.status).toBe("ok");
  for (const name of ADOPTED_PROJECT_NOT_APPLICABLE_CHECKS) {
    expect(byId.get(name)).toMatchObject({
      status: "ok",
      detail: ADOPTED_PROJECT_NOT_APPLICABLE_MESSAGE,
    });
  }

  for (const startDir of [h.root, join(h.root, "source")]) {
    expect(
      await buildDoctorRemediationPlanLines({
        startDir,
        migrateEnvConfig: true,
      })
    ).toEqual(ADOPTED_FIX_PLAN);
  }
  // Read-only: still pending and the journal unchanged.
  expect(
    await inspectLegacyComposeAdoptionSelection({ projectRoot: h.root })
  ).toBe("pending");
  expect(await readFile(receiptPath(), "utf8")).toBe(receipt);
  // Doctor's global checks reach the stub engine read-only; nothing touches
  // the adopted project's containers or Compose project.
  const doctorCommands = (await h.commands()).slice(engineCommands);
  expect(
    doctorCommands.filter(
      (args) =>
        (args[0] === "container" &&
          ["start", "stop", "restart"].includes(args[1] ?? "")) ||
        args.some((arg) => arg.startsWith(h.root))
    )
  ).toEqual([]);
}, 120_000);

test("a start directory deeper than the old adoption search bound gets ordinary discovery instead of a throw", async () => {
  // More ancestors than the adoption selector once walked (64), with no
  // project root on the way. The selector now walks every ancestor (HACK-1380)
  // and finds no adoption, so doctor needs no catch of its own.
  let deep = join(h.outer, "deep");
  for (let level = 0; level < 70; level++) {
    deep = join(deep, "d");
  }
  await mkdir(deep, { recursive: true });
  expect(await selectLegacyComposeAdoptedRoot({ cwd: deep })).toBeNull();

  expect(await findDoctorAdoptedProject({ startDir: deep })).toBeNull();
  expect(await preflightDoctorProject({ startDir: deep })).toBeNull();
  expect(
    await buildDoctorRemediationPlanLines({
      startDir: deep,
      migrateEnvConfig: false,
    })
  ).toEqual([GLOBAL_FIX_STEP]);
}, 60_000);

test("unsafe adoption state still refuses doctor with the selector's closed error", async () => {
  // A state root that is not a directory is unsafe adoption state, so doctor
  // must not read it as "no adoption".
  const root = join(h.outer, "unsafe");
  await mkdir(join(root, ".hack/.internal"), { recursive: true });
  await writeFile(
    join(root, ".hack/.internal/legacy-compose-adoption-v1"),
    SOURCE_BIND_CANARY
  );
  for (const run of [
    () => findDoctorAdoptedProject({ startDir: root }),
    () => preflightDoctorProject({ startDir: root }),
  ]) {
    const error: unknown = await run().then(
      () => null,
      (caught: unknown) => caught
    );
    expect(error).toMatchObject({ code: "E_CONFIG_INVALID" });
    expect(String(error)).not.toContain(SOURCE_BIND_CANARY);
    expect(String(error)).not.toContain(root);
  }
}, 60_000);
