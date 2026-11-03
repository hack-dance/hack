import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * HACK-1797: without a UTF-8 locale, tmux replaces the tab separators in
 * client output with `_`, so a tab-split session listing never matches the
 * lifecycle session. `up` then tried to create a duplicate and `down` skipped
 * the owned session. This drives real tmux on a private socket, in a child
 * process with `LC_ALL=C`, so the test process environment stays untouched.
 */
const tmuxPath = Bun.which("tmux");
const backendModule = resolve(import.meta.dir, "../src/mux/tmux-backend.ts");
const sessionName = "hack-locale-probe--lifecycle";
let socketDir = "";

function isolatedEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMUX_TMPDIR: socketDir,
    LC_ALL: "C",
    LANG: "C",
  };
}

beforeAll(async () => {
  // Unix socket paths are length-limited, so keep the directory short.
  socketDir = await mkdtemp("/tmp/hack-tmux-");
});

afterAll(async () => {
  if (tmuxPath && socketDir) {
    Bun.spawnSync([tmuxPath, "kill-server"], {
      env: isolatedEnv(),
      stdout: "ignore",
      stderr: "ignore",
    });
  }
  if (socketDir) {
    await rm(socketDir, { recursive: true, force: true });
  }
});

test.skipIf(!tmuxPath)(
  "tmux session listing matches exact names without a UTF-8 locale",
  async () => {
    const script = `
      const { createTmuxBackend } = await import(${JSON.stringify(backendModule)});
      const backend = createTmuxBackend();
      const created = await backend.createSession({
        name: ${JSON.stringify(sessionName)},
        cwd: "/tmp",
      });
      const sessions = await backend.listSessions();
      process.stdout.write(JSON.stringify({
        created: created.ok,
        sessions: sessions.map((s) => ({ name: s.name, windows: s.windows })),
      }));
    `;
    const child = Bun.spawnSync(
      [process.execPath, "--no-env-file", "-e", script],
      { env: isolatedEnv(), stdout: "pipe", stderr: "pipe" }
    );
    const stderr = child.stderr.toString();
    expect(child.exitCode, stderr).toBe(0);
    const result = JSON.parse(child.stdout.toString()) as {
      readonly created: boolean;
      readonly sessions: readonly {
        readonly name: string;
        readonly windows: number | null;
      }[];
    };

    expect(result.created).toBe(true);
    expect(result.sessions).toContainEqual({ name: sessionName, windows: 1 });
  },
  20_000
);
