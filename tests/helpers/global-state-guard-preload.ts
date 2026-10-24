/**
 * `bun test` preload (see `bunfig.toml`): fails loudly when a test or a test
 * file leaves process-global state changed, names the file, and restores the
 * environment, working directory, umask and exit code so later files do not
 * fail for an unrelated reason. Replaced functions are reported but kept;
 * `restoreGlobalState` explains why. Process listeners are reported and kept
 * per test, and put back at the file boundary (`restoreProcessListeners`).
 *
 * Two checks run:
 * - Per test: the state before the global `beforeEach` must match the state
 *   after the global `afterEach`. Bun runs preload `beforeEach` hooks before a
 *   file's own hooks and preload `afterEach` hooks after them, so a file's
 *   `beforeEach`/`afterEach` pair that restores correctly passes. A mismatch
 *   fails that test, restores the pre-test environment and cwd, and names the file.
 * - Per file: when Bun loads the next test file, the state must match the
 *   state before the previous file loaded. This catches module-scope and
 *   `beforeAll`/`afterAll` leaks, including an `afterAll` that never ran its
 *   restore. A mismatch is reported at once, the pre-file environment and
 *   process listeners are restored, and the run fails from the preload
 *   `afterAll` with every leaking file. Restoring the listeners keeps a
 *   finished file's leftover handler from being run or consumed by a later
 *   test's `process.emit`, which would blame that later test (HACK-1416).
 *   This check also compares Bun's native environment (one short `/usr/bin/env`
 *   child per file), which keeps a proxy key that a test set and then deleted
 *   although `process.env` no longer shows it.
 *
 * Bun calls a runtime plugin's `onLoad` for a test file after the previous
 * file's `afterAll` hooks and before the new file's module code, which makes
 * it the file boundary. The plugin returns the file's source unchanged.
 */
import { afterAll, afterEach, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { relative } from "node:path";

import {
  captureGlobalState,
  captureNativeEnv,
  diffGlobalState,
  diffNativeEnv,
  disableNativeProxies,
  type GlobalStateSnapshot,
  type NativeEnv,
  restoreGlobalState,
  restoreProcessListeners,
} from "./global-state-guard.ts";

/**
 * Environment keys a test file may change without a restore. Every entry
 * needs a reason. Keep this list empty unless a change is outside the tests'
 * control.
 */
const ALLOWED_ENV_CHANGES: ReadonlyMap<string, string> = new Map();

const ROOT = process.cwd();
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

let fileBaseline: GlobalStateSnapshot = captureGlobalState();
let nativeBaseline: NativeEnv | undefined = captureNativeEnv();
let currentFile: string | undefined;
const fileLeaks: string[] = [];

function displayPath(path: string | undefined): string {
  return path === undefined ? "(preload)" : relative(ROOT, path);
}

function reportFileLeak(message: string, repair: string): void {
  fileLeaks.push(message);
  console.error(`\n[global-state-guard] ${message}. ${repair}\n`);
}

/**
 * Checks Bun's native environment after `process.env` was compared and
 * restored, so only a change that `process.env` cannot show remains: a proxy
 * key that was set and then deleted (see `captureNativeEnv`).
 */
function checkNativeEnv(): void {
  const current = captureNativeEnv();
  if (nativeBaseline === undefined || current === undefined) {
    nativeBaseline = current;
    return;
  }
  const keys = diffNativeEnv(nativeBaseline, current);
  if (keys.length > 0) {
    reportFileLeak(
      `${displayPath(currentFile)} left Bun's native environment changed after the file finished: ${keys.map((key) => `native env ${key} changed`).join("; ")}. process.env no longer shows it, but fetch proxies and Bun.spawn without env still use it; restore proxy keys with restoreEnv from tests/helpers/env.ts`,
      "Bun cannot take a deleted key back, so the guard set NO_PROXY=* in Bun's native environment for the rest of the run: later fetches go direct."
    );
    disableNativeProxies(fileBaseline);
  }
  nativeBaseline = captureNativeEnv();
}

function checkFileBoundary(): void {
  const changes = diffGlobalState(fileBaseline, captureGlobalState(), {
    allowedEnvChanges: ALLOWED_ENV_CHANGES,
  });
  if (changes.length > 0) {
    reportFileLeak(
      `${displayPath(currentFile)} left process state changed after the file finished: ${changes.join("; ")}`,
      "Restored the environment, cwd and process listeners from before the file so later files run clean."
    );
    restoreGlobalState(fileBaseline);
    restoreProcessListeners(fileBaseline);
  }
  checkNativeEnv();
  fileBaseline = captureGlobalState();
}

Bun.plugin({
  name: "global-state-guard",
  setup(build) {
    build.onLoad({ filter: TEST_FILE }, (args) => {
      if (args.path === Bun.main && args.path !== currentFile) {
        checkFileBoundary();
        currentFile = args.path;
      }
      const loader = args.path.endsWith("x")
        ? args.path.endsWith(".jsx")
          ? "jsx"
          : "tsx"
        : args.path.endsWith(".ts")
          ? "ts"
          : "js";
      return { contents: readFileSync(args.path, "utf8"), loader };
    });
  },
});

let testBaseline: GlobalStateSnapshot | undefined;

beforeEach(() => {
  testBaseline = captureGlobalState();
});

afterEach(() => {
  const before = testBaseline;
  testBaseline = undefined;
  if (before === undefined) {
    return;
  }
  const changes = diffGlobalState(before, captureGlobalState(), {
    allowedEnvChanges: ALLOWED_ENV_CHANGES,
  });
  if (changes.length === 0) {
    return;
  }
  restoreGlobalState(before);
  throw new Error(
    `[global-state-guard] a test in ${displayPath(Bun.main)} left process state changed: ${changes.join("; ")}. Restore it in try/finally or afterEach; the guard restored the pre-test environment and cwd.`
  );
});

afterAll(() => {
  checkFileBoundary();
  if (fileLeaks.length > 0) {
    throw new Error(
      `[global-state-guard] ${fileLeaks.length} test file(s) leaked process state:\n${fileLeaks.join("\n")}`
    );
  }
});
