import { expect, test } from "bun:test";
import { chmod, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNativeComposeOwnedFileChild } from "../src/lib/native-compose-file-command.ts";
import {
  nativeComposePreSpawnOwnershipTimeoutMs,
  nativeComposeStopChildReserveMs,
} from "../src/lib/native-compose-ownership.ts";
import { fixture, invoke } from "./helpers/native-compose-command.ts";

/**
 * In a native `down` the stop deadline is fixed first, and the last ownership
 * check runs after it. That check must not use up the time `compose down` needs:
 * an engine that answered at the last moment started a child that was killed
 * partway, where a clean refusal before any child is the safe result.
 */

/** Generous budget for the commands that set up each case. */
const SETUP_BUDGET_MS = 90_000;
const COMMAND_KILL_MS = 150_000;
/** Budget of the stop under test, which keeps a 2.8 s reserve for the child. */
const STOP_BUDGET_MS = 15_000;
/**
 * How long the check takes, whatever the host's load: longer than the 12.2 s it
 * may use, and short enough to end inside the budget. Without the reserve, the
 * check succeeds and `compose down` starts with too little time.
 */
const SLOW_CHECK_MS = 13_000;
/** Each case runs a few cold source CLI processes with synthetic Docker. */
const CASE_BUDGET_MS = 300_000;

test("the stop keeps a fifth of its budget above 1 s for the child, at most 5 s", () => {
  expect(nativeComposeStopChildReserveMs(1000)).toBe(0);
  expect(nativeComposeStopChildReserveMs(6000)).toBe(1000);
  expect(nativeComposeStopChildReserveMs(20_000)).toBe(3800);
  expect(nativeComposeStopChildReserveMs(26_000)).toBe(5000);
  expect(nativeComposeStopChildReserveMs(90_000)).toBe(5000);
});

test("the last ownership check uses the smaller of the probe bound and the admitted time", () => {
  const bound = nativeComposePreSpawnOwnershipTimeoutMs;
  // The reviewed case: a 20 s budget with 16.2 s admitted.
  expect(bound({ stopBudgetMs: 20_000, admittedMs: 16_200 })).toBe(16_200);
  // The probe's own bound still wins when more time is admitted.
  expect(bound({ stopBudgetMs: 90_000, admittedMs: 85_000 })).toBe(60_000);
  expect(bound({ stopBudgetMs: 10_000, admittedMs: 9000 })).toBe(9000);
  // No time left stays a valid probe bound, which refuses at once.
  expect(bound({ stopBudgetMs: 5000, admittedMs: 0 })).toBe(1);
  expect(bound({ stopBudgetMs: 5000, admittedMs: -40 })).toBe(1);
});

