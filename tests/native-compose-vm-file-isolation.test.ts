import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureCompletedJobFixtureCommand,
  createCompletedJobFixtureSettlement,
} from "./e2e/scenarios/native-compose-adoption-job-worktrees.ts";

test("cached VM fixture imports restore each file's environment and owned roots", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "vm-file-isolation-"))
  );
  const settlement = createCompletedJobFixtureSettlement();
  try {
    const temporary = join(root, "tmp");
    await mkdir(temporary, { mode: 0o700 });
    const helper = join(import.meta.dir, "helpers/native-compose-vm-files.ts");
    const files: string[] = [];
    for (const name of ["first", "second"]) {
      const path = join(root, `${name}.test.ts`);
      files.push(path);
      await writeFile(
        path,
        `import {afterAll,afterEach,expect,test} from "bun:test";
import {lstat} from "node:fs/promises";
import {cleanupVmFileFixtures,vmFileFixture} from ${JSON.stringify(helper)};
afterEach(cleanupVmFileFixtures);
let fixtureRoot="";
test(${JSON.stringify(name)},async()=>{const fixture=await vmFileFixture();fixtureRoot=fixture.root;expect(process.env.HACK_HOME).toBe(fixture.root+"/home");expect(await lstat(fixture.root)).toBeDefined();});
afterAll(async()=>{expect(fixtureRoot).not.toBe("");expect(process.env.HACK_HOME).toBe("synthetic-baseline-home");expect(process.env.HOME).toBe(${JSON.stringify(root)});expect(process.env.PATH).toBe("/usr/bin:/bin");expect(process.env.DOCKER_HOST).toBeUndefined();expect(process.env.HACK_TEST_VM_ROOT).toBeUndefined();await expect(lstat(fixtureRoot)).rejects.toMatchObject({code:"ENOENT"});});
`,
        { mode: 0o600 }
      );
    }
    const result = await captureCompletedJobFixtureCommand({
      argv: [
        process.execPath,
        "--no-env-file",
        "test",
        ...files,
        "--timeout",
        "2000",
      ],
      cwd: root,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: root,
        HACK_HOME: "synthetic-baseline-home",
        TMPDIR: temporary,
      },
      captures: join(root, "child"),
      timeoutMs: 10_000,
      onUnconfirmed: settlement.markUnconfirmed,
    });
    settlement.assertConfirmed();
    expect(result.exitCode).toBe(0);
    expect(result.combined).toContain("2 pass");
    expect(result.combined).toContain("0 fail");
  } finally {
    settlement.assertConfirmed();
    await rm(root, { recursive: true, force: true });
  }
});
