import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  statfs,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildEnvelope,
  JournalWriter,
  readEvents,
} from "../src/lib/background-command/journal.ts";
import type { ObservedIdentity } from "../src/lib/background-command/platform.ts";
import { recoverLostOwner } from "../src/lib/background-command/recovery.ts";
import {
  type AcceptInput,
  acceptCommand,
} from "../src/lib/background-command/store.ts";

// ---------------------------------------------------------------------------
// HACK-2162: the journal and recovery paths on a real filesystem that is
// full. CI mounts two small tmpfs filesystems and names them here:
//   HACK_TEST_SMALL_FS  a size-limited tmpfs (writes fail with ENOSPC)
//   HACK_TEST_QUOTA_FS  a tmpfs with a user block quota (EDQUOT)
// Mounting needs root, so elsewhere these tests are skipped. Each test fills
// the filesystem itself with a filler file it removes afterwards.
// ---------------------------------------------------------------------------

const FILESYSTEMS = [
  { name: "size-limited tmpfs", dir: process.env.HACK_TEST_SMALL_FS },
  { name: "tmpfs with a user quota", dir: process.env.HACK_TEST_QUOTA_FS },
] as const;

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

const deadOwner = {
  pid: 600_001,
  birth: "o",
  processGroupId: 600_001,
  sessionId: 600_001,
  newSession: true,
};
const noReboot = async () => 0;
/** ps stand-in: every recorded process is gone. */
const nothingAlive = async () => new Map<number, ObservedIdentity>();

function input(): AcceptInput {
  return {
    requestKey: null,
    operation: "exec",
    backend: "compose",
    projectId: "demo",
    projectRoot: "/fixture/demo",
    instanceId: "@base",
    service: "api",
    argv: ["echo", "hi"],
    workdir: null,
    caller: "test:full-disk",
    timeoutMs: 60_000,
    stallAfterMs: 120_000,
    capture: "full",
    retentionMs: 60_000,
    liveOutput: "available",
    stallDetection: "available",
    redaction: { values: 0 },
    fingerprintInputs: { argv: ["echo", "hi"], service: "api" },
  };
}

function noSpaceCode(error: unknown): string | null {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : null;
  return code === "ENOSPC" || code === "EDQUOT" ? code : null;
}

/** Largest filesystem the suite will fill: never a host disk. */
const MAX_FILL_BYTES = 256 * 1024 * 1024;

/**
 * Refuse to fill anything but a small dedicated filesystem: the directory
 * must be a mount point of its own (a different device from its parent) and
 * the filesystem at most {@link MAX_FILL_BYTES}. A wrong path fails the
 * test instead of filling the host disk.
 */
async function assertSmallMount(dir: string): Promise<void> {
  const info = await statfs(dir);
  const total = info.blocks * info.bsize;
  const own = (await stat(dir)).dev !== (await stat(dirname(dir))).dev;
  if (!own || total > MAX_FILL_BYTES) {
    throw new Error(
      `Refusing to fill ${dir}: it must be its own mount point of at most ${MAX_FILL_BYTES} bytes (own mount: ${own}, size: ${total} bytes).`
    );
  }
}

/**
 * Create the filler exclusively, without following a link, and check the
 * opened file is on the checked filesystem before anything is written. It
 * is registered for cleanup only once this process created it.
 */
async function createFiller(opts: {
  readonly dir: string;
  readonly name: string;
}): Promise<FileHandle> {
  const path = join(opts.dir, opts.name);
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_APPEND |
      constants.O_NOFOLLOW,
    0o600
  );
  cleanup.push(path);
  if ((await handle.stat()).dev !== (await stat(opts.dir)).dev) {
    await handle.close();
    throw new Error(
      `Refusing to fill: ${path} is not on the checked filesystem.`
    );
  }
  return handle;
}

/**
 * Fill the filesystem: large chunks, then single bytes, until a write is
 * refused for lack of space. Returns the refusal code.
 */
async function fill(dir: string): Promise<string> {
  await assertSmallMount(dir);
  const handle = await createFiller({
    dir,
    name: `filler-${randomUUID()}`,
  });
  let code: string | null = null;
  try {
    for (const size of [1024 * 1024, 64 * 1024, 4096, 1]) {
      const chunk = Buffer.alloc(size, 0x61);
      for (;;) {
        try {
          const { bytesWritten } = await handle.write(chunk);
          if (bytesWritten < size) {
            break;
          }
        } catch (error: unknown) {
          code = noSpaceCode(error);
          if (code === null) {
            throw error;
          }
          break;
        }
      }
    }
  } finally {
    await handle.close();
  }
  if (code === null) {
    throw new Error("The filesystem never reported that it is full.");
  }
  return code;
}

test("the filler is never created through an existing entry, so nothing outside is written", async () => {
  const dir = await mkdtemp(join(tmpdir(), "full-disk-filler-"));
  cleanup.push(dir);
  const outside = join(dir, "outside.txt");
  await writeFile(outside, "untouched\n");
  await symlink(outside, join(dir, "planted"));
  await expect(createFiller({ dir, name: "planted" })).rejects.toThrow();
  expect(await readFile(outside, "utf8")).toBe("untouched\n");
});