/** A child that leaves a marker, so a case can prove whether it started. */
async function childCase(
  run: (child: {
    readonly command: readonly string[];
    readonly options: { readonly cwd: string };
    readonly started: () => Promise<boolean>;
  }) => Promise<void>
) {
  const root = await mkdtemp(join(tmpdir(), "hack-stop-admission-"));
  const marker = join(root, "child-started");
  try {
    await run({
      command: [
        process.execPath,
        "-e",
        `await Bun.write(${JSON.stringify(marker)}, "")`,
      ],
      options: { cwd: root },
      started: () => Bun.file(marker).exists(),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the final guard is told the time that still leaves the child its minimum", async () => {
  await childCase(async ({ command, options, started }) => {
    const before = Date.now();
    const deadline = before + 60_000;
    let admitted = 0;
    const code = await runNativeComposeOwnedFileChild({
      command,
      options,
      arm: async () => {},
      assertOwned: async (admittedMs) => {
        admitted = admittedMs;
      },
      signal: new AbortController().signal,
      deadline: () => deadline,
      minimumChildMs: 10_000,
    });
    expect(code).toBe(0);
    expect(await started()).toBe(true);
    expect(admitted).toBeLessThanOrEqual(50_000);
    expect(admitted).toBeGreaterThan(0);
  });
});

test("a final guard that leaves the child less than its minimum starts no child", async () => {
  await childCase(async ({ command, options, started }) => {
    let deadline = Date.now() + 60_000;
    let guarded = false;
    await expect(
      runNativeComposeOwnedFileChild({
        command,
        options,
        arm: async () => {},
        assertOwned: async () => {
          guarded = true;
          // The guard returns before the deadline, inside the child's minimum.
          deadline = Date.now() + 5000;
        },
        signal: new AbortController().signal,
        deadline: () => deadline,
        minimumChildMs: 10_000,
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
    expect(guarded).toBe(true);
    expect(await started()).toBe(false);
  });
});

/** Docker reads and calls recorded by the stand-in, oldest first. */
async function requests(root: string): Promise<readonly string[][]> {
  const text = await Bun.file(join(root, "requests")).text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

const isContainerList = (args: readonly string[]) =>
  args[0] === "container" && args[1] === "ls";
const isComposeDown = (args: readonly string[]) =>
  args[0] === "compose" && args.includes("down");

async function runningFixture(): Promise<string> {
  const root = await fixture("", false, { noHooks: true });
  const up = await invoke(
    root,
    ["up", "--detach", "--json"],
    SETUP_BUDGET_MS,
    COMMAND_KILL_MS
  );
  expect(up.code, up.stderr).toBe(0);
  return root;
}

/** The 1-based first and last Docker reads of a healthy `down`'s last check. */
async function lastCheckReads(): Promise<{
  readonly first: number;
  readonly last: number;
}> {
  const root = await runningFixture();
  const seen = (await requests(root)).length;
  const down = await invoke(
    root,
    ["down", "--json"],
    SETUP_BUDGET_MS,
    COMMAND_KILL_MS
  );
  expect(down.code, down.stderr).toBe(0);
  const calls = (await requests(root)).slice(seen);
  const stop = calls.findIndex(isComposeDown);
  expect(stop).toBeGreaterThan(0);
  // The effect's own ownership query, then the last check under test.
  const before = calls.slice(0, stop);
  expect(before.filter(isContainerList).length).toBeGreaterThanOrEqual(2);
  return {
    first: before.findLastIndex(isContainerList) + 1,
    last: before.length,
  };
}

/**
 * Holds the check's last Docker read until the check has taken
 * {@link SLOW_CHECK_MS} since its first read, then runs the stand-in as usual. The
 * marker file proves the hold ran, so the case cannot pass without it.
 */
async function slowLastCheck(
  root: string,
  reads: { readonly first: number; readonly last: number }
) {
  const docker = join(root, "docker");
  const standIn = join(root, "docker-stand-in");
  const counter = join(root, "docker-reads");
  const began = join(root, "docker-check-began");
  const delayed = join(root, "docker-delay-ran");
  await rename(docker, standIn);
  await Bun.write(
    docker,
    `#!${process.execPath}
const args=process.argv.slice(2);
const file=Bun.file(${JSON.stringify(counter)});
const seen=(await file.exists()?Number(await file.text()):0)+1;
await Bun.write(${JSON.stringify(counter)},String(seen));
if(seen===${reads.first})await Bun.write(${JSON.stringify(began)},String(Date.now()));
if(seen===${reads.last}){await Bun.write(${JSON.stringify(delayed)},"");await Bun.sleep(Number(await Bun.file(${JSON.stringify(began)}).text())+${SLOW_CHECK_MS}-Date.now());}
const child=Bun.spawn([${JSON.stringify(standIn)},...args],{stdio:["inherit","inherit","inherit"]});
process.exit(await child.exited);
`
  );
  await chmod(docker, 0o700);
  return delayed;
}

test(
  "a slow last ownership check refuses down before compose down, and explicit recovery completes the stop",
  async () => {
    const reads = await lastCheckReads();
    const root = await runningFixture();
    const delayed = await slowLastCheck(root, reads);
    const seen = (await requests(root)).length;

    const refused = await invoke(
      root,
      ["down", "--json"],
      STOP_BUDGET_MS,
      COMMAND_KILL_MS
    );

    expect(await Bun.file(delayed).exists()).toBe(true);
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      ok: false,
      error: {
        detail: {
          native_compose_effect_refusal: {
            stage: "effect-execution",
            reason: "probe-timeout",
          },
        },
      },
    });
    const calls = (await requests(root)).slice(seen);
    expect(calls.some(isComposeDown)).toBe(false);
    expect(await Bun.file(join(root, "engine")).exists()).toBe(true);

    // The saved instance stays stoppable: explicit recovery completes the stop.
    const retried = await invoke(
      root,
      ["down", "--recover", "--json"],
      SETUP_BUDGET_MS,
      COMMAND_KILL_MS
    );
    expect(retried.code, retried.stdout).toBe(0);
    expect(await Bun.file(join(root, "engine")).exists()).toBe(false);
  },
  CASE_BUDGET_MS
);
