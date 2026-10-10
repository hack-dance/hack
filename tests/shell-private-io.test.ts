import { expect, test } from "bun:test";
import { constants, fstatSync } from "node:fs";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/lib/shell.ts";

test("private descriptor capture precedes spawn admission and run does not close caller FDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "shell-held-io-"));
  const inputPath = join(root, "input"),
    outPath = join(root, "output"),
    errPath = join(root, "error"),
    otherPath = join(root, "other");
  await Promise.all([
    writeFile(inputPath, "captured input"),
    writeFile(outPath, ""),
    writeFile(errPath, ""),
    writeFile(otherPath, ""),
  ]);
  const input = await open(inputPath, constants.O_RDONLY),
    output = await open(outPath, constants.O_RDWR),
    error = await open(errPath, constants.O_RDWR),
    other = await open(otherPath, constants.O_RDWR);
  const privateIo = { stdin: input.fd, stdout: output.fd, stderr: error.fd };
  try {
    expect(
      await run(["/bin/cat"], {
        privateIo,
        timeoutMs: 3000,
        beforeSpawn: () => {
          privateIo.stdout = other.fd;
        },
      })
    ).toBe(0);
    expect(await readFile(outPath, "utf8")).toBe("captured input");
    expect(await readFile(otherPath, "utf8")).toBe("");
    expect(fstatSync(input.fd).isFile()).toBe(true);
    expect(fstatSync(output.fd).isFile()).toBe(true);
  } finally {
    await Promise.all([
      input.close(),
      output.close(),
      error.close(),
      other.close(),
    ]);
    await rm(root, { recursive: true, force: true });
  }
});
test.each([
  "negative",
  "fractional",
  "unbounded",
  "tty",
] as const)("private IO %s refuses before admission", async (failure) => {
  let admitted = false;
  await expect(
    run(["/bin/cat"], {
      privateIo: {
        stdin: failure === "negative" ? -1 : failure === "fractional" ? 1.5 : 0,
        stdout: 1,
        stderr: 2,
      },
      timeoutMs: failure === "unbounded" ? undefined : 3000,
      forwardSignals: failure === "tty",
      beforeSpawn: () => {
        admitted = true;
      },
    })
  ).rejects.toThrow("Private subprocess descriptors");
  expect(admitted).toBe(false);
});
