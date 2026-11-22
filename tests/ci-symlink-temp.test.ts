import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "..");
const listPath = "scripts/test-shard-symlink-temp-files.json";

test("the fixed list names existing tracked tests and runs exactly those files", async () => {
  const selection = await Bun.file(resolve(repository, listPath)).text();
  const files: unknown = JSON.parse(selection);
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("The symlinked TMPDIR test list must be a nonempty array");
  }
  const result = Bun.spawnSync(
    [
      process.execPath,
      "scripts/test-shard.ts",
      "plan",
      "--shard=1/1",
      "--layout=full",
    ],
    {
      cwd: repository,
      env: { ...process.env, HACK_TEST_SELECTION: selection },
      timeout: 5000,
    }
  );
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString().trim().split("\n").sort()).toEqual(files);
});

test("the Linux variant runs the fixed list behind a real temp symlink and cleans up", async () => {
  const workflow = Bun.YAML.parse(
    await Bun.file(
      resolve(import.meta.dir, "../.github/workflows/ci.yml")
    ).text()
  ) as {
    jobs: Record<
      string,
      {
        steps: {
          name?: string;
          if?: string;
          run?: string;
          env?: Record<string, string>;
        }[];
      }
    >;
  };
  const steps = workflow.jobs["test-shard"]?.steps;
  const normal = steps?.find((entry) => entry.name === "Tests (shard)");
  expect(normal?.env?.HACK_TEST_SELECTION).toBe(
    "${{ needs.changes.outputs.test_files }}"
  );
  expect(normal?.run).not.toContain("TMPDIR");
  const step = steps?.find(
    (entry) => entry.name === "Tests (symlinked TMPDIR)"
  );
  expect(step?.if).toBe("matrix.shard == 8 && runner.os == 'Linux'");
  if (!step?.run) {
    throw new Error("Missing symlink temp variant");
  }
  const root = await mkdtemp(join(tmpdir(), "ci-symlink-test-"));
  try {
    const bin = join(root, "bin");
    const runner = join(root, "runner");
    await mkdir(bin);
    await mkdir(runner);
    await writeFile(
      join(bin, "bun"),
      `#!${process.execPath}
import { lstatSync, realpathSync } from "node:fs";
if (!lstatSync(process.env.TMPDIR).isSymbolicLink()) process.exit(2);
if (realpathSync(process.env.TMPDIR) === process.env.TMPDIR) process.exit(3);
console.log(JSON.stringify({ args: process.argv.slice(2), selection: process.env.HACK_TEST_SELECTION }));
process.exit(Number(process.env.STUB_EXIT));
`
    );
    await chmod(join(bin, "bun"), 0o700);
    for (const exit of [0, 7]) {
      const result = Bun.spawnSync(["bash", "-e", "-u", "-c", step.run], {
        cwd: repository,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          RUNNER_TEMP: runner,
          STUB_EXIT: String(exit),
          TMPDIR: runner,
          HACK_TEST_SELECTION: '["tests/example.test.ts"]',
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      });
      expect(result.exitCode, result.stderr.toString()).toBe(exit);
      expect(JSON.parse(result.stdout.toString())).toEqual({
        args: ["scripts/test-shard.ts", "run", "--shard=1/1", "--layout=full"],
        selection: (
          await Bun.file(resolve(repository, listPath)).text()
        ).trimEnd(),
      });
      expect(await readdir(runner)).toEqual([]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
