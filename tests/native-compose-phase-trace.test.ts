import { afterEach, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  createNativeComposePhaseTrace,
  NATIVE_COMPOSE_PHASE_TRACE,
} from "../src/lib/native-compose-phase-trace.ts";
import { captureCompletedJobFixtureCommand } from "./e2e/scenarios/native-compose-adoption-job-worktrees.ts";
import { fixture } from "./helpers/native-compose-command.ts";

const rowKeys =
  "boundary,diagnostic,durationMs,elapsedMs,phase,sequence,span,version";
function records(text: string) {
  return text
    .split("\n")
    .filter((line) => line.startsWith('{"diagnostic":"native-compose-phase",'))
    .map((line) => {
      const row = JSON.parse(line);
      expect(Object.keys(row).sort().join()).toBe(rowKeys);
      expect(row.diagnostic).toBe("native-compose-phase");
      expect(row.version).toBe(1);
      expect(Number.isSafeInteger(row.sequence)).toBe(true);
      expect(Number.isSafeInteger(row.span)).toBe(true);
      expect(Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0).toBe(true);
      expect(
        row.boundary === "begin"
          ? row.durationMs === null
          : Number.isFinite(row.durationMs) && row.durationMs >= 0
      ).toBe(true);
      return row;
    });
}

test("begin is visible before the guarded await settles; its exact result is preserved", async () => {
  const lines: string[] = [];
  let tick = 0;
  const trace = createNativeComposePhaseTrace({
    write: (line) => {
      lines.push(line);
    },
    now: () => tick++,
  });
  const gate = Promise.withResolvers<object>();
  const sentinel = {};
  const result = trace.measure("finalize.owned", () => gate.promise);
  expect(records(lines.join(""))).toEqual([
    {
      diagnostic: "native-compose-phase",
      version: 1,
      sequence: 1,
      span: 1,
      phase: "finalize.owned",
      boundary: "begin",
      elapsedMs: 1,
      durationMs: null,
    },
  ]);
  gate.resolve(sentinel);
  expect(await result).toBe(sentinel);
  expect(records(lines.join(""))[1]).toEqual({
    diagnostic: "native-compose-phase",
    version: 1,
    sequence: 2,
    span: 1,
    phase: "finalize.owned",
    boundary: "end",
    elapsedMs: 2,
    durationMs: 2,
  });
});

test("failure is value-free and the original rejection survives a failing diagnostic sink", async () => {
  const canary = new Error("private-value-must-never-be-serialized");
  const lines: string[] = [];
  const trace = createNativeComposePhaseTrace({
    write: (line) => {
      lines.push(line);
    },
    now: () => 1,
  });
  await expect(
    trace.measure("guard.ownership", () => Promise.reject(canary))
  ).rejects.toBe(canary);
  expect(records(lines.join("")).map((row) => row.boundary)).toEqual([
    "begin",
    "fail",
  ]);
  expect(lines.join("")).not.toContain(canary.message);
  let attempts = 0;
  const broken = createNativeComposePhaseTrace({
    write: () => {
      attempts++;
      throw canary;
    },
  });
  await expect(
    broken.measure("guard.ownership", () => Promise.reject(canary))
  ).rejects.toBe(canary);
  const sentinel = {};
  expect(
    await broken.measure("finalize.save", () => Promise.resolve(sentinel))
  ).toBe(sentinel);
  expect(attempts).toBe(1);
});

test.each([
  "throw",
  "invalid",
  "backwards",
] as const)("%s clock disables observations and preserves operations", async (fault) => {
  let reads = 0;
  let effects = 0;
  const lines: string[] = [];
  const trace = createNativeComposePhaseTrace({
    write: (line) => {
      lines.push(line);
    },
    now: () => {
      reads++;
      if (fault === "throw") {
        throw new Error("private-clock-value");
      }
      if (fault === "invalid") {
        return Number.NaN;
      }
      return reads === 1 ? 10 : 9;
    },
  });
  expect(await trace.measure("finalize.save", async () => ++effects)).toBe(1);
  expect(await trace.measure("finalize.save", async () => ++effects)).toBe(2);
  expect(lines).toHaveLength(0);
});

