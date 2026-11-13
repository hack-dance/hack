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
    [
      "tar",
      `--format=${format === "gnu" && process.platform === "darwin" ? "gnutar" : format}`,
      "-C",
      directory,
      "-cf",
      "-",
      "root.crt",
    ],
    {
      stdin: "ignore",
      timeoutMs: 5000,
      maxStdoutBytes: 1_000_000,
      // macOS tar (libarchive) writes a file's metadata as a separate
      // AppleDouble `._root.crt` entry in pax archives; that is a second
      // regular file, which this strict reader refuses by design (see the
      // fixture tests below). GNU tar ignores the variable (HACK-2174).
      env: { COPYFILE_DISABLE: "1" },
    }
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

/**
 * Hand-built archives (bytes in the test, not a host tool), so pax handling
 * is checked the same way on every host (HACK-2174).
 */
function tarHeader(opts: {
  readonly name: string;
  readonly size: number;
  readonly type: string;
}): Buffer {
  const header = Buffer.alloc(512);
  header.write(opts.name, 0, 100, "latin1");
  header.write("0000644\0", 100, "latin1");
  header.write("0000000\0", 108, "latin1");
  header.write("0000000\0", 116, "latin1");
  header.write(`${opts.size.toString(8).padStart(11, "0")}\0`, 124, "latin1");
  header.write("00000000000\0", 136, "latin1");
  header.write(opts.type, 156, "latin1");
  header.write("ustar\0", 257, "latin1");
  header.write("00", 263, "latin1");
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) {
    sum += byte;
  }
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return header;
}

function padded(data: Buffer): Buffer {
  return Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

/** One pax record; its decimal length counts the whole record, itself included. */
function paxRecord(key: string, value: Buffer): Buffer {
  const rest = Buffer.concat([
    Buffer.from(` ${key}=`),
    value,
    Buffer.from("\n"),
  ]);
  let length = rest.length + 1;
  while (String(length).length + rest.length !== length) {
    length = String(length).length + rest.length;
  }
  return Buffer.concat([Buffer.from(String(length)), rest]);
}

function entry(name: string, type: string, data: Buffer): Buffer {
  return Buffer.concat([
    tarHeader({ name, size: data.length, type }),
    padded(data),
  ]);
}

const END = Buffer.alloc(1024);

test("reads the file after pax extended headers with binary xattr records", async () => {
  // As libarchive writes them: raw (binary) and base64 xattr values, an
  // mtime with a fraction, a path record and a header name that differs.
  const xattr = Buffer.from([0x00, 0xff, 0x3d, 0x0a, 0x20, 0x7f, 0x80]);
  const records = Buffer.concat([
    paxRecord("mtime", Buffer.from("1731400000.123456789")),
    paxRecord("SCHILY.xattr.com.apple.provenance", xattr),
    paxRecord(
      "LIBARCHIVE.xattr.com.apple.provenance",
      Buffer.from(xattr.toString("base64"))
    ),
    paxRecord("path", Buffer.from("root.crt")),
  ]);
  const archive = Buffer.concat([
    entry("PaxHeader/root.crt", "x", records),
    entry("root.crt", "0", Buffer.from(CURRENT_CA_PEM)),
    END,
  ]);
  const content = readSingleRegularFileFromTar({
    archive,
    name: "root.crt",
    maxBytes: 65_536,
  });
  expect(Buffer.from(content ?? new Uint8Array()).toString("utf8")).toBe(
    CURRENT_CA_PEM
  );
  if (tarAvailable) {
    // The fixture is a valid archive to the host's own tar as well.
    const listed = await exec(["tar", "-tf", "-"], {
      stdin: new Blob([archive]),
      timeoutMs: 5000,
    });
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout.split("\n").filter(Boolean)).toEqual(["root.crt"]);
  }
});

test("an AppleDouble metadata entry before the file is a second file and is refused", () => {
  const archive = Buffer.concat([
    entry("._root.crt", "0", Buffer.from("synthetic-appledouble-metadata")),
    entry("root.crt", "0", Buffer.from(CURRENT_CA_PEM)),
    END,
  ]);
  expect(
    readSingleRegularFileFromTar({
      archive,
      name: "root.crt",
      maxBytes: 65_536,
    })
  ).toBeNull();
});
