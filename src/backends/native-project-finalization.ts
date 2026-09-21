import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../lib/guards.ts";
import type {
  NativeProjectRun,
  NativeProjectRunScope,
} from "./native-project-run.ts";

const HEX32 = /^[a-f0-9]{32}$/;
const HEX64 = /^[a-f0-9]{64}$/;
export type NativeProjectFinalizationToken = {
  readonly version: 1;
  readonly attempt: string;
  readonly scope: string;
  readonly run: string;
  readonly owner: string;
  readonly namespace: string;
  readonly planId: string;
};
export function isNativeProjectFinalizationToken(
  value: unknown
): value is NativeProjectFinalizationToken {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join() ===
      "attempt,namespace,owner,planId,run,scope,version" &&
    value.version === 1 &&
    [value.attempt, value.run, value.owner].every(
      (v) => typeof v === "string" && HEX32.test(v)
    ) &&
    [value.scope, value.namespace, value.planId].every(
      (v) => typeof v === "string" && HEX64.test(v)
    )
  );
}
function refused(): Error {
  return new Error(
    "Native frontend finalization is unconfirmed or its ownership changed; no replacement owner may start."
  );
}
function same(
  a: NativeProjectFinalizationToken,
  b: NativeProjectFinalizationToken
): boolean {
  return (
    a.attempt === b.attempt &&
    a.scope === b.scope &&
    a.run === b.run &&
    a.owner === b.owner &&
    a.namespace === b.namespace &&
    a.planId === b.planId
  );
}
async function directory(path: string, create: boolean): Promise<void> {
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") {
        throw refused();
      }
    }
  }
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  ) {
    throw refused();
  }
}
async function selected(
  scope: NativeProjectRunScope,
  run: NativeProjectRun,
  create: boolean
) {
  if (
    !(
      HEX32.test(run.run) &&
      HEX32.test(run.owner) &&
      HEX64.test(run.namespace) &&
      HEX64.test(run.planId)
    )
  ) {
    throw refused();
  }
  const home = await realpath(scope.nativeHome);
  const identity = {
    home,
    projectRoot: await realpath(scope.projectRoot),
    projectDir: await realpath(scope.projectDir),
    branch: scope.branch,
  };
  const hash = createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex");
  await directory(home, false);
  let root = home;
  for (const component of [
    ".hack-local",
    "frontend-finalization",
    hash,
    run.run,
  ]) {
    root = join(root, component);
    await directory(root, create);
  }
  return { root, hash };
}
async function read(
  path: string
): Promise<NativeProjectFinalizationToken | null> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
    );
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return null;
    }
    throw refused();
  }
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 4096
    ) {
      throw refused();
    }
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat();
    const named = await lstat(path);
    if (
      bytesRead !== stat.size ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs ||
      named.dev !== stat.dev ||
      named.ino !== stat.ino ||
      named.isSymbolicLink()
    ) {
      throw refused();
    }
    const value: unknown = JSON.parse(
      bytes.subarray(0, bytesRead).toString("utf8")
    );
    if (!isNativeProjectFinalizationToken(value)) {
      throw refused();
    }
    return value;
  } finally {
    await file.close();
  }
}
async function write(
  root: string,
  name: string,
  token: NativeProjectFinalizationToken
) {
  const temporary = join(root, `${randomBytes(16).toString("hex")}.tmp`);
  const file = await open(
    temporary,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600
  );
  try {
    try {
      await file.writeFile(JSON.stringify(token));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(root, name));
    const dir = await open(root, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
async function locked<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const lock = join(root, "operation.lock");
  await mkdir(lock, { mode: 0o700 });
  try {
    return await fn();
  } finally {
    await rmdir(lock);
  }
}
function matches(
  token: NativeProjectFinalizationToken,
  hash: string,
  run: NativeProjectRun
): boolean {
  return (
    token.scope === hash &&
    token.run === run.run &&
    token.owner === run.owner &&
    token.namespace === run.namespace &&
    token.planId === run.planId
  );
}
/** Register a fresh frontend lifetime before publishing its graph mapping. An old
 * incomplete lifetime refuses replacement, even when restoring the same graph run.
 */
export async function beginNativeProjectFinalization(opts: {
  readonly scope: NativeProjectRunScope;
  readonly run: NativeProjectRun;
}): Promise<{
  readonly token: NativeProjectFinalizationToken;
  readonly complete: () => Promise<void>;
}> {
  const { root, hash } = await selected(opts.scope, opts.run, true);
  const token: NativeProjectFinalizationToken = {
    version: 1,
    attempt: randomBytes(16).toString("hex"),
    scope: hash,
    run: opts.run.run,
    owner: opts.run.owner,
    namespace: opts.run.namespace,
    planId: opts.run.planId,
  };
  await locked(root, async () => {
    const prior = await read(join(root, "active.json"));
    const completed = await read(join(root, "completed.json"));
    if (
      (prior &&
        !(
          matches(prior, hash, opts.run) &&
          completed &&
          same(prior, completed)
        )) ||
      (!prior && completed)
    ) {
      throw refused();
    }
    await write(root, "active.json", token);
  });
  return {
    token,
    complete: async () => {
      const current = await selected(opts.scope, opts.run, false);
      if (current.root !== root || current.hash !== hash) {
        throw refused();
      }
      await locked(root, async () => {
        const active = await read(join(root, "active.json"));
        if (!(active && same(active, token))) {
          throw refused();
        }
        await write(root, "completed.json", token);
      });
    },
  };
}
/** Capture while the caller still holds the saved active mapping, before cleanup. */
export async function captureNativeProjectFinalization(opts: {
  readonly scope: NativeProjectRunScope;
  readonly run: NativeProjectRun;
}): Promise<NativeProjectFinalizationToken> {
  const { root, hash } = await selected(opts.scope, opts.run, false);
  const active = await read(join(root, "active.json"));
  if (!(active && matches(active, hash, opts.run))) {
    throw refused();
  }
  return active;
}
/** Completion attests only this exact frontend attempt's successful finalizers.
 * Missing/stale completion never proves shutdown. Polling has a bounded deadline.
 */
export async function waitNativeProjectFinalization(opts: {
  readonly scope: NativeProjectRunScope;
  readonly run: NativeProjectRun;
  readonly token: NativeProjectFinalizationToken;
  readonly timeoutMs?: number;
}): Promise<void> {
  const timeout = opts.timeoutMs ?? 150_000;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 300_000 ||
    !isNativeProjectFinalizationToken(opts.token)
  ) {
    throw refused();
  }
  const { root, hash } = await selected(opts.scope, opts.run, false);
  if (!matches(opts.token, hash, opts.run)) {
    throw refused();
  }
  const end = performance.now() + timeout;
  while (true) {
    const completed = await read(join(root, "completed.json"));
    if (completed && same(completed, opts.token)) {
      return;
    }
    const active = await read(join(root, "active.json"));
    if (!(active && same(active, opts.token)) || performance.now() >= end) {
      throw refused();
    }
    await Bun.sleep(Math.min(100, Math.max(1, end - performance.now())));
  }
}