test("the suite refuses to fill a directory that is not a small dedicated mount", async () => {
  const dir = await mkdtemp(join(tmpdir(), "full-disk-guard-"));
  cleanup.push(dir);
  await expect(fill(dir)).rejects.toThrow("Refusing to fill");
  expect(await lstat(join(dir, "filler")).catch(() => null)).toBeNull();
});

for (const fs of FILESYSTEMS) {
  describe.skipIf(!fs.dir)(
    `background command journal on a full ${fs.name}`,
    () => {
      const newRoot = async (): Promise<string> => {
        const root = await mkdtemp(join(fs.dir as string, "commands-"));
        cleanup.push(root);
        return root;
      };

      test("an event append is refused cleanly: no torn line, the journal stays readable", async () => {
        const root = await newRoot();
        const { meta, paths } = await acceptCommand({ input: input(), root });
        await fill(fs.dir as string);
        const writer = new JournalWriter(paths, meta, 1);
        let refused: unknown = null;
        try {
          await writer.write("command.output", {
            stream: "stdout",
            offset: 0,
            length: 1,
            text: "x".repeat(8192),
          });
        } catch (error: unknown) {
          refused = error;
        }
        // A quota can fill the last page and then refuse the next: the short
        // write is cut back and reported as ENOSPC, so either code is fine.
        expect(noSpaceCode(refused)).not.toBeNull();
        const text = await readFile(paths.events, "utf8");
        expect(text.endsWith("\n")).toBe(true);
        expect((await readEvents(paths)).map((event) => event.type)).toEqual([
          "command.accepted",
        ]);
        // The final record's reserve is untouched by a refused event.
        expect((await lstat(paths.reserve)).size).toBeGreaterThan(0);
      });

      test("an orphan's unscanned output is cut without new space, and the final record still lands", async () => {
        const root = await newRoot();
        const { meta, paths } = await acceptCommand({
          input: { ...input(), redaction: { values: 1 } },
          root,
        });
        await writeFile(paths.owner, JSON.stringify(deadOwner), {
          mode: 0o600,
        });
        await writeFile(paths.stdout, "unscanned output\n".repeat(64), {
          mode: 0o600,
        });
        await fill(fs.dir as string);
        const events = await recoverLostOwner({
          paths,
          meta,
          observe: nothingAlive,
          readBootTime: noReboot,
        });
        expect((await lstat(paths.stdout)).size).toBe(0);
        const ended = events.at(-1);
        expect(ended?.type).toBe("command.ended");
        expect(ended?.payload.truncated).toBe(true);
        expect(
          events.filter((event) => event.type === "command.ended")
        ).toHaveLength(1);
      });

      test("recovery writes the final record from the reserve, once", async () => {
        const root = await newRoot();
        const { meta, paths } = await acceptCommand({ input: input(), root });
        await writeFile(paths.owner, JSON.stringify(deadOwner), {
          mode: 0o600,
        });
        // End the events file on a page boundary (readers skip blank lines),
        // so the final record needs a new page: only the reserve can give it.
        const size = (await lstat(paths.events)).size;
        const page = 4096;
        await writeFile(
          paths.events,
          "\n".repeat((page - (size % page)) % page),
          {
            flag: "a",
          }
        );
        await fill(fs.dir as string);
        const recover = () =>
          recoverLostOwner({
            paths,
            meta,
            observe: nothingAlive,
            readBootTime: noReboot,
          });
        const events = await recover();
        expect(events.map((event) => event.type)).toEqual([
          "command.accepted",
          "command.ended",
        ]);
        expect(events.at(-1)?.payload.outcome).toBe("unknown");
        expect(await lstat(paths.reserve).catch(() => null)).toBeNull();
        // A second recovery on the still-full filesystem writes nothing more.
        expect((await recover()).map((event) => event.seq)).toEqual([1, 2]);
      });

      test("a complete final record without its newline is committed, never replaced", async () => {
        const root = await newRoot();
        const { meta, paths } = await acceptCommand({ input: input(), root });
        await writeFile(paths.owner, JSON.stringify(deadOwner), {
          mode: 0o600,
        });
        const ended = buildEnvelope({
          meta,
          seq: 2,
          type: "command.ended",
          payload: { outcome: "succeeded", exitCode: 0 },
        });
        await writeFile(paths.events, JSON.stringify(ended), { flag: "a" });
        await fill(fs.dir as string);
        const events = await recoverLostOwner({
          paths,
          meta,
          observe: nothingAlive,
          readBootTime: noReboot,
        });
        expect(events.at(-1)).toEqual(ended);
        expect(
          events.filter((event) => event.type === "command.ended")
        ).toHaveLength(1);
        expect((await readFile(paths.events, "utf8")).endsWith("\n")).toBe(
          true
        );
      });
    }
  );
}

const ran = FILESYSTEMS.filter((fs) => fs.dir).map((fs) => fs.name);
console.info(
  ran.length > 0
    ? `[background-command-full-disk] running on: ${ran.join(", ")}`
    : "[background-command-full-disk] skipped: set HACK_TEST_SMALL_FS and HACK_TEST_QUOTA_FS to mounted small filesystems (CI mounts them; mounting needs root)"
);
