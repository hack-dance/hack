import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  errorResultFromUnknown,
  HackCliError,
  renderCliResult,
} from "../src/lib/cli-result.ts";
import { tryLegacyComposeAdoptedCommand } from "../src/lib/native-compose-adoption-command.ts";
import * as generation from "../src/lib/native-compose-adoption-generation.ts";
import * as marker from "../src/lib/native-compose-adoption-marker.ts";
import { createCompletedJobFixtureStartDiagnostics } from "./e2e/scenarios/native-compose-adoption-job-diagnostics.ts";
import { restoreEnv } from "./helpers/env.ts";

/**
 * Drives the adopted command's own refusal and cancellation throw sites and
 * maps what they throw to the diagnostics' closed token. Diagnostics match the
 * command's fixed messages exactly (HACK-1432), so a throw site that stops
 * using `LEGACY_COMPOSE_ADOPTED_COMMAND_MESSAGES` would turn its token into
 * `other` (HACK-1452). The store is a stand-in: these sites sit after the
 * store opens, and only the command's own handling is under test here.
 */
const CANARY = "synthetic-private-adopted-command-canary";
let root: string;
let priorBackend: string | undefined;
const restores: (() => void)[] = [];
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "adopted-command-")));
  priorBackend = process.env.HACK_RUNTIME_BACKEND;
  process.env.HACK_RUNTIME_BACKEND = "compose";
  const selection = spyOn(
    marker,
    "inspectLegacyComposeAdoptionSelection"
  ).mockImplementation(async () => "active");
  restores.push(() => selection.mockRestore());
});
afterEach(async () => {
  for (const restore of restores.splice(0).reverse()) {
    restore();
  }
  restoreEnv("HACK_RUNTIME_BACKEND", priorBackend);
  await rm(root, { recursive: true, force: true });
});

type Store = generation.LegacyComposeAdoptedGenerationStore;

/** Opens `store` in place of the real generation store; never touches Docker. */
function useStore(store: Partial<Store>) {
  const closed = { count: 0 };
  const opened = spyOn(
    generation,
    "openLegacyComposeAdoptedGenerationStore"
  ).mockImplementation(
    async () =>
      ({
        close: async () => {
          closed.count += 1;
        },
        ...store,
      }) as Store
  );
  restores.push(() => opened.mockRestore());
  return closed;
}

/**
 * The command's own SIGTERM listener, called directly as the OS would. The
 * listener is found by difference, so no signal is sent to this process and
 * no other listener runs.
 */
function cancelFrom(before: readonly unknown[]) {
  const added = process
    .listeners("SIGTERM")
    .filter((listener) => !before.includes(listener));
  expect(added).toHaveLength(1);
  added[0]?.("SIGTERM");
}

async function rejection(pending: Promise<unknown>): Promise<HackCliError> {
  let caught: unknown;
  try {
    await pending;
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HackCliError);
  if (!(caught instanceof HackCliError)) {
    throw new Error("missing adopted command refusal");
  }
  expect(
    JSON.stringify(errorResultFromUnknown({ error: caught }))
  ).not.toContain(CANARY);
  return caught;
}

/** The closed token the completed-job diagnostics name for this refusal. */
function token(error: HackCliError): string {
  const messages: string[] = [];
  createCompletedJobFixtureStartDiagnostics({
    operation: "up",
    scope: "alpha",
    log: (message) => messages.push(message),
  }).cliOutcome({
    exitCode: 1,
    timedOut: false,
    stdout: renderCliResult({ result: errorResultFromUnknown({ error }) }),
  });
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain("code=E_CONFIG_INVALID");
  return messages[0]?.match(/ refusal=(\S+)$/)?.[1] ?? "missing";
}

test("an unexpected refusal after the store opens ends in the adopted-refused token", async () => {
  const closed = useStore({
    loadActive: async () => {
      throw new Error(CANARY);
    },
  });
  const error = await rejection(
    tryLegacyComposeAdoptedCommand({ cwd: root, operation: "ps" })
  );
  expect(error.code).toBe("E_CONFIG_INVALID");
  expect(token(error)).toBe("adopted-refused");
  expect(closed.count).toBe(1);
});

test("cancellation before an observed lease runs ends in the adopted-cancelled token", async () => {
  const before = process.listeners("SIGTERM");
  let ran = false;
  const closed = useStore({
    loadActive: async () => Object.freeze({}) as never,
    withLease: async ({ run }) => {
      cancelFrom(before);
      ran = true;
      // The command checks its signal before reading any lease input.
      return await run({} as never);
    },
  });
  const error = await rejection(
    tryLegacyComposeAdoptedCommand({ cwd: root, operation: "ps" })
  );
  expect(ran).toBe(true);
  expect(error.code).toBe("E_CONFIG_INVALID");
  expect(token(error)).toBe("adopted-cancelled");
  expect(closed.count).toBe(1);
  expect(process.listeners("SIGTERM")).toEqual(before);
});

test("cancellation before a journaled mutation runs ends in the adopted-cancelled token", async () => {
  const before = process.listeners("SIGTERM");
  let ran = false;
  const closed = useStore({
    loadActive: async () => Object.freeze({}) as never,
    withMutation: async ({ run }) => {
      cancelFrom(before);
      ran = true;
      // The command checks its signal before it reads input or spawns Docker.
      await run({} as never);
      return 0;
    },
  });
  const error = await rejection(
    tryLegacyComposeAdoptedCommand({
      cwd: root,
      operation: "up",
      detach: true,
    })
  );
  expect(ran).toBe(true);
  expect(error.code).toBe("E_CONFIG_INVALID");
  expect(token(error)).toBe("adopted-cancelled");
  expect(closed.count).toBe(1);
  expect(process.listeners("SIGTERM")).toEqual(before);
});
