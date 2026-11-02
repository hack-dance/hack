import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { resolveGlobalConfigPath } from "./config-paths.ts";
import { isRecord } from "./guards.ts";
import {
  NATIVE_CONFIG_INPUT_LIMIT,
  NativeConfigCompilerError,
} from "./native-config-compiler.ts";

function invalidPolicy(): NativeConfigCompilerError {
  return new NativeConfigCompilerError(
    "E_CONFIG_INPUT",
    "Cannot read native routing global policy: expected a stable bounded regular JSON object with a string default_domain; values omitted."
  );
}
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new NativeConfigCompilerError(
      "E_COMPILER_CANCELLED",
      "Native routing policy acquisition was cancelled."
    );
  }
}
function same(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}
async function optionalStat(path: string): Promise<Stats | null> {
  return await lstat(path).catch((error: unknown) => {
    if (isRecord(error) && error.code === "ENOENT") {
      return null;
    }
    throw invalidPolicy();
  });
}
async function directories(
  path: string
): Promise<readonly { path: string; info: Stats | null }[]> {
  const result: { path: string; info: Stats | null }[] = [];
  let current = dirname(path);
  while (true) {
    const info = await optionalStat(current);
    if (
      info &&
      (!info.isDirectory() || (await realpath(current)) !== current)
    ) {
      throw invalidPolicy();
    }
    result.push({ path: current, info });
    const parent = dirname(current);
    if (parent === current) {
      return result;
    }
    current = parent;
  }
}
async function recheckDirectories(
  entries: Awaited<ReturnType<typeof directories>>
): Promise<void> {
  for (const entry of entries) {
    const now = await optionalStat(entry.path);
    if (
      entry.info === null
        ? now !== null
        : !now?.isDirectory() ||
          now.dev !== entry.info.dev ||
          now.ino !== entry.info.ino ||
          (await realpath(entry.path)) !== entry.path
    ) {
      throw invalidPolicy();
    }
  }
}

/** Read only the routing scalar from global policy; no defaulting, domain validation, keys or writes. */
export async function acquireNativeGlobalDomain(
  opts: { readonly signal?: AbortSignal } = {}
): Promise<string | undefined> {
  try {
    cancelled(opts.signal);
    const path = resolve(resolveGlobalConfigPath());
    const parents = await directories(path);
    const observed = await optionalStat(path);
    if (!observed) {
      await recheckDirectories(parents);
      cancelled(opts.signal);
      return undefined;
    }
    if (
      !observed.isFile() ||
      observed.size > NATIVE_CONFIG_INPUT_LIMIT ||
      (observed.mode & 0o444) === 0 ||
      (await realpath(path)) !== path
    ) {
      throw invalidPolicy();
    }
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      const before = await file.stat();
      if (!(before.isFile() && same(observed, before))) {
        throw invalidPolicy();
      }
      const buffer = Buffer.alloc(before.size + 1);
      let size = 0;
      while (size < buffer.length) {
        cancelled(opts.signal);
        const read = await file.read(buffer, size, buffer.length - size, size);
        if (read.bytesRead === 0) {
          break;
        }
        size += read.bytesRead;
      }
      const after = await file.stat();
      const current = await optionalStat(path);
      if (
        size !== before.size ||
        !current?.isFile() ||
        !same(before, after) ||
        !same(before, current) ||
        (await realpath(path)) !== path
      ) {
        throw invalidPolicy();
      }
      await recheckDirectories(parents);
      cancelled(opts.signal);
      const parsed: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(0, size)
        )
      );
      if (
        !isRecord(parsed) ||
        (Object.hasOwn(parsed, "default_domain") &&
          typeof parsed.default_domain !== "string")
      ) {
        throw invalidPolicy();
      }
      const domain = parsed.default_domain;
      return Object.hasOwn(parsed, "default_domain") &&
        typeof domain === "string"
        ? domain
        : undefined;
    } finally {
      await file.close();
    }
  } catch (error: unknown) {
    if (
      error instanceof NativeConfigCompilerError &&
      error.code === "E_COMPILER_CANCELLED"
    ) {
      throw error;
    }
    throw invalidPolicy();
  }
}
