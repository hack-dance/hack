import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DATA_BACKUP_ARCHIVE_DIGEST_SCRIPT,
  DATA_BACKUP_DIGEST_SCRIPT,
} from "../src/lib/data-backup-format.ts";
import { spawnSyncBounded } from "./helpers/bounded-spawn-sync.ts";

/**
 * The archive digest computed from a tar stream equals the live tree digest
 * of the directory the tar was made from: the field rules agree for regular
 * files, hard links, symlinks, FIFOs, directories, non-UTF-8 and long names,
 * in both GNU and POSIX tar formats, and a socket is left out of both. Runs
 * the production scripts with this Bun against a temporary tree (the live
 * script's `/v` root swapped for it) and the host's GNU tar.
 */
const tarAvailable = (() => {
  try {
    const result = spawnSyncBounded(["tar", "--version"], { timeout: 10_000 });
    return (
      result.exitCode === 0 && result.stdout.toString().includes("GNU tar")
    );
  } catch {
    return false;
  }
})();

let root: string;
const servers: Server[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-data-archive-"));
});
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await rm(root, { recursive: true, force: true });
});

function liveDigest(dir: string): Record<string, unknown> {
  const script = DATA_BACKUP_DIGEST_SCRIPT.replace(
    'Buffer.from("/v")',
    `Buffer.from(${JSON.stringify(dir)})`
  );
  const result = spawnSyncBounded([process.execPath, "-e", script], {
    timeout: 60_000,
  });
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout.toString());
}

function archiveDigest(tar: Uint8Array): {
  readonly exitCode: number;
  readonly value: Record<string, unknown> | null;
} {
  const result = spawnSyncBounded(
    [process.execPath, "-e", DATA_BACKUP_ARCHIVE_DIGEST_SCRIPT],
    { stdin: tar, timeout: 60_000 }
  );
  return {
    exitCode: result.exitCode ?? -1,
    value: result.exitCode === 0 ? JSON.parse(result.stdout.toString()) : null,
  };
}

function tarOf(dir: string, format: "gnu" | "posix"): Uint8Array {
  const result = spawnSyncBounded(
    [
      "tar",
      "--numeric-owner",
      `--format=${format}`,
      "-cpf",
      "-",
      "-C",
      dir,
      ".",
    ],
    { timeout: 60_000 }
  );
  expect(result.exitCode).toBe(0);
  return result.stdout;
}

async function tree(): Promise<string> {
  const dir = join(root, "v");
  await mkdir(join(dir, "d", "sub"), { recursive: true });
  await writeFile(join(dir, "a.txt"), "one\n");
  await chmod(join(dir, "a.txt"), 0o640);
  await symlink("a.txt", join(dir, "link"));
  await link(join(dir, "a.txt"), join(dir, "hard"));
  await writeFile(
    join(dir, Buffer.from("n\xe9", "latin1").toString("latin1")),
    "x"
  );
  const long = "L".repeat(120);
  await mkdir(join(dir, long));
  await writeFile(join(dir, long, "F".repeat(130)), "deep");
  await writeFile(join(dir, "d", "big"), Buffer.alloc(3_000_000, 7));
  expect(
    spawnSyncBounded(["mkfifo", join(dir, "fifo")], { timeout: 10_000 })
      .exitCode
  ).toBe(0);
  // Two names for one FIFO and for one symlink: tar stores the second name
  // of each as a hard link to a non-regular entry.
  await link(join(dir, "fifo"), join(dir, "fifo2"));
  expect(
    spawnSyncBounded(["ln", "-P", join(dir, "link"), join(dir, "link2")], {
      timeout: 10_000,
    }).exitCode
  ).toBe(0);
  // A listening socket, like mysql.sock in a datadir; closed after the test.
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(join(dir, "d", "app.sock"), resolve)
  );
  return dir;
}

test.skipIf(!tarAvailable)(
  "the archive digest equals the live digest for GNU and POSIX archives",
  async () => {
    const dir = await tree();
    const live = liveDigest(dir);
    expect(live.excludedSockets).toBe(1);
    for (const format of ["gnu", "posix"] as const) {
      const archive = archiveDigest(tarOf(dir, format));
      expect(archive.exitCode).toBe(0);
      expect(archive.value).toEqual({ ...live, excludedSockets: 0 });
    }
  }
);

test.skipIf(!tarAvailable)(
  "a changed, truncated or corrupted archive does not match or refuses",
  async () => {
    const dir = await tree();
    const live = liveDigest(dir);
    const tar = tarOf(dir, "gnu");

    await writeFile(join(dir, "a.txt"), "two\n");
    const changed = archiveDigest(tarOf(dir, "gnu"));
    expect(changed.value?.digest).not.toBe(live.digest);

    expect(archiveDigest(tar.subarray(0, 1024 + 100)).exitCode).not.toBe(0);
    const corrupted = Buffer.from(tar);
    corrupted[10] = (corrupted[10] ?? 0) ^ 0xff;
    expect(archiveDigest(corrupted).exitCode).not.toBe(0);
  }
);
