import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withDependencyStartupProgress } from "../src/lib/dependency-startup-progress.ts";
import { canReuseRunningDependencyCache } from "../src/lib/run-dependency-cache.ts";

/**
 * HACK-1273: the `HACK_ENV_*` values that the generated Compose env override
 * references belong to `docker compose` invocations that read that file. The
 * other docker children Hack starts around Compose must not receive them.
 */
const CANARY = "g5-least-privilege-canary";
const ID = "c".repeat(64);
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

type Recorded = {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
};

/** A `docker` stand-in that records each invocation's argv and environment. */
async function recordingDocker(): Promise<{
  readonly dir: string;
  readonly calls: () => Promise<Recorded[]>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "hack-env-least-privilege-"));
  dirs.push(dir);
  const record = join(dir, "calls.jsonl");
  const docker = join(dir, "docker");
  await writeFile(
    docker,
    `#!${process.execPath}
import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(record)}, JSON.stringify({args: process.argv.slice(2), env: process.env}) + '\\n');
if (process.argv[2] === 'inspect' && process.argv.includes(${JSON.stringify(ID)})) {
  console.log(JSON.stringify({id: ${JSON.stringify(ID)}, running: true, project: 'fixture', service: 'deps', mounts: [{Type: 'volume', Name: 'cache'}]}));
}
process.exit(0);
`
  );
  await chmod(docker, 0o700);
  return {
    dir,
    calls: async () =>
      (await readFile(record, "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Recorded),
  };
}

function composeEnv(dir: string): Record<string, string> {
  return {
    PATH: `${dir}:/usr/bin:/bin`,
    GLOBAL_FLAG: "kept",
    HACK_ENV_0123456789AB_SECRET: CANARY,
    HACK_ENV_0123456789AB: CANARY,
  };
}

function expectNoReferenceValues(calls: readonly Recorded[]): void {
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.env.GLOBAL_FLAG).toBe("kept");
    expect(
      Object.keys(call.env).filter((key) => key.startsWith("HACK_ENV_"))
    ).toEqual([]);
    expect(JSON.stringify(call.env)).not.toContain(CANARY);
  }
}

test("dependency progress observers get the Compose env without its HACK_ENV_ reference values", async () => {
  const docker = await recordingDocker();
  const result = await withDependencyStartupProgress({
    services: ["deps"],
    project: "fixture",
    cwd: docker.dir,
    env: composeEnv(docker.dir),
    onPhase: () => undefined,
    run: async () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if ((await docker.calls()).length > 0) {
          break;
        }
        await Bun.sleep(25);
      }
      return 7;
    },
  });
  expect(result).toBe(7);
  const calls = await docker.calls();
  expect(calls.some((call) => call.args[0] === "events")).toBe(true);
  expectNoReferenceValues(calls);
});

test("the dependency cache reuse probe gets the Compose env without its HACK_ENV_ reference values", async () => {
  const docker = await recordingDocker();
  expect(
    await canReuseRunningDependencyCache({
      containerId: ID,
      composeProject: "fixture",
      service: "deps",
      volumeNames: ["cache"],
      cwd: docker.dir,
      env: composeEnv(docker.dir),
    })
  ).toBe(true);
  const calls = await docker.calls();
  expect(calls.map((call) => call.args[0])).toEqual(["inspect"]);
  expectNoReferenceValues(calls);
});
