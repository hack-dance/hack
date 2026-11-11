import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXEC_STDOUT_OVERFLOW_EXIT, exec } from "../src/lib/shell.ts";
import { readSingleRegularFileFromTar } from "../src/lib/single-file-tar.ts";
import { CURRENT_CA_PEM } from "./helpers/ca-certificates.ts";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function realTar(format: string): Promise<Uint8Array> {
  const directory = await mkdtemp(join(tmpdir(), "hack-tar-test-"));
  directories.push(directory);
  await writeFile(join(directory, "root.crt"), CURRENT_CA_PEM);
  const result = await exec(
    ["tar", `--format=${format}`, "-C", directory, "-cf", "-", "root.crt"],
    { stdin: "ignore", timeoutMs: 5000, maxStdoutBytes: 1_000_000 }
  );
  expect(result.exitCode).toBe(0);
  return Buffer.from(result.stdout, "latin1");
}

const tarAvailable = Bun.which("tar") !== null;

for (const format of ["ustar", "pax", "gnu"]) {
  test.skipIf(!tarAvailable)(
    `reads the single file from a real ${format} archive`,
    async () => {
      const content = readSingleRegularFileFromTar({
        archive: await realTar(format),
        name: "root.crt",
        maxBytes: 65_536,
      });
      expect(Buffer.from(content ?? new Uint8Array()).toString("utf8")).toBe(
        CURRENT_CA_PEM
      );
    }
  );
}

test.skipIf(!tarAvailable)(
  "refuses a real archive over the size budget",
  async () => {
    expect(
      readSingleRegularFileFromTar({
        archive: await realTar("ustar"),
        name: "root.crt",
        maxBytes: 16,
      })
    ).toBeNull();
  }
);

test("refuses empty and all-zero input", () => {
  for (const archive of [new Uint8Array(), new Uint8Array(1024)]) {
    expect(
      readSingleRegularFileFromTar({ archive, name: "root.crt", maxBytes: 1 })
    ).toBeNull();
  }
});

test("exec stdout budget keeps bytes exact and kills on overflow", async () => {
  const exact = await exec(["printf", "\\000\\377a"], {
    stdin: "ignore",
    timeoutMs: 5000,
    maxStdoutBytes: 3,
  });
  expect(exact.exitCode).toBe(0);
  expect([...Buffer.from(exact.stdout, "latin1")]).toEqual([0, 255, 97]);

  const over = await exec(["yes"], {
    stdin: "ignore",
    timeoutMs: 5000,
    maxStdoutBytes: 1024,
  });
  expect(over.exitCode).toBe(EXEC_STDOUT_OVERFLOW_EXIT);
  expect(over.stdout).toBe("");
});
