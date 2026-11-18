import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import cliPackage from "../packages/cli/package.json";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * Startup budget for the compiled CLI (`hack --version`).
 *
 * The budget is CPU time (user plus system) of the process, not wall time:
 * CPU time stays put when the runner is busy, where wall time does not. It is
 * compared with the CPU time of a fixed JavaScript workload on the same
 * runner, so a slower machine moves both numbers together.
 *
 * Reference (Linux build host, Nov 2026): the CLI uses about 0.9x the
 * yardstick's CPU with the bytecode cache and about 3.7x without it. The
 * limit of 1.8x fails a regression of two times or more and passes noise.
 * If a deliberate change needs more, measure it with
 * `scripts/benchmark-cli-latency.ts` and move the limit in the same PR.
 */
const STARTUP_CPU_LIMIT_RATIO = 1.8;
const CLI_RUNS = 9;
const YARDSTICK_RUNS = 5;

/** About 100 ms of single-thread JavaScript on the reference host. */
const YARDSTICK = `
let seed = 1;
const rows = Array.from({ length: 4000 }, (_, i) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return { id: i, name: "row-" + seed.toString(36), tags: [seed % 7, seed % 11, seed % 13] };
});
let total = 0;
for (let round = 0; round < 36; round += 1) {
  const copy = JSON.parse(JSON.stringify(rows));
  copy.sort((a, b) => (a.name < b.name ? -1 : 1));
  total += copy[round].id;
}
process.stdout.write(String(total));
`;

const repository = resolve(import.meta.dir, "..");
let root = "";
let binary = "";

/** The compile flags of `bun run build`, so the test measures what ships. */
function buildFlags(): string[] {
  const script = cliPackage.scripts.build;
  const start = script.indexOf("bun build index.ts ");
  const end = script.indexOf(" --outfile ");
  if (start < 0 || end < start) {
    throw new Error("packages/cli build script no longer compiles index.ts.");
  }
  return script
    .slice(start + "bun build index.ts ".length, end)
    .split(" ")
    .filter(Boolean);
}

async function cpuMs(argv: string[]): Promise<number> {
  const child = Bun.spawn(argv, {
    cwd: root,
    env: privateCliEnv({ root }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });
  const [code, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0 || stdout.length === 0) {
    throw new Error(`Startup probe failed with exit ${code}.`);
  }
  const usage = child.resourceUsage();
  if (!usage) {
    throw new Error("Startup probe reported no resource usage.");
  }
  return (Number(usage.cpuTime.user) + Number(usage.cpuTime.system)) / 1000;
}

async function medianCpuMs(argv: string[], runs: number): Promise<number> {
  // One unmeasured run pays first-use costs of a new executable.
  await cpuMs(argv);
  const samples: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    samples.push(await cpuMs(argv));
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] as number;
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "hack-startup-budget-")));
  binary = join(root, "hack");
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "build",
      "index.ts",
      ...buildFlags(),
      "--outfile",
      binary,
    ],
    {
      cwd: repository,
      env: privateCliEnv({ root }),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
    }
  );
  const [code, , stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`CLI build failed: ${stderr.slice(-400)}`);
  }
}, 180_000);

afterAll(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
  }
});

test("every CLI build compiles with the bytecode cache", async () => {
  expect(buildFlags()).toEqual(
    expect.arrayContaining(["--compile", "--bytecode", "--format=esm"])
  );
  const release = await readFile(
    join(repository, "scripts/build-release.ts"),
    "utf8"
  );
  expect(release).toContain('"--bytecode"');
  expect(release).toContain('"--format=esm"');
  const candidate = await readFile(
    join(repository, "scripts/build-native-candidate.sh"),
    "utf8"
  );
  const compiles = candidate
    .split("\n")
    .filter((line) => line.includes("bun build index.ts --compile"));
  expect(compiles.length).toBeGreaterThan(0);
  for (const line of compiles) {
    expect(line).toContain("--bytecode --format=esm");
  }
});

test("hack --version stays inside its startup CPU budget", async () => {
  const yardstick = await medianCpuMs(
    [process.execPath, "--no-env-file", "-e", YARDSTICK],
    YARDSTICK_RUNS
  );
  const cli = await medianCpuMs([binary, "--version"], CLI_RUNS);
  const ratio = cli / yardstick;
  // The numbers are the evidence when this fails.
  console.info(
    `startup budget: cli ${cli.toFixed(1)} ms CPU, yardstick ${yardstick.toFixed(1)} ms CPU, ratio ${ratio.toFixed(2)} (limit ${STARTUP_CPU_LIMIT_RATIO})`
  );
  expect(yardstick).toBeGreaterThan(20);
  expect(ratio).toBeLessThan(STARTUP_CPU_LIMIT_RATIO);
}, 120_000);
