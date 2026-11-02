import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  withProjectsRegistryLock,
  writeProjectsRegistryAtomic,
} from "../src/lib/projects-registry-lock.ts";

let root = "";
let lockPath = "";
const children: Bun.Subprocess<"pipe", "pipe", "pipe">[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-registry-writers-"));
  lockPath = join(root, "projects.json.lock");
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    await child.exited;
  }
  await rm(root, { recursive: true, force: true });
});

function worker(operation: string, argument = "", gate = "") {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures/projects-registry-worker.ts"),
      root,
      operation,
      argument,
      gate,
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  children.push(child);
  return child;
}

async function burst(
  operations: readonly { operation: string; argument: string }[]
) {
  const gate = join(root, `gate-${crypto.randomUUID()}`);
  const processes = operations.map(({ operation, argument }) =>
    worker(operation, argument, gate)
  );
  const deadline = performance.now() + 5000;
  while (
    (await readdir(root)).filter(
      (name) => name.startsWith(basename(gate)) && name.endsWith(".ready")
    ).length !== operations.length
  ) {
    if (performance.now() > deadline) {
      throw new Error("Registry workers did not reach start barrier");
    }
    await Bun.sleep(10);
  }
  await writeFile(gate, "start");
  return await Promise.all(processes.map(output));
}

