import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beginNativeProjectFinalization } from "../src/backends/native-project-finalization.ts";
import { saveNativeProjectRun } from "../src/backends/native-project-run.ts";
import { readTimingLine, type TimingRecord } from "../src/lib/timing-record.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * HACK-2458. Native `hack down` and `hack ps` accept `--timings` and
 * `--timings-file` and join the runtime's `hack.timings/1` records under one
 * `command.total`, as native `hack up` does. These cases run the source CLI
 * against a stub runtime; nothing here starts a VM or a real runtime.
 */

const roots: string[] = [];
const entrypoint = resolve("index.ts");
const SPAWN_TIMEOUT_MS = 30_000;
const run = {
  run: "a".repeat(32),
  owner: "b".repeat(32),
  namespace: "c".repeat(64),
  planId: "d".repeat(64),
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

function snapshot() {
  return {
    receipt: {
      ...run,
      plan_id: run.planId,
      phase: "ready-observed",
      resources: {
        "container:web": {
          kind: "container",
          key: "web",
          id: "e".repeat(64),
          phase: "started",
        },
      },
    },
    journal_incomplete: false,
    observations: {
      "container:web": { state: "running", health: "healthy" },
    },
  };
}

/**
 * The stub records each request and, when given a timing context, sends one
 * runtime record on the transferred descriptor, as the Rust runtime does.
 */
function stubSource(root: string): string {
  const stopped = { ...snapshot() };
  stopped.receipt = { ...stopped.receipt, phase: "stopped-data-retained" };
  stopped.observations = { "container:web": { state: "absent" } } as never;
  return `#!${process.execPath}
import { appendFileSync, existsSync, writeFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
const root = ${JSON.stringify(root)};
const args = process.argv.slice(2);
const flag = args[0]?.startsWith("--internal-timings=") ? args.shift() : undefined;
appendFileSync(root + "/calls", JSON.stringify({ timed: Boolean(flag), args: args.slice(2) }) + "\\n");
if (flag) {
  const [fd, trace, parent, spawn] = flag.slice("--internal-timings=".length).split(":");
  let span;
  do { span = randomBytes(8).toString("hex"); } while (/^0+$/.test(span));
  writeSync(Number(fd), JSON.stringify({
    schema: "hack.timings/1", trace, parent, span, proc: "runtime",
    clock: "host", origin_unix_us: Date.now() * 1000,
    origin_mono_us: Number(spawn), step: "runtime.dispatch",
    start_us: 0, dur_us: 1, outcome: "ok", attrs: {},
  }) + "\\n");
}
const marker = root + "/cleaned";
if (args.includes("cleanup")) {
  writeFileSync(marker, "yes");
  console.log("{}");
} else {
  console.log(JSON.stringify(existsSync(marker) ? ${JSON.stringify(stopped)} : ${JSON.stringify(snapshot())}));
}
`;
}

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-down-ps-timings-"))
  );
  roots.push(root);
  const projectRoot = join(root, "project");
  const projectDir = join(projectRoot, ".hack");
  const nativeHome = join(root, "native-home");
  await mkdir(projectDir, { recursive: true });
  await mkdir(nativeHome, { mode: 0o700 });
  await writeFile(
    join(projectDir, "hack.config.json"),
    JSON.stringify({ name: "timings-fixture" })
  );
  await writeFile(
    join(projectDir, "docker-compose.yml"),
    "services:\n  web:\n    image: fixture\n"
  );
  const scope = { projectRoot, projectDir, nativeHome, branch: null };
  await saveNativeProjectRun({ ...scope, run });
  const finalization = await beginNativeProjectFinalization({ scope, run });
  await finalization.complete();
  const binary = join(root, "native-runtime");
  await writeFile(binary, stubSource(root), { mode: 0o700 });
  const env = (backend: "native" | "compose") =>
    privateCliEnv({
      root,
      env: {
        HACK_RUNTIME_BACKEND: backend,
        HACK_NATIVE_BINARY: binary,
        HACK_NATIVE_HOME: nativeHome,
        HACK_NO_INTERACTIVE: "1",
        HACK_LOGGER: "console",
      },
    });
  return {
    root,
    projectRoot,
    async hack(
      args: readonly string[],
      backend: "native" | "compose" = "native"
    ) {
      const child = Bun.spawn(
        [process.execPath, entrypoint, ...args, "--path", projectRoot],
        {
          cwd: root,
          env: env(backend),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          timeout: SPAWN_TIMEOUT_MS - 5000,
        }
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, code };
    },
    async calls(): Promise<{ timed: boolean; args: string[] }[]> {
      return (await readFile(join(root, "calls"), "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
  };
}

async function readRecords(file: string): Promise<TimingRecord[]> {
  const lines = (await readFile(file, "utf8")).trim().split("\n");
  const records = lines.map(readTimingLine);
  expect(records.every(Boolean)).toBe(true);
  return records as TimingRecord[];
}

/** One trace: a CLI root and every runtime record parented to that root. */
function expectJoined(records: readonly TimingRecord[]) {
  const roots = records.filter((record) => record.step === "command.total");
  expect(roots).toHaveLength(1);
  const root = roots[0] as TimingRecord;
  expect(root).toMatchObject({ parent: null, proc: "cli", outcome: "ok" });
  const runtime = records.filter((record) => record.proc === "runtime");
  expect(runtime.length).toBeGreaterThan(0);
  for (const record of records) {
    expect(record.trace).toBe(root.trace);
  }
  for (const record of runtime) {
    expect(record).toMatchObject({
      step: "runtime.dispatch",
      parent: root.span,
    });
  }
}

test(
  "native ps --timings-file joins runtime records; flag off sends no timing context",
  async () => {
    const f = await fixture();
    const plain = await f.hack(["ps"]);
    expect(plain.code).toBe(0);
    expect(plain.stderr).not.toContain("timeline");
    const plainCalls = await f.calls();
    expect(plainCalls.length).toBeGreaterThan(0);
    expect(plainCalls.every((call) => !call.timed)).toBe(true);

    const file = join(f.root, "ps.jsonl");
    const timed = await f.hack(["ps", "--timings-file", file]);
    expect(timed.code).toBe(0);
    expect(timed.stdout).toBe(plain.stdout);
    expect(timed.stderr).not.toContain("timeline");
    const timedCalls = (await f.calls()).slice(plainCalls.length);
    expect(timedCalls.length).toBeGreaterThan(0);
    expect(timedCalls.every((call) => call.timed)).toBe(true);
    expectJoined(await readRecords(file));

    const printed = await f.hack(["ps", "--json", "--timings"]);
    expect(printed.code).toBe(0);
    expect(JSON.parse(printed.stdout)).toBeDefined();
    expect(printed.stderr).toMatch(
      /^Status timeline \(\d+\.\d ms\)\n(?: {2}\+\d+\.\d ms {2}runtime\.dispatch {2}0\.0 ms {2}ok\n)+$/
    );
  },
  SPAWN_TIMEOUT_MS
);

test(
  "native down --timings prints the stop timeline and --timings-file keeps the records",
  async () => {
    const f = await fixture();
    const file = join(f.root, "down.jsonl");
    const down = await f.hack(["down", "--timings", "--timings-file", file]);
    expect(down.code).toBe(0);
    expect(down.stdout).toMatch(/stopped/);
    expect(down.stderr).toMatch(/^Stop timeline \(\d+\.\d ms\)\n/);
    expect(down.stderr).toContain("runtime.dispatch");
    const records = await readRecords(file);
    expectJoined(records);
    expect(
      (await f.calls()).some((call) => call.args.includes("cleanup"))
    ).toBe(true);

    // A second file at the same path is refused without changing the result.
    const again = await f.hack(["down", "--json", "--timings-file", file]);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ backend: "native" });
    expect(again.stderr).toBe("Could not create the timings file.\n");
    expect(await readRecords(file)).toEqual(records);
  },
  SPAWN_TIMEOUT_MS
);

test(
  "timing flags on down and ps refuse the Compose backend before any work",
  async () => {
    const f = await fixture();
    for (const args of [
      ["ps", "--timings"],
      ["down", "--timings-file", join(f.root, "never.jsonl")],
    ]) {
      const result = await f.hack(args, "compose");
      expect(result.code).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(
        "--timings and --timings-file require the native backend."
      );
    }
    expect(await f.calls()).toEqual([]);
  },
  SPAWN_TIMEOUT_MS
);
