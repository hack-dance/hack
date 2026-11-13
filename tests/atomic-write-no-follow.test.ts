import { afterEach, expect, test } from "bun:test";
import {
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AtomicWriteRefusedError,
  writeTextFileAtomicIfChanged,
} from "../src/lib/fs.ts";

/**
 * `noFollowTarget` (HACK-2165): the destination a machine-local write
 * replaces is the path its checks admitted, never a file a symlink there
 * resolves to, even when a link is swapped in between the checks and the
 * commit (the old writer resolved the destination with realpath once).
 */

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "hack-atomic-no-follow-"));
  dirs.push(dir);
  const local = join(dir, "hack.env.local.yaml");
  const tracked = join(dir, "hack.env.default.yaml");
  await writeFile(local, "local: before\n", { mode: 0o600 });
  await writeFile(tracked, "tracked: unchanged\n");
  return { dir, local, tracked };
}

/** Replaces `path` with a link to `target`, keeping the original aside. */
async function swapToLink(path: string, target: string): Promise<string> {
  const aside = `${path}.aside`;
  await rename(path, aside);
  await symlink(target, path);
  return aside;
}

test("a link at the destination is refused before anything is staged", async () => {
  const f = await fixture();
  await swapToLink(f.local, f.tracked);
  await expect(
    writeTextFileAtomicIfChanged(f.local, "local: after\n", {
      noFollowTarget: true,
    })
  ).rejects.toBeInstanceOf(AtomicWriteRefusedError);
  expect(await readFile(f.tracked, "utf8")).toBe("tracked: unchanged\n");
});

test("a link swapped in after admission and restored still cannot redirect the write", async () => {
  const f = await fixture();
  let calls = 0;
  let aside: string | null = null;
  // The policy check runs first; right after it, the local layer becomes a
  // link to the tracked layer; the next check restores it. The old writer
  // resolved the destination in that window and wrote the tracked file.
  const validatePath = async () => {
    calls += 1;
    if (calls === 1) {
      aside = await swapToLink(f.local, f.tracked);
    } else if (aside) {
      await rm(f.local);
      await rename(aside, f.local);
      aside = null;
    }
  };
  const refused = await writeTextFileAtomicIfChanged(
    f.local,
    "local: after\n",
    {
      noFollowTarget: true,
      validatePath,
    }
  ).then(
    () => false,
    (error: unknown) => error instanceof AtomicWriteRefusedError
  );
  // The tracked layer is never written, whether the writer refuses the link
  // it now sees or commits onto the admitted path itself.
  expect(await readFile(f.tracked, "utf8")).toBe("tracked: unchanged\n");
  if (!refused) {
    expect((await lstat(f.local)).isSymbolicLink()).toBe(false);
    expect(await readFile(f.local, "utf8")).toBe("local: after\n");
  }
});
