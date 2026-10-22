/**
 * `bun test` preload (see `bunfig.toml`): fails loudly when a test or a test
 * file leaves process-global state changed, names the file, and restores the
 * environment, working directory, umask and exit code so later files do not
 * fail for an unrelated reason. Replaced functions and process listeners are
 * reported but kept; `restoreGlobalState` explains why.
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
 *   restore. A mismatch is reported at once, the pre-file environment is restored,
 *   and the run fails from the preload `afterAll` with every leaking file.
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
  diffGlobalState,
  type GlobalStateSnapshot,
  restoreGlobalState,
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
let currentFile: string | undefined;
const fileLeaks: string[] = [];

function displayPath(path: string | undefined): string {
  return path === undefined ? "(preload)" : relative(ROOT, path);
}

function checkFileBoundary(): void {
  const changes = diffGlobalState(fileBaseline, captureGlobalState(), {
    allowedEnvChanges: ALLOWED_ENV_CHANGES,
  });
  if (changes.length > 0) {
    const message = `${displayPath(currentFile)} left process state changed after the file finished: ${changes.join("; ")}`;
    fileLeaks.push(message);
    console.error(
      `\n[global-state-guard] ${message}. Restored the environment and cwd from before the file so later files run clean.\n`
    );
    restoreGlobalState(fileBaseline);
  }
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
