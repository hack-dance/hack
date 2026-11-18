import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  execGaveUp,
  type JobResult,
  jobPollArgv,
  jobStartArgv,
  parseJobPoll,
} from "../scripts/lib/runtime-bench-job.ts";

const fixture = join(
  import.meta.dir,
  "..",
  "scripts",
  "fixtures",
  "runtime-bench"
);

// The job scripts read the guest clock from /proc/uptime, so they run on Linux only.
test.skipIf(process.platform !== "linux")(
  "a job runs detached and reports its own exit code",
  async () => {
    const start = Bun.spawnSync(
      jobStartArgv(["sh", "-c", "echo out; echo err >&2; exit 7"])
    );
    expect(start.exitCode).toBe(0);
    let result: JobResult | null = null;
    for (let index = 0; index < 50 && result === null; index += 1) {
      await Bun.sleep(100);
      result = parseJobPoll(Bun.spawnSync(jobPollArgv()).stdout.toString());
    }
    expect(result?.exitCode).toBe(7);
    expect(result?.stdout.trim()).toBe("out");
    expect(result?.stderr.trim()).toBe("err");
  }
);

test("a poll reply is running, complete, or rejected", () => {
  expect(parseJobPoll("#running\n")).toBeNull();
  expect(
    parseJobPoll("#exit\n0\n#start\n10.50\n#end\n12.75\n#err\n\n#out\n1 2 3\n")
  ).toEqual({ exitCode: 0, seconds: 2.25, stdout: "1 2 3\n", stderr: "" });
  // Output that repeats a marker stays output.
  expect(
    parseJobPoll("#exit\n1\n#start\n1\n#end\n2\n#err\n#exit\n#out\n#err\n")
  ).toMatchObject({ exitCode: 1, stderr: "#exit", stdout: "#err\n" });
  // A reply cut off before the last section is not a result.
  expect(() => parseJobPoll("#exit\n0\n#start\n10.50\n")).toThrow();
  expect(() => parseJobPoll("")).toThrow();
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
  expect(() => readFileSync(join(fixture, bench.watch.file))).not.toThrow();
});
