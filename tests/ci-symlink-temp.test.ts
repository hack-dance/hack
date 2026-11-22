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

test("the Linux variant runs one selected shard behind a real temp symlink and cleans up", async () => {
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
  const step = workflow.jobs["test-shard"]?.steps.find(
    (entry) => entry.name === "Tests (shard)"
  );
  expect(step?.env?.HACK_TEST_SYMLINK_TMP).toBe(
    "${{ matrix.shard == 8 && runner.os == 'Linux' }}"
  );
  expect(step?.env?.HACK_TEST_SELECTION).toBe(
    "${{ needs.changes.outputs.test_files }}"
  );
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
if (lstatSync(process.env.TMPDIR).isSymbolicLink() !== (process.env.STUB_SYMLINK === "true")) process.exit(2);
if (process.env.STUB_SYMLINK === "true" && realpathSync(process.env.TMPDIR) === process.env.TMPDIR) process.exit(3);
console.log(JSON.stringify({ args: process.argv.slice(2), selection: process.env.HACK_TEST_SELECTION }));
process.exit(Number(process.env.STUB_EXIT));
`
    );
    await chmod(join(bin, "bun"), 0o700);
    for (const [symlink, exit] of [
      [true, 0],
      [true, 7],
      [false, 0],
      [false, 7],
    ] as const) {
      const result = Bun.spawnSync(["bash", "-e", "-u", "-c", step.run], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          RUNNER_TEMP: runner,
          STUB_EXIT: String(exit),
          HACK_TEST_LAYOUT: "pooled",
          HACK_TEST_SHARD: symlink ? "8/8" : "7/8",
          HACK_TEST_SYMLINK_TMP: String(symlink),
          STUB_SYMLINK: String(symlink),
          TMPDIR: runner,
          HACK_TEST_SELECTION: '["tests/example.test.ts"]',
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      });
      expect(result.exitCode, result.stderr.toString()).toBe(exit);
      expect(JSON.parse(result.stdout.toString())).toEqual({
        args: [
          "scripts/test-shard.ts",
          "run",
          symlink ? "--shard=8/8" : "--shard=7/8",
          "--layout=pooled",
          `--durations-out=${runner}/test-shard-durations.json`,
        ],
        selection: '["tests/example.test.ts"]',
      });
      expect(await readdir(runner)).toEqual([]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
