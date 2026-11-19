import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  execGaveUp,
  type JobResult,
  jobPollArgv,
  jobStartArgv,
  parseJobPoll,
  parsePhysFootprintBytes,
} from "../scripts/lib/runtime-bench-job.ts";
import { spawnSyncBounded } from "./helpers/bounded-spawn-sync.ts";

const fixture = join(
  import.meta.dir,
  "..",
  "scripts",
  "fixtures",
  "runtime-bench"
);

// The job scripts read the guest clock from /proc/uptime, so they run on Linux only.
describe.skipIf(process.platform !== "linux")("in a shell", () => {
  async function finish(id: string): Promise<JobResult | null> {
    let result: JobResult | null = null;
    for (let index = 0; index < 100 && result === null; index += 1) {
      await Bun.sleep(100);
      result = parseJobPoll(
        id,
        spawnSyncBounded(jobPollArgv(id), { timeout: 10_000 }).stdout.toString()
      );
    }
    return result;
  }

  test("a job runs detached and reports its own exit code and output", async () => {
    const id = "aaaaaaaa";
    // No newline ends either stream.
    const command = ["sh", "-c", "printf out; printf err >&2; exit 7"];
    expect(
      spawnSyncBounded(jobStartArgv(id, command), { timeout: 10_000 }).exitCode
    ).toBe(0);
    expect(await finish(id)).toMatchObject({
      exitCode: 7,
      stdout: "out",
      stderr: "err",
    });
  });

  test("a job still running does not leak into the next job", async () => {
    const slow = "bbbbbbbb";
    const fast = "cccccccc";
    const start = (id: string, script: string): number =>
      spawnSyncBounded(jobStartArgv(id, ["sh", "-c", script]), {
        timeout: 10_000,
      }).exitCode;
    expect(start(slow, "sleep 2; echo slow; exit 3")).toBe(0);
    expect(start(fast, "echo fast")).toBe(0);
    expect(await finish(fast)).toMatchObject({ exitCode: 0, stdout: "fast\n" });
    expect(await finish(slow)).toMatchObject({ exitCode: 3, stdout: "slow\n" });
  });
});

test("a poll reply is running, complete, or rejected", () => {
  const id = "0123abcd";
  const reply = (body: string): string => body.replaceAll("#", `#${id}:`);
  expect(parseJobPoll(id, reply("#running\n"))).toBeNull();
  expect(
    parseJobPoll(
      id,
      reply(
        "#exit\n0\n#start\n10.50\n#end\n12.75\n#err\n\n#out\n1 2 3\n\n#done\n"
      )
    )
  ).toEqual({ exitCode: 0, seconds: 2.25, stdout: "1 2 3\n", stderr: "" });
  // Output that looks like a marker, even this job's own, stays output.
  expect(
    parseJobPoll(
      id,
      `#${id}:exit\n1\n#${id}:start\n1\n#${id}:end\n2\n#${id}:err\n#${id}:exit\n#out\n#${id}:out\n#${id}:err\n#${id}:done\n`
    )
  ).toMatchObject({
    exitCode: 1,
    stderr: `#${id}:exit\n#out`,
    stdout: `#${id}:err`,
  });
  // A reply cut off before the end marker is not a result.
  expect(() =>
    parseJobPoll(id, reply("#exit\n0\n#start\n1\n#end\n2\n#err\n\n#out\n1\n"))
  ).toThrow();
  expect(() => parseJobPoll(id, "")).toThrow();
  // Another job's record is not this job's.
  expect(() =>
    parseJobPoll(
      "ffffffff",
      reply("#exit\n0\n#start\n1\n#end\n2\n#err\n\n#out\n\n#done\n")
    )
  ).toThrow();
  expect(() => jobStartArgv("../x", ["true"])).toThrow();
});

test("physical footprint is the kernel's figure, not the header or the peak", () => {
  const output = [
    "======================================================================",
    "vm [4242]: 64-bit    Footprint: 328501240 B (16384 bytes per page)",
    "======================================================================",
    "",
    "Auxiliary data:",
    "    phys_footprint: 927746040 B",
    "    phys_footprint_peak: 2216345600 B",
    "",
  ].join("\n");
  expect(parsePhysFootprintBytes(output)).toBe(927_746_040);
  expect(
    parsePhysFootprintBytes("vm [1]: 64-bit    Footprint: 1024 B\n")
  ).toBeNull();
  expect(
    parsePhysFootprintBytes("    phys_footprint_peak: 2216345600 B\n")
  ).toBeNull();
});

test("an exec that gave up is told apart from a command that failed", () => {
  expect(
    execGaveUp(
      "ERROR Native runtime request failed (graph_service_exec_uncertain); inspect"
    )
  ).toBe(true);
  expect(execGaveUp("rm: can't remove 'x': Directory not empty")).toBe(false);
});

test("the fixture descriptor names only services and paths the fixture has", () => {
  const bench = JSON.parse(readFileSync(join(fixture, "bench.json"), "utf8"));
  const compose = readFileSync(
    join(fixture, ".hack", "docker-compose.yml"),
    "utf8"
  );
  const services = [
    ...bench.services,
    ...bench.tasks.map((task: { service: string }) => task.service),
    bench.io.service,
  ];
  for (const service of services) {
    expect(compose).toContain(`\n  ${service}:\n`);
  }
  for (const route of [...bench.routes, bench.latency, ...bench.watch.probes]) {
    expect(compose).toContain(`caddy: ${route.host}\n`);
  }
  const watched = [
    bench.watch.file,
    ...bench.watch.probes.map((probe: { file?: string }) => probe.file),
  ].filter((file) => file !== undefined);
  for (const file of watched) {
    expect(() => readFileSync(join(fixture, file))).not.toThrow();
  }
  // The directory-watch probe must not move when the process restarts.
  const dev = readFileSync(join(fixture, "web", "dev.ts"), "utf8");
  expect(dev).not.toContain('from "./watched');
});