test("record overflow stops output while every original operation still runs", async () => {
  const lines: string[] = [];
  const trace = createNativeComposePhaseTrace({
    write: (line) => {
      lines.push(line);
    },
    now: () => 0,
  });
  let effects = 0;
  for (let index = 0; index < 200; index++) {
    await trace.measure("finalize.save", async () => ++effects);
  }
  expect(effects).toBe(200);
  expect(lines).toHaveLength(256);
  expect(Buffer.byteLength(lines.join(""))).toBeLessThanOrEqual(64 * 1024);
  expect(records(lines.join("")).at(-1)?.sequence).toBe(256);
});

function isolated(program: string, flag?: string) {
  return Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `import {withNativeComposePhaseTrace,measureNativeComposePhase} from ${JSON.stringify(resolve(import.meta.dir, "../src/lib/native-compose-phase-trace.ts"))};${program}`,
    ],
    {
      env: {
        PATH: "/usr/bin:/bin",
        ...(flag === undefined ? {} : { [NATIVE_COMPOSE_PHASE_TRACE]: flag }),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    }
  );
}

test.each([
  undefined,
  "0",
  "true",
])("absent or nonliteral opt-in %s produces zero trace output", (flag) => {
  const child = isolated(
    'await withNativeComposePhaseTrace(()=>measureNativeComposePhase("finalize.save",async()=>{if(process.env.HACK_NATIVE_COMPOSE_PHASE_TRACE!==undefined)throw new Error("flag not consumed");console.log("original-result")}));',
    flag
  );
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe("original-result\n");
  expect(child.stderr.toString()).toBe("");
});

test("concurrent trace requests have independent sequences and do not arm an unselected request", () => {
  const child = isolated(
    `
const gate=Promise.withResolvers();
const first=withNativeComposePhaseTrace(async()=>{
 const nested=withNativeComposePhaseTrace(()=>measureNativeComposePhase("finalize.save",async()=>{}));
 await measureNativeComposePhase("guard.ownership",()=>gate.promise);await nested;
});
await withNativeComposePhaseTrace(()=>measureNativeComposePhase("finalize.save",async()=>{}));
await withNativeComposePhaseTrace(async()=>{await withNativeComposePhaseTrace(()=>measureNativeComposePhase("finalize.save",async()=>{}));});
process.env.HACK_NATIVE_COMPOSE_PHASE_TRACE="1";
await withNativeComposePhaseTrace(()=>measureNativeComposePhase("finalize.pending",async()=>{}));
gate.resolve();await first;
`,
    "1"
  );
  expect(child.exitCode).toBe(0);
  expect(
    records(child.stderr.toString()).map(
      ({ phase, sequence, span, boundary }) => ({
        phase,
        sequence,
        span,
        boundary,
      })
    )
  ).toEqual([
    { phase: "guard.ownership", sequence: 1, span: 1, boundary: "begin" },
    { phase: "finalize.pending", sequence: 1, span: 1, boundary: "begin" },
    { phase: "finalize.pending", sequence: 2, span: 1, boundary: "end" },
    { phase: "guard.ownership", sequence: 2, span: 1, boundary: "end" },
  ]);
});

