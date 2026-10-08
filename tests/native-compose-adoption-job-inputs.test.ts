import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planLegacyComposeAdoption } from "../src/lib/native-compose-adoption-plan.ts";
import { legacyComposeRetainedPlan } from "../src/lib/native-compose-adoption-readiness.ts";
import { literalComposeArg } from "../src/lib/native-config-import-argv.ts";
import { mapLegacyNativeStorageAdoption } from "../src/lib/native-config-import-plan.ts";
import {
  COMPLETED_JOB_APP_PROGRAM,
  completedJobFixtureProgram,
  completedJobFixtureSources,
} from "./e2e/scenarios/native-compose-adoption-job-inputs.ts";

const IMAGE = `sha256:${"a".repeat(64)}`;

describe("maintained completed-job authored fixture", () => {
  test("uses only the closed static family with an explicit completion role", () => {
    const source = completedJobFixtureSources({
      name: "job-fixture-alpha",
      image: IMAGE,
      marker: "alpha-seed",
    });
    expect(source.config.worktree).toEqual({
      auto_branch: false,
      inherit_local: false,
    });
    const inputs = {
      configText: JSON.stringify(source.config),
      composeText: JSON.stringify(source.compose),
    };
    const mapped = mapLegacyNativeStorageAdoption(inputs);
    expect(mapped.report.complete).toBe(true);
    expect(mapped.candidate).toHaveProperty("jobs.seed");
    expect(mapped.candidate).toHaveProperty("jobs.seed.command.exec", [
      "/bin/sh",
      "-c",
      completedJobFixtureProgram("alpha-seed"),
    ]);
    expect(mapped.candidate).toHaveProperty("services.app.command.exec", [
      "/bin/sh",
      "-c",
      COMPLETED_JOB_APP_PROGRAM,
    ]);
    expect(legacyComposeRetainedPlan(mapped.candidate).requiresV7).toBe(true);
    const planned = planLegacyComposeAdoption(inputs);
    expect(planned.report.supported).toBe(true);
    expect(planned.intent?.services).toEqual(["app", "db", "seed"]);
    expect(Object.hasOwn(source.config, "dev_host")).toBe(false);
    expect(source.compose.services.seed.labels).toEqual({
      "hack.service.one-shot": "true",
    });
    expect(source.compose.services.seed.depends_on).toEqual({
      db: { condition: "service_healthy" },
    });
    expect(source.compose.services.app.depends_on).toEqual({
      seed: { condition: "service_completed_successfully" },
    });
    expect(source.compose.volumes).toEqual({
      data: { name: "job-fixture-alpha_data" },
    });
    for (const workload of Object.values(source.compose.services)) {
      expect(workload.image).toBe(IMAGE);
      expect(workload.pull_policy).toBe("never");
      expect(Object.hasOwn(workload, "ports")).toBe(false);
      expect(Object.hasOwn(workload, "restart")).toBe(false);
      expect(Object.hasOwn(workload, "env_file")).toBe(false);
      expect(Object.hasOwn(workload, "profiles")).toBe(false);
    }
    expect(source.compose.services.seed.volumes).toEqual([
      "data:/var/lib/postgresql/data:ro",
    ]);
    expect(source.compose.services.app.volumes).toEqual([
      "data:/var/lib/postgresql/data:ro",
    ]);
  });

  test("keeps seed retention distinct from new attempt and dependent counters", () => {
    const program = completedJobFixtureProgram("alpha-seed");
    expect(program).toContain(
      "INSERT INTO job_attempts DEFAULT VALUES RETURNING id"
    );
    expect(program).toContain(
      "INSERT INTO marker VALUES(1,'alpha-seed') ON CONFLICT(id) DO NOTHING"
    );
    expect(program).not.toContain("DO UPDATE");
    expect(program).toContain('if [ "$attempt" = 1 ]; then');
    expect(program).toContain("\"$retained\" = 'alpha-seed' ] || exit 47");
    expect(program).toContain("fail) exit 17");
    expect(program).toContain("hold) trap 'exit 0' TERM");
    expect(COMPLETED_JOB_APP_PROGRAM).toContain(
      "INSERT INTO app_starts(attempt) VALUES($attempt)"
    );
    expect(COMPLETED_JOB_APP_PROGRAM).toContain(
      '"$attempt" = "$successful" ] || exit 49'
    );
    expect(COMPLETED_JOB_APP_PROGRAM).not.toContain("INSERT INTO marker");
  });

  test("doubles Compose dollars once without changing private command intent", () => {
    const program = completedJobFixtureProgram("alpha-seed");
    const source = completedJobFixtureSources({
      name: "job-fixture-alpha",
      image: IMAGE,
      marker: "alpha-seed",
    });
    expect(source.compose.services.seed.entrypoint).toEqual([]);
    expect(source.compose.services.seed.command.slice(0, 2)).toEqual([
      "/bin/sh",
      "-c",
    ]);
    expect(source.compose.services.seed.command[2]).not.toBe(program);
    expect(literalComposeArg(source.compose.services.seed.command[2])).toBe(
      program
    );
    expect(literalComposeArg(source.compose.services.app.command[2])).toBe(
      COMPLETED_JOB_APP_PROGRAM
    );
    // The original replacement-string spelling is a negative control: JS consumes its $$ escape.
    expect(literalComposeArg(program.replaceAll("$", "$$"))).toBeUndefined();
  });

  test.each([
    "bad'; DROP TABLE marker; --",
    "",
    "a".repeat(64),
  ])("rejects unsafe synthetic marker %s before producing SQL", (marker) => {
    expect(() => completedJobFixtureProgram(marker)).toThrow(
      "Completed-job fixture inputs refused; values omitted."
    );
  });

  test.each([
    { attempt: "1", marker: "", code: 0, inserts: 1 },
    { attempt: "2", marker: "alpha-seed", code: 0, inserts: 0 },
    { attempt: "2", marker: "", code: 47, inserts: 0 },
    { attempt: "2", marker: "different-seed", code: 47, inserts: 0 },
  ])("the actual repeated program cannot repair a missing or changed seed ($attempt/$marker)", async (entry) => {
    const root = await mkdtemp(join(tmpdir(), "completed-job-program-"));
    try {
      const client = join(root, "psql");
      const trace = join(root, "trace");
      await Bun.write(
        client,
        `#!/bin/sh\nset -eu\nfor value do query="$value"; done\nprintf '%s\\n' "$query" >> "$TRACE"\ncase "$query" in\n  'INSERT INTO job_attempts DEFAULT VALUES RETURNING id') printf '%s\\n' "$ATTEMPT" ;;\n  'SELECT mode FROM control WHERE id=1') printf '%s\\n' success ;;\n  'SELECT value FROM marker WHERE id=1') printf '%s\\n' "$RETAINED" ;;\nesac\n`
      );
      await chmod(client, 0o700);
      const child = Bun.spawn(
        ["/bin/sh", "-c", completedJobFixtureProgram("alpha-seed")],
        {
          env: {
            PATH: root,
            TRACE: trace,
            ATTEMPT: entry.attempt,
            RETAINED: entry.marker,
          },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }
      );
      expect(await child.exited).toBe(entry.code);
      expect(
        (await readFile(trace, "utf8"))
          .split("\n")
          .filter((line) => line.startsWith("INSERT INTO marker VALUES"))
      ).toHaveLength(entry.inserts);
      expect(
        (await readFile(trace, "utf8"))
          .split("\n")
          .filter((line) => line.startsWith("INSERT INTO job_successes VALUES"))
      ).toHaveLength(entry.code === 0 ? 1 : 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    { attempt: "7", successful: "7", code: 0, inserts: 1 },
    { attempt: "7", successful: "4", code: 49, inserts: 0 },
    { attempt: "7", successful: "", code: 49, inserts: 0 },
  ])("the dependent rejects an earlier job success ($attempt/$successful)", async (entry) => {
    const root = await mkdtemp(join(tmpdir(), "completed-job-dependent-"));
    try {
      const client = join(root, "psql"),
        trace = join(root, "trace");
      await Bun.write(
        client,
        `#!/bin/sh\nset -eu\nfor value do query="$value"; done\nprintf '%s\\n' "$query" >> "$TRACE"\ncase "$query" in\n  'SELECT MAX(id) FROM job_attempts') printf '%s\\n' "$ATTEMPT" ;;\n  'SELECT MAX(attempt) FROM job_successes') printf '%s\\n' "$SUCCESSFUL" ;;\n  'INSERT INTO app_starts(attempt) VALUES(7)') exit 23 ;;\nesac\n`
      );
      await chmod(client, 0o700);
      const child = Bun.spawn(["/bin/sh", "-c", COMPLETED_JOB_APP_PROGRAM], {
        env: {
          PATH: root,
          TRACE: trace,
          ATTEMPT: entry.attempt,
          SUCCESSFUL: entry.successful,
        },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(await child.exited).toBe(entry.inserts === 1 ? 23 : entry.code);
      expect(
        (await readFile(trace, "utf8"))
          .split("\n")
          .filter((line) => line.startsWith("INSERT INTO app_starts"))
      ).toHaveLength(entry.inserts);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
