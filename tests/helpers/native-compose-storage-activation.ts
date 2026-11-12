import { afterEach } from "bun:test";
import { join, resolve } from "node:path";
import { openNativeComposeGenerationStore } from "../../src/lib/native-compose-generation.ts";
import { captureCompletedJobFixtureCommand } from "../e2e/scenarios/native-compose-adoption-job-worktrees.ts";
import { invoke } from "./native-compose-command.ts";
import { privateCliEnv } from "./private-cli-env.ts";

export const STORAGE_PROOF_TIMEOUT_MS = 30_000;
export const COMMAND_CAPTURE_TIMEOUT_MS = 4 * STORAGE_PROOF_TIMEOUT_MS;
export const storage = {
  data: { kind: "persistent", scope: "worktree" },
} as const;
// Each synthetic carrier has the ordinary finite 30s proof budget. The wrapper
// accommodates several real source-CLI transactions, not an unbounded helper.
export function command(root: string, args = ["up", "--detach", "--json"]) {
  return invoke(
    root,
    args,
    STORAGE_PROOF_TIMEOUT_MS,
    COMMAND_CAPTURE_TIMEOUT_MS
  );
}
/**
 * Each file registers its own hook and lifetime fence. An unconfirmed capture
 * retains its private fixture and refuses further calls within that file.
 * Between files, the shard runner owns the test process lifetime.
 */
export function createStorageActivationContext() {
  let coldLifetimeUnknown = false;
  let activeColdCases = 0;
  afterEach(() => {
    if (activeColdCases > 0) {
      coldLifetimeUnknown = true;
    }
  });
  async function ownedColdCase(
    body: (owner: {
      readonly cleanupAllowed: () => boolean;
      readonly retain: () => void;
      readonly invoke: (
        root: string,
        args: readonly string[]
      ) => Promise<{ code: number; stdout: string; stderr: string }>;
    }) => Promise<void>,
    opts: { readonly commandCaptureTimeoutMs?: number } = {}
  ) {
    if (coldLifetimeUnknown) {
      throw new Error(
        "Prior cold storage case lifetime is unconfirmed; fixture retained."
      );
    }
    let active = true;
    activeColdCases++;
    let capture = 0;
    const retain = () => {
      coldLifetimeUnknown = true;
    };
    const cleanupAllowed = () => {
      if (active) {
        retain();
      }
      return !coldLifetimeUnknown;
    };
    try {
      await body({
        cleanupAllowed,
        retain,
        invoke: async (root, args) => {
          if (coldLifetimeUnknown || !active) {
            throw new Error(
              "Cold storage case lifetime is unconfirmed; fixture retained."
            );
          }
          let result: Awaited<
            ReturnType<typeof captureCompletedJobFixtureCommand>
          >;
          try {
            result = await captureCompletedJobFixtureCommand({
              argv: [
                process.execPath,
                resolve(import.meta.dir, "../../index.ts"),
                "--path",
                root,
                ...args,
              ],
              cwd: root,
              // A private HOME under the fixture, never the contributor's, and
              // an isolated Docker client config.
              env: privateCliEnv({
                root,
                env: {
                  LANG: "C",
                  PATH: `${root}:/usr/bin:/bin`,
                  HACK_HOME: join(root, "home"),
                  HACK_GLOBAL_CONFIG_PATH: join(root, "global.json"),
                  HACK_CONFIG_COMPILER_BINARY: join(root, "compiler"),
                  HACK_RUNTIME_BACKEND: "compose",
                  HACK_LOGGER: "console",
                  HACK_NATIVE_COMPOSE_PHASE_TRACE: "1",
                  HACK_COMPOSE_STARTUP_TIMEOUT_MS: String(
                    STORAGE_PROOF_TIMEOUT_MS
                  ),
                  CI: "1",
                  HACK_EXECUTION_MODE: "non_interactive",
                },
              }),
              captures: join(root, `storage-capture-${capture++}`),
              timeoutMs:
                opts.commandCaptureTimeoutMs ?? COMMAND_CAPTURE_TIMEOUT_MS,
              onUnconfirmed: retain,
            });
          } catch (error) {
            retain();
            throw error;
          }
          return {
            code: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          };
        },
      });
    } finally {
      active = false;
      activeColdCases--;
    }
  }
  return { ownedColdCase };
}
export async function saved(root: string) {
  const store = await openNativeComposeGenerationStore({
    projectRoot: root,
    instance: null,
    mode: "saved",
  });
  try {
    return await store.loadCurrent();
  } finally {
    await store.close();
  }
}
export async function requests(root: string): Promise<string[][]> {
  return (await Bun.file(join(root, "requests")).text())
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
export async function operations(root: string) {
  return (await Bun.file(join(root, "storage-operations")).text())
    .trim()
    .split("\n");
}
export async function disposition(root: string, code: number): Promise<string> {
  const path = join(root, "storage-operations");
  const observed = (await Bun.file(path).exists())
    ? await operations(root)
    : [];
  return JSON.stringify({
    code,
    roots: observed.filter((value) => value === "root").length,
    seeds: observed.filter((value) => value === "seed").length,
    verifications: observed.filter((value) => value === "verify").length,
    engine: await Bun.file(join(root, "engine")).exists(),
  });
}
