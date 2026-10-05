import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../src/lib/guards.ts";

let fixtureRoot = "";
let root = "";
let childHome = "";
let childState = "";
let lockPath = "";
const children: Bun.Subprocess<"pipe", "pipe", "pipe">[] = [];
beforeEach(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "hack-optional-lock-"));
  root = join(fixtureRoot, "registry");
  childHome = join(fixtureRoot, "home");
  childState = join(fixtureRoot, "state");
  await Promise.all([root, childHome, childState].map((path) => mkdir(path)));
  lockPath = join(root, "projects.json.lock");
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    await child.exited;
  }
  await rm(fixtureRoot, { recursive: true, force: true });
});

function optionalWorker(operation = "optional") {
  return spawn("projects-registry-optional-worker.ts", operation);
}
function ownerWorker() {
  return spawn("projects-registry-optional-worker.ts", "hold");
}
function spawn(file: string, operation: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures", file),
      root,
      operation,
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        // Bun may create HOME/Library/Caches when XDG_CACHE_HOME is absent.
        // Keep ambient runtime files outside the strictly asserted registry dir.
        HOME: childHome,
        HACK_HOME: childState,
        HACK_GLOBAL_CONFIG_PATH: join(childState, "hack.config.json"),
      },
    }
  );
  children.push(child);
  return child;
}
async function boundary(child: ReturnType<typeof spawn>, expected: string) {
  const reader = child.stdout.getReader();
  try {
    const result = await reader.read();
    expect(new TextDecoder().decode(result.value)).toBe(`${expected}\n`);
  } finally {
    reader.releaseLock();
  }
}
async function finish(child: ReturnType<typeof spawn>) {
  const [stdout, stderr, exitCode] = await Promise.all([
    remainingOutput(child.stdout),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ stderr, exitCode }).toEqual({ stderr: "", exitCode: 0 });
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
async function report(
  child: ReturnType<typeof spawn>
): Promise<Record<string, unknown> & { calls: string[] }> {
  const parsed: unknown = JSON.parse(await finish(child));
  if (
    !(
      isRecord(parsed) &&
      Array.isArray(parsed.calls) &&
      parsed.calls.every((call: unknown) => typeof call === "string")
    )
  ) {
    throw new Error("Invalid optional lock fixture report");
  }
  return { ...parsed, calls: parsed.calls };
}
async function deadPid() {
  const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await child.exited;
  return child.pid;
}

const deferred = {
  ran: false,
  held: false,
  calls: ["lstat"],
  error: {
    message: "Projects registry is busy; optional touch deferred",
    code: null,
    abortReason: false,
  },
};

for (const occupied of [
  "live",
  "dead",
  "empty",
  "malformed",
  "dangling-symlink",
  "directory",
] as const) {
  test(`occupied optional ${occupied} lock performs no staging, publication or reclamation`, async () => {
    let bytes = "";
    if (occupied === "dangling-symlink") {
      await symlink("absent-target", lockPath);
    } else if (occupied === "directory") {
      await mkdir(lockPath);
    } else {
      bytes =
        occupied === "live"
          ? `${process.pid}\n`
          : occupied === "dead"
            ? `${await deadPid()}\n`
            : occupied === "malformed"
              ? "not-an-owner\n"
              : "";
      await writeFile(lockPath, bytes, { mode: 0o600 });
    }
    const before = await lstat(lockPath);
    expect(await report(optionalWorker())).toEqual(deferred);
    const after = await lstat(lockPath);
    expect([
      after.dev,
      after.ino,
      after.mode,
      after.size,
      after.mtimeMs,
      after.ctimeMs,
    ]).toEqual([
      before.dev,
      before.ino,
      before.mode,
      before.size,
      before.mtimeMs,
      before.ctimeMs,
    ]);
    if (occupied === "dangling-symlink") {
      expect(await readlink(lockPath)).toBe("absent-target");
    } else if (occupied === "directory") {
      expect(await readdir(lockPath)).toEqual([]);
    } else {
      expect(await readFile(lockPath, "utf8")).toBe(bytes);
    }
    expect(await readdir(root)).toEqual(["projects.json.lock"]);
  });
}

test("an owner releasing after the occupied observation still defers without staging", async () => {
  const owner = ownerWorker();
  await boundary(owner, "held");
  const optional = optionalWorker("pause-observation");
  await boundary(optional, "observed-occupied");
  owner.stdin.end();
  expect(await finish(owner)).toBe("");
  expect(await readdir(root)).toEqual([]);
  optional.stdin.end();
  expect(await report(optional)).toEqual(deferred);
  expect(await readdir(root)).toEqual([]);
});

test("a real owner arriving after the absent observation wins atomic publication", async () => {
  const optional = optionalWorker("pause-observation");
  await boundary(optional, "observed-absent");
  const owner = ownerWorker();
  await boundary(owner, "held");
  const before = await lstat(lockPath);
  const receipt = await readFile(lockPath, "utf8");
  expect(receipt.startsWith(`${owner.pid}\n`)).toBe(true);
  optional.stdin.end();
  expect(await report(optional)).toEqual({
    ...deferred,
    calls: ["lstat", "open", "link", "unlink"],
  });
  expect(await readFile(lockPath, "utf8")).toBe(receipt);
  const after = await lstat(lockPath);
  expect([after.dev, after.ino, after.ctimeMs]).toEqual([
    before.dev,
    before.ino,
    before.ctimeMs,
  ]);
  expect(await readdir(root)).toEqual(["projects.json.lock"]);
  owner.stdin.end();
  expect(await finish(owner)).toBe("");
  expect(await readdir(root)).toEqual([]);
});

test("an uncontended optional writer publishes a real owner and releases every staging path", async () => {
  const result = await report(optionalWorker());
  expect(result).toMatchObject({ ran: true, held: true, error: null });
  expect(result.calls.filter((call) => call === "link")).toHaveLength(1);
  expect(result.calls).not.toContain("mkdir");
  expect(result.calls).not.toContain("rmdir");
  expect(result.calls).not.toContain("rename");
  expect(await readdir(root)).toEqual([]);
});

test("non-ENOENT observation errors propagate without staging or running", async () => {
  await writeFile(lockPath, "preserve\n");
  expect(await report(optionalWorker("eacces"))).toEqual({
    ran: false,
    held: false,
    calls: ["lstat"],
    error: {
      message: "injected lstat access denied",
      code: "EACCES",
      abortReason: false,
    },
  });
  expect(await readFile(lockPath, "utf8")).toBe("preserve\n");
  expect(await readdir(root)).toEqual(["projects.json.lock"]);
});

for (const occupied of [false, true]) {
  test(`abort during ${occupied ? "occupied" : "absent"} observation runs nothing and stages nothing`, async () => {
    if (occupied) {
      await writeFile(lockPath, "preserve\n");
    }
    expect(await report(optionalWorker("abort-observation"))).toEqual({
      ran: false,
      held: false,
      calls: ["lstat"],
      error: {
        message: "aborted during lock observation",
        code: null,
        abortReason: true,
      },
    });
    expect(await readdir(root)).toEqual(occupied ? ["projects.json.lock"] : []);
    if (occupied) {
      expect(await readFile(lockPath, "utf8")).toBe("preserve\n");
    }
  });
}