// This latch covers the whole callback, including fixture setup and receipt assertions.
// An outer test timeout must never delete roots or let another case reuse unknown work.
let retainedCase = false;
let activeCases = 0;
afterEach(() => {
  if (activeCases > 0) {
    retainedCase = true;
  }
});
async function ownedCase(
  body: (owner: {
    readonly cleanupAllowed: () => boolean;
    readonly invoke: (
      root: string,
      args: readonly string[]
    ) => Promise<{ code: number; stdout: string; stderr: string }>;
  }) => Promise<void>
) {
  if (retainedCase) {
    throw new Error(
      "Prior phase-trace case lifetime is unconfirmed; fixture retained."
    );
  }
  let active = true;
  activeCases++;
  let capture = 0;
  const retain = () => {
    retainedCase = true;
  };
  const cleanupAllowed = () => {
    if (active) {
      retain();
    }
    return !retainedCase;
  };
  try {
    await body({
      cleanupAllowed,
      invoke: async (root, args) => {
        let result: Awaited<
          ReturnType<typeof captureCompletedJobFixtureCommand>
        >;
        try {
          result = await captureCompletedJobFixtureCommand({
            argv: [
              process.execPath,
              resolve(import.meta.dir, "../index.ts"),
              "--path",
              root,
              ...args,
            ],
            cwd: root,
            env: {
              HOME: root,
              LANG: "C",
              PATH: `${root}:/usr/bin:/bin`,
              HACK_HOME: join(root, "home"),
              HACK_GLOBAL_CONFIG_PATH: join(root, "global.json"),
              HACK_CONFIG_COMPILER_BINARY: join(root, "compiler"),
              HACK_RUNTIME_BACKEND: "compose",
              HACK_LOGGER: "console",
              HACK_COMPOSE_STARTUP_TIMEOUT_MS: "1000",
              HACK_NATIVE_COMPOSE_PHASE_TRACE: "1",
              CI: "1",
              HACK_EXECUTION_MODE: "non_interactive",
            },
            captures: join(root, `trace-capture-${capture++}`),
            timeoutMs: 15_000,
            onUnconfirmed: retain,
          });
        } catch (error) {
          retain();
          throw error;
        }
        // The maintained owner returns only after captured exit, both EOFs and fresh
        // exact leader/group absence. Its observation file alone grants no cleanup.
        return {
          code: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      },
    });
  } finally {
    active = false;
    activeCases--;
  }
}

test(
  "ordinary source CLI one-off removal and final publication emit the shipping await order",
  async () =>
    await ownedCase(async (owner) => {
      const root = await fixture("", false, {
        noHooks: true,
        oneoff: true,
        cleanupAllowed: owner.cleanupAllowed,
      });
      const result = await owner.invoke(root, ["run", "web", "--", "true"]);
      expect(result.code).toBe(0);
      const rows = records(result.stderr);
      const phases = rows
        .filter((row) => row.boundary === "begin")
        .map((row) => row.phase);
      const removal = phases.indexOf("oneoff.post-remove-owned");
      expect(removal).toBeGreaterThanOrEqual(0);
      expect(phases.slice(removal)).toEqual([
        "oneoff.post-remove-owned",
        "finish.pending",
        "finalize.fresh",
        "finalize.generation",
        "finalize.owned",
        "finalize.remember-storage",
        "finalize.witnesses",
        "finalize.pending",
        "finalize.before-complete",
        "finalize.fresh",
        "finalize.generation",
        "finalize.owned",
        "finalize.remember-storage",
        "finalize.witnesses",
        "finalize.pending",
        "finalize.save",
      ]);
      expect(rows.every((row, index) => row.sequence === index + 1)).toBe(true);
      expect(rows.at(-1)).toMatchObject({
        phase: "finalize.save",
        boundary: "end",
      });
      expect(await Bun.file(join(root, "oneoff-removed")).exists()).toBe(true);
      const saved = await owner.invoke(root, ["ps", "--json"]);
      expect(saved.code).toBe(0);
      expect(JSON.parse(saved.stdout).data).toMatchObject({ pending: false });
      expect(JSON.stringify(rows)).not.toContain(root);
      expect(JSON.stringify(rows)).not.toContain("global");
    }),
  30_000
);

test(
  "a controlled shipping post-remove refusal records its last await and retains pending",
  async () =>
    await ownedCase(async (owner) => {
      const root = await fixture("", false, {
        noHooks: true,
        oneoff: true,
        cleanupAllowed: owner.cleanupAllowed,
      });
      await Bun.write(
        join(root, "trace-post-remove-refusal"),
        "synthetic controlled refusal"
      );
      const result = await owner.invoke(root, ["run", "web", "--", "true"]);
      expect(result.code).toBe(1);
      const rows = records(result.stderr);
      expect(rows.at(-1)).toMatchObject({
        phase: "oneoff.post-remove-owned",
        boundary: "fail",
      });
      expect(rows.some((row) => row.phase === "finalize.save")).toBe(false);
      expect(await Bun.file(join(root, "oneoff-removed")).exists()).toBe(true);
      // The controlled foreign bridge still refuses ps, so inspect saved state through
      // its existing owner only after restoring the stand-in's original policy.
      await Bun.file(join(root, "trace-post-remove-refusal")).delete();
      const saved = await owner.invoke(root, ["ps", "--json"]);
      expect(saved.code).toBe(0);
      expect(JSON.parse(saved.stdout).data).toMatchObject({ pending: true });
    }),
  30_000
);
