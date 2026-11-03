import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stopSessionBeforeReleasingHelpers } from "../src/commands/project.ts";
import {
  readLifecycleState,
  upsertLifecycleStateEntry,
} from "../src/lib/lifecycle-runtime.ts";
import { stopLifecycleProcessController } from "../src/lib/project-lifecycle-controller.ts";
import {
  inspectLifecycleSession,
  LifecycleSessionPresenceUnknownError,
} from "../src/lib/project-lifecycle-sessions.ts";
import { MuxCommandTimeoutError } from "../src/mux/mux-backend.ts";
import { createTmuxBackend } from "../src/mux/tmux-backend.ts";

/**
 * A timed-out tmux command is killed and reported as an unknown outcome,
 * never as an empty or absent result: a hung `tmux list-sessions` must not
 * read as "no sessions", or up/down would overwrite or retire a healthy
 * owned session's state.
 */

const roots: string[] = [];
const originalPath = process.env.PATH;
const originalTimeout = process.env.HACK_MUX_COMMAND_TIMEOUT_MS;

afterEach(async () => {
  process.env.PATH = originalPath;
  if (originalTimeout === undefined) {
    Reflect.deleteProperty(process.env, "HACK_MUX_COMMAND_TIMEOUT_MS");
  } else {
    process.env.HACK_MUX_COMMAND_TIMEOUT_MS = originalTimeout;
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function hangingTmux(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "hack-mux-timeout-"));
  roots.push(root);
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  // Every query hangs, like a wedged tmux server.
  await writeFile(join(bin, "tmux"), "#!/bin/sh\nsleep 30\n", {
    mode: 0o755,
  });
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  process.env.HACK_MUX_COMMAND_TIMEOUT_MS = "200";
}

test("a timed-out tmux session listing throws instead of returning no sessions", async () => {
  await hangingTmux();
  const backend = createTmuxBackend();
  const started = performance.now();
  await expect(backend.listSessions()).rejects.toBeInstanceOf(
    MuxCommandTimeoutError
  );
  expect(performance.now() - started).toBeLessThan(5000);
});

test("a timed-out tmux presence query is unknown, and an ownership-token read throws", async () => {
  await hangingTmux();
  const backend = createTmuxBackend();
  expect(await backend.readSessionPresence?.({ name: "demo" })).toBe("unknown");
  await expect(
    backend.readLifecycleOwnerToken?.({ name: "demo" })
  ).rejects.toBeInstanceOf(MuxCommandTimeoutError);
});

test("a listing that omits the session plus a timed-out presence query is unknown: down keeps the entry and helpers", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-mux-unlisted-"));
  roots.push(root);
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  // The listing answers without the session; the exact query hangs.
  await writeFile(
    join(bin, "tmux"),
    '#!/bin/sh\ncase "$*" in *list-sessions*) exit 0 ;; *has-session*) sleep 30 ;; esac\nexit 1\n',
    { mode: 0o755 }
  );
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  process.env.HACK_MUX_COMMAND_TIMEOUT_MS = "200";
  const backend = createTmuxBackend();
  const projectDir = join(root, ".hack");
  await mkdir(projectDir, { recursive: true });
  const entry = {
    composeProject: "demo",
    projectName: "demo",
    branch: null,
    sessionName: "demo--lifecycle",
    backend: "tmux" as const,
    ownershipToken: "token-a",
    definitionHash: "sha256:test",
    processes: [],
    updatedAt: new Date().toISOString(),
  };
  await upsertLifecycleStateEntry({ projectDir, entry });
  // The inspection boundary: unknown, never absence (which would decide
  // "create" and let creation revalidation pass).
  await expect(
    inspectLifecycleSession({
      backend,
      entry,
      expectedSessionName: entry.sessionName,
      expectedProjectRoot: root,
      expectedDefinitionHash: entry.definitionHash,
    })
  ).rejects.toBeInstanceOf(LifecycleSessionPresenceUnknownError);
  // hack down's stop: fails, keeps the entry, and the helpers stay held.
  const outcome = await stopSessionBeforeReleasingHelpers({
    stopSession: () =>
      stopLifecycleProcessController({
        project: { projectRoot: root, projectDir },
        definitionHash: entry.definitionHash,
        projectName: "demo",
        branch: null,
        composeProject: entry.composeProject,
        mux: () =>
          Promise.resolve({
            mode: "tmux",
            backends: new Map([["tmux", backend]]),
          }),
      }),
    releaseHelpers: () => Promise.resolve([]),
    heldHelperNames: () => Promise.resolve(["mail"]),
  });
  expect(outcome.sessionStopFailed?.error).toBeInstanceOf(
    LifecycleSessionPresenceUnknownError
  );
  expect(outcome.notReleased).toEqual(["mail"]);
  expect(
    (await readLifecycleState({ projectDir })).map(
      (kept) => kept.ownershipToken
    )
  ).toEqual(["token-a"]);
});
