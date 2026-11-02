import { mock } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";

const [root, operation = "optional"] = process.argv.slice(2);
if (!root) {
  throw new Error("Missing isolated registry fixture root");
}
const lockPath = join(root, "projects.json.lock");
// A required owner uses the production lock without the observation seam and
// retains the caller's isolated HOME/state instead of repurposing the lock dir.
if (operation === "hold") {
  const { withProjectsRegistryLock } = await import(
    "../../src/lib/projects-registry-lock.ts"
  );
  await withProjectsRegistryLock({
    lockPath,
    run: async () => {
      process.stdout.write("held\n");
      await Bun.stdin.text();
    },
  });
  process.exit(0);
}

const controller = new AbortController();
const abortReason = new Error("aborted during lock observation");
const calls: string[] = [];
const real = {
  lstat: fs.lstat,
  open: fs.open,
  link: fs.link,
  unlink: fs.unlink,
  mkdir: fs.mkdir,
  rmdir: fs.rmdir,
  rename: fs.rename,
};
let firstObservation = true;

function isAbsent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function afterObservation(
  observed:
    | { readonly ok: true }
    | { readonly ok: false; readonly error: unknown }
): Promise<void> {
  if (operation === "pause-observation") {
    if (!(observed.ok || isAbsent(observed.error))) {
      throw observed.error;
    }
    process.stdout.write(`observed-${observed.ok ? "occupied" : "absent"}\n`);
    await Bun.stdin.text();
  }
  if (operation === "eacces") {
    // Deliberate syscall-failure control, independent of runner UID/ACLs.
    throw Object.assign(new Error("injected lstat access denied"), {
      code: "EACCES",
    });
  }
  if (operation === "abort-observation") {
    controller.abort(abortReason);
  }
}

// This seam exists only in a fresh child. Calls delegate to the filesystem;
// capture the first real lstat result before pausing/injecting a boundary error.
mock.module("node:fs/promises", () => ({
  ...fs,
  lstat: async (path: string) => {
    calls.push("lstat");
    const observed = await real.lstat(path).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    );
    if (path === lockPath && firstObservation) {
      firstObservation = false;
      await afterObservation(observed);
    }
    if (!observed.ok) {
      throw observed.error;
    }
    return observed.value;
  },
  open: async (path: string, flags: string | number, mode?: number) => {
    calls.push("open");
    return await real.open(path, flags, mode);
  },
  link: async (from: string, to: string) => {
    calls.push("link");
    return await real.link(from, to);
  },
  unlink: async (path: string) => {
    calls.push("unlink");
    return await real.unlink(path);
  },
  mkdir: async (path: string, options: { mode?: number }) => {
    calls.push("mkdir");
    return await real.mkdir(path, options);
  },
  rmdir: async (path: string) => {
    calls.push("rmdir");
    return await real.rmdir(path);
  },
  rename: async (from: string, to: string) => {
    calls.push("rename");
    return await real.rename(from, to);
  },
}));

const { withProjectsRegistryLock } = await import(
  "../../src/lib/projects-registry-lock.ts"
);
let ran = false;
let held = false;
let failure: { message: string; code: unknown; abortReason: boolean } | null =
  null;
try {
  await withProjectsRegistryLock({
    lockPath,
    waitForLock: false,
    signal: controller.signal,
    run: async () => {
      ran = true;
      held = (await fs.readFile(lockPath, "utf8")).startsWith(
        `${process.pid}\n`
      );
    },
  });
} catch (error) {
  failure = {
    message: error instanceof Error ? error.message : "unexpected thrown value",
    code: error instanceof Error && "code" in error ? error.code : null,
    abortReason: error === abortReason,
  };
}
process.stdout.write(
  `${JSON.stringify({ ran, held, calls, error: failure })}\n`
);
