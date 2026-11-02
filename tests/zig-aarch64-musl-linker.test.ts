import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "../src/lib/shell.ts";

async function argumentsPassedToZig(input: readonly string[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zig-linker-")));
  const capture = join(root, "arguments");
  await writeFile(
    join(root, "zig"),
    '#!/bin/sh\nset -eu\nprintf \'%s\\000\' "$@" > "$ZIG_ARGUMENTS"\n',
    { mode: 0o700 }
  );
  let group: number | undefined;
  let absent = false;
  try {
    const code = await run(
      ["/bin/sh", resolve("scripts/zig-aarch64-musl-linker"), ...input],
      {
        env: { PATH: root, ZIG_ARGUMENTS: capture },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        timeoutMs: 5000,
        onSpawn(event) {
          group = event.ownsProcessGroup
            ? (event.processGroupId ?? event.pid)
            : undefined;
          return Promise.resolve();
        },
      }
    );
    expect(code).toBe(0);
    expect(group).toBeDefined();
    if (group === undefined) {
      throw new Error("Missing owned group");
    }
    try {
      process.kill(-group, 0);
    } catch (error) {
      absent =
        error instanceof Error && "code" in error && error.code === "ESRCH";
    }
    expect(absent).toBe(true);
    return (await readFile(capture, "utf8")).split("\0").slice(0, -1);
  } finally {
    if (absent) {
      await rm(root, { recursive: true });
    }
  }
}

test("cc-rs Rust target uses the wrapper's fixed Zig target", async () => {
  expect(
    await argumentsPassedToZig([
      "-O3",
      "--target=aarch64-unknown-linux-musl",
      "-I",
      "include path",
      "-Wl,-O1",
      "-c",
      "source file.c",
    ])
  ).toEqual([
    "cc",
    "-target",
    "aarch64-linux-musl",
    "-O3",
    "-I",
    "include path",
    "-c",
    "source file.c",
  ]);
});

test("other target and linker arguments retain their exact order and bytes", async () => {
  const input = [
    "--target=x86_64-unknown-linux-musl",
    "-Wl,-O2",
    "-Wl,-O1,other",
    "literal $(not-a-command)",
    "",
  ];
  expect(await argumentsPassedToZig(input)).toEqual([
    "cc",
    "-target",
    "aarch64-linux-musl",
    ...input,
  ]);
});
