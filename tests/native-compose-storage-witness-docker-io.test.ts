import { afterEach, expect, test } from "bun:test";
import { fstatSync } from "node:fs";
import {
  link,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  holdDirectory,
  writeExclusive,
} from "../src/lib/native-compose-private-state.ts";
import { runNativeComposeStorageDockerCommand } from "../src/lib/native-compose-storage-witness-docker.ts";
import {
  createNativeComposeStorageDockerEmptyLeaf,
  holdNativeComposeStorageDockerIo,
} from "../src/lib/native-compose-storage-witness-docker-io.ts";
import { run } from "../src/lib/shell.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-storage-held-io-"))
  );
  roots.push(root);
  const directory = await holdDirectory(root, true);
  const input = join(root, "input"),
    stdout = join(root, "stdout"),
    stderr = join(root, "stderr");
  const text = "synthetic private input";
  const inputInfo = await writeExclusive(input, text),
    outInfo = await createNativeComposeStorageDockerEmptyLeaf(stdout),
    errInfo = await createNativeComposeStorageDockerEmptyLeaf(stderr);
  const io = await holdNativeComposeStorageDockerIo({
    directories: [directory],
    input: { path: input, info: inputInfo, text },
    stdout: { path: stdout, info: outInfo },
    stderr: { path: stderr, info: errInfo },
    limit: 4096,
  });
  return { root, directory, input, inputInfo, stdout, stderr, text, io };
}
test("held IO passes exact stdin and preserves caller descriptors through completion", async () => {
  const f = await fixture();
  try {
    let exited = false;
    const code = await run(["/bin/sh", "-c", "ulimit -f 8; exec cat"], {
      privateIo: f.io.descriptors,
      timeoutMs: 3000,
      beforeSpawn: f.io.assertFresh,
      onExit: async () => {
        exited = true;
        expect(fstatSync(f.io.descriptors.stdout).isFile()).toBe(true);
      },
    });
    expect(code).toBe(0);
    expect(exited).toBe(true);
    expect(f.io.read()).toEqual({ stdout: f.text, stderr: "" });
    expect(fstatSync(f.io.descriptors.stdin).isFile()).toBe(true);
  } finally {
    await f.io.close();
    await f.directory.file.close();
  }
});
test("separate empty command leaf never overwrites existing bytes or follows a symlink", async () => {
  const f = await fixture();
  try {
    await expect(
      createNativeComposeStorageDockerEmptyLeaf(f.input)
    ).rejects.toThrow();
    const alias = join(f.root, "alias");
    await symlink(f.input, alias);
    await expect(
      createNativeComposeStorageDockerEmptyLeaf(alias)
    ).rejects.toThrow();
    expect(await readFile(f.input, "utf8")).toBe(f.text);
    await expect(
      writeExclusive(join(f.root, "receipt-empty"), "")
    ).rejects.toThrow("values omitted");
  } finally {
    await f.io.close();
    await f.directory.file.close();
  }
});
test.each([
  "input-replace",
  "input-symlink",
  "stdout-replace",
  "stderr-replace",
  "input-hardlink",
  "input-change",
  "stdout-hardlink",
  "stdout-symlink",
] as const)("last admission await %s refuses before spawn and preserves the ungranted file", async (failure) => {
  const f = await fixture();
  const foreign = join(f.root, "ungranted");
  await writeFile(foreign, "preserved foreign bytes", { mode: 0o600 });
  let admitted = false;
  const files = {
    held: [f.directory],
    path: f.root,
    input: f.input,
    inputInfo: f.inputInfo,
    requestText: f.text,
    captures: [] as { path: string; info: typeof f.inputInfo }[],
  };
  try {
    await expect(
      runNativeComposeStorageDockerCommand({
        files,
        context: {
          signal: new AbortController().signal,
          deadline: Date.now() + 3000,
        },
        args: ["/bin/cat"],
        timeoutMs: 3000,
        beforeSpawn: () => {
          admitted = true;
        },
        assertAdmitted: async () => {
          const selected = failure.startsWith("input")
            ? f.input
            : (files.captures[failure.startsWith("stdout") ? 0 : 1]?.path ??
              "");
          if (failure.endsWith("replace")) {
            await rename(selected, `${selected}.original`);
            await link(foreign, selected);
          } else if (failure.endsWith("symlink")) {
            await rename(selected, `${selected}.original`);
            await symlink(foreign, selected);
          } else if (failure.endsWith("hardlink")) {
            await link(selected, `${selected}.alias`);
          } else {
            await writeFile(selected, "substituted input");
          }
        },
      })
    ).rejects.toThrow("values omitted");
    expect(admitted).toBe(false);
    expect(await readFile(foreign, "utf8")).toBe("preserved foreign bytes");
  } finally {
    await f.io.close();
    await f.directory.file.close();
  }
});
test("cancellation at the final admission leaves captures empty and spawns no child", async () => {
  const f = await fixture(),
    controller = new AbortController();
  let spawned = false;
  try {
    const code = await run(["/bin/sh", "-c", "ulimit -f 8; exec cat"], {
      privateIo: f.io.descriptors,
      timeoutMs: 3000,
      signal: controller.signal,
      beforeSpawn: () => {
        f.io.assertFresh();
        controller.abort();
      },
      onSpawn: async () => {
        spawned = true;
      },
    });
    expect(code).toBe(143);
    expect(spawned).toBe(false);
    expect(f.io.read()).toEqual({ stdout: "", stderr: "" });
  } finally {
    await f.io.close();
    await f.directory.file.close();
  }
});
test("actual transport refuses an abort during its last admission await without child effects", async () => {
  const f = await fixture(),
    controller = new AbortController();
  const files = {
    held: [f.directory],
    path: f.root,
    input: f.input,
    inputInfo: f.inputInfo,
    requestText: f.text,
    captures: [] as { path: string; info: typeof f.inputInfo }[],
  };
  let admitted = false;
  try {
    await expect(
      runNativeComposeStorageDockerCommand({
        files,
        context: { signal: controller.signal, deadline: Date.now() + 3000 },
        args: ["/bin/cat"],
        timeoutMs: 3000,
        beforeSpawn: () => {
          admitted = true;
        },
        assertAdmitted: async () => {
          await Promise.resolve();
          controller.abort();
        },
      })
    ).rejects.toThrow("values omitted");
    expect(admitted).toBe(false);
    for (const capture of files.captures) {
      expect(await readFile(capture.path, "utf8")).toBe("");
    }
  } finally {
    await f.io.close();
    await f.directory.file.close();
  }
});
test("fixed wrapper quota bounds capture growth and oversized output cannot be accepted", async () => {
  const f = await fixture();
  try {
    const code = await run(
      [
        "/bin/sh",
        "-c",
        'ulimit -f 8; exec /bin/sh -c "while :; do printf 0123456789; done"',
      ],
      {
        privateIo: f.io.descriptors,
        timeoutMs: 3000,
        beforeSpawn: f.io.assertFresh,
      }
    );
    expect(code).not.toBe(0);
    expect(code).not.toBe(124);
    expect(fstatSync(f.io.descriptors.stdout).size).toBeLessThanOrEqual(8192);
    if (fstatSync(f.io.descriptors.stdout).size > 4096) {
      expect(() => f.io.read()).toThrow("values omitted");
    }
  } finally {
    await f.io.close();
    await f.directory.file.close();
  }
});