async function output(child: ReturnType<typeof worker>) {
  const [stdout, stderr, exitCode] = await Promise.all([
    remainingOutput(child.stdout),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  return stdout;
}

async function remainingOutput(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return text + decoder.decode();
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

async function waitForBoundary(
  child: ReturnType<typeof worker>,
  expected: string
) {
  const reader = child.stdout.getReader();
  const result = await reader.read();
  reader.releaseLock();
  expect(new TextDecoder().decode(result.value)).toBe(`${expected}\n`);
}

async function deadPid() {
  const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await child.exited;
  return child.pid;
}

test("old live owner and reused live PID are preserved regardless of receipt age", async () => {
  const bytes = `${process.pid}\n`;
  await writeFile(lockPath, bytes, { mode: 0o600 });
  const old = new Date(0);
  await utimes(lockPath, old, old);
  let ran = false;
  await expect(
    withProjectsRegistryLock({
      lockPath,
      timeoutMs: 100,
      run: async () => {
        ran = true;
      },
    })
  ).rejects.toThrow("Timed out");
  expect(ran).toBe(false);
  expect(await readFile(lockPath, "utf8")).toBe(bytes);
  expect(await readdir(root)).toEqual(["projects.json.lock"]);
});

test("optional touch does not reclaim a dead owner or wait", async () => {
  const bytes = `${await deadPid()}\n`;
  await writeFile(lockPath, bytes);
  await expect(
    withProjectsRegistryLock({
      lockPath,
      waitForLock: false,
      run: async () => {
        throw new Error("must not run");
      },
    })
  ).rejects.toThrow("optional touch deferred");
  expect(await readFile(lockPath, "utf8")).toBe(bytes);
});

test("cancelled wait preserves lock and registry without leaked staging files", async () => {
  const controller = new AbortController();
  await writeFile(lockPath, `${process.pid}\n`);
  await writeFile(join(root, "projects.json"), "original\n");
  const pending = withProjectsRegistryLock({
    lockPath,
    signal: controller.signal,
    run: async () => {
      throw new Error("must not run");
    },
  });
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(await readFile(join(root, "projects.json"), "utf8")).toBe(
    "original\n"
  );
  expect((await readdir(root)).sort()).toEqual([
    "projects.json",
    "projects.json.lock",
  ]);
});

test("release refuses to unlink a replacement owner", async () => {
  const successor = `${process.pid}\n11111111-1111-1111-1111-111111111111\n`;
  await withProjectsRegistryLock({
    lockPath,
    run: async () => {
      await rename(lockPath, `${lockPath}.previous`);
      await writeFile(lockPath, successor, { mode: 0o600 });
    },
  });
  expect(await readFile(lockPath, "utf8")).toBe(successor);
});

test("unreadable ownership and symlinks are never recovered by age", async () => {
  const target = join(root, "target");
  await writeFile(target, `${await deadPid()}\n`);
  await symlink(target, lockPath);
  await expect(
    withProjectsRegistryLock({
      lockPath,
      timeoutMs: 50,
      run: async () => undefined,
    })
  ).rejects.toThrow("Timed out");
  expect(await readFile(target, "utf8")).toMatch(/^\d+\n$/);
  await rm(lockPath);
  await writeFile(lockPath, "");
  await expect(
    withProjectsRegistryLock({
      lockPath,
      timeoutMs: 50,
      run: async () => undefined,
    })
  ).rejects.toThrow("Timed out");
  expect(await readFile(lockPath, "utf8")).toBe("");
});

test("interrupted recovery guard is preserved and produces bounded actionable failure", async () => {
  await writeFile(lockPath, `${await deadPid()}\n`);
  await mkdir(`${lockPath}.recovery`);
  await expect(
    withProjectsRegistryLock({
      lockPath,
      timeoutMs: 50,
      run: async () => undefined,
    })
  ).rejects.toThrow("offline inspection");
  expect(await readdir(root)).toContain("projects.json.lock.recovery");
});

test("killed writer is recovered, while its live aged lock blocks competitors", async () => {
  const owner = worker("hold");
  await waitForBoundary(owner, "held");
  await utimes(lockPath, new Date(0), new Date(0));
  await expect(
    withProjectsRegistryLock({
      lockPath,
      timeoutMs: 50,
      run: async () => undefined,
    })
  ).rejects.toThrow("Timed out");
  owner.kill("SIGKILL");
  await owner.exited;
  await withProjectsRegistryLock({
    lockPath,
    run: async () => {
      expect(
        (await readFile(lockPath, "utf8")).startsWith(`${process.pid}\n`)
      ).toBe(true);
    },
  });
  expect(await readdir(root)).toEqual([]);
});

test("a paused stale reclaimer rechecks under the guard and preserves a live successor", async () => {
  await writeFile(lockPath, `${await deadPid()}\n`);
  const stale = worker("delayed-reaper");
  await waitForBoundary(stale, "observed");
  const successor = worker("hold");
  await waitForBoundary(successor, "held");
  const receipt = await readFile(lockPath, "utf8");
  expect(receipt.startsWith(`${successor.pid}\n`)).toBe(true);
  stale.stdin.end();
  expect(await output(stale)).toBe("refused\n");
  expect(await readFile(lockPath, "utf8")).toBe(receipt);
  successor.stdin.end();
  expect(await output(successor)).toBe("");
  expect(await readdir(root)).toEqual([]);
});

test("process death before commit preserves the old complete registry and next writer can commit", async () => {
  const path = join(root, "projects.json");
  await writeFile(path, "original\n");
  const owner = worker("interrupt-write");
  await waitForBoundary(owner, "prepared");
  expect(await readFile(path, "utf8")).toBe("original\n");
  owner.kill("SIGKILL");
  await owner.exited;
  const abandoned = (await readdir(root)).filter((name) =>
    name.endsWith(".tmp")
  );
  expect(abandoned).toHaveLength(1);
  expect(await readFile(join(root, abandoned[0]!), "utf8")).toBe(
    "replacement\n"
  );
  await withProjectsRegistryLock({
    lockPath,
    run: () => writeProjectsRegistryAtomic({ path, text: "successor\n" }),
  });
  expect(await readFile(path, "utf8")).toBe("successor\n");
  // No successor trusts or overwrites an interrupted writer's staging file.
  expect(await readFile(join(root, abandoned[0]!), "utf8")).toBe(
    "replacement\n"
  );
});

test("cancelled atomic write and failed commit preserve original content", async () => {
  const path = join(root, "projects.json");
  await writeFile(path, "original\n");
  await expect(
    writeProjectsRegistryAtomic({
      path,
      text: "new\n",
      signal: AbortSignal.abort(),
    })
  ).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe("original\n");
  const directory = join(root, "directory");
  await mkdir(directory);
  await expect(
    writeProjectsRegistryAtomic({ path: directory, text: "new\n" })
  ).rejects.toThrow();
  expect((await readdir(root)).sort()).toEqual(["directory", "projects.json"]);
});

test("32 real writers preserve every upsert, then concurrent rename and removal", async () => {
  // Release 32 live clients together against an initially dead owner. The
  // separate paused-reclaimer test forces the exact stale-observation race.
  await writeFile(lockPath, `${await deadPid()}\n`);
  const created = await burst(
    Array.from({ length: 32 }, (_, index) => ({
      operation: "create",
      argument: String(index),
    }))
  );
  const ids = created.map((text) => {
    const result = JSON.parse(text);
    expect(result.status).toBe("created");
    return result.project.id as string;
  });
  const initial = JSON.parse(await output(worker("read")));
  expect(initial.projects).toHaveLength(32);
  expect(
    new Set(initial.projects.map((project: { id: string }) => project.id)).size
  ).toBe(32);
  await burst(
    ids.map((id, index) => ({
      operation: index % 2 === 0 ? "rename" : "remove",
      argument: index % 2 === 0 ? String(index) : id,
    }))
  );
  const final = JSON.parse(await output(worker("read")));
  expect(final.projects).toHaveLength(16);
  expect(
    final.projects.map((project: { name: string }) => project.name).sort()
  ).toEqual(Array.from({ length: 16 }, (_, i) => `rename-${i * 2}`).sort());
  expect(
    (await readdir(root)).filter((name) =>
      /\.(lock|owner|tmp|recovery)$/.test(name)
    )
  ).toEqual([]);
}, 30_000);
