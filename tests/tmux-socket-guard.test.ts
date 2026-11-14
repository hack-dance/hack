import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  assertPrivateTmuxSocket,
  registerPrivateTmuxRoot,
} from "./helpers/tmux-socket-guard.ts";

test("both spawn forms refuse tmux without a private socket before executing", () => {
  const root = mkdtempSync("/tmp/hack-mux-refused-");
  try {
    // If the guard regresses, this harmless stand-in runs, never real tmux.
    const tmux = join(root, "tmux");
    writeFileSync(tmux, "#!/bin/sh\nexit 91\n", { mode: 0o755 });
    expect(() => Bun.spawn([tmux, "list-sessions"], { env: {} })).toThrow(
      "tmux-socket-guard"
    );
    expect(() =>
      Bun.spawnSync({ cmd: [tmux, "list-sessions"], env: {} })
    ).toThrow("tmux-socket-guard");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  expect(() =>
    assertPrivateTmuxSocket(["tmux", "list-sessions"], {
      TMUX: "/user/default,1,0",
      TMUX_TMPDIR: process.env.TMUX_TMPDIR,
    })
  ).toThrow("inherited TMUX");
});

test("tmux socket guard accepts private roots and rejects shared directories", () => {
  const root = mkdtempSync("/tmp/hack-socket-guard-");
  const unregister = registerPrivateTmuxRoot(root);
  try {
    expect(() =>
      assertPrivateTmuxSocket(["tmux", "list-sessions"], { TMUX_TMPDIR: root })
    ).not.toThrow();
    for (const args of [
      ["tmux", "-S/tmp/default", "list-sessions"],
      ["tmux", "-uS/tmp/default", "list-sessions"],
      [
        "tmux",
        "-S",
        join(root, "socket"),
        "-S",
        "/tmp/default",
        "list-sessions",
      ],
    ]) {
      expect(() =>
        assertPrivateTmuxSocket(args, { TMUX_TMPDIR: root })
      ).toThrow("tmux-socket-guard");
    }
    expect(() =>
      assertPrivateTmuxSocket(
        ["tmux", "-S", join(root, "socket"), "list-sessions"],
        {}
      )
    ).not.toThrow();
    chmodSync(root, 0o755);
    expect(() =>
      assertPrivateTmuxSocket(["tmux", "list-sessions"], { TMUX_TMPDIR: root })
    ).toThrow("0700");
    chmodSync(root, 0o700);
    unregister();
    expect(() =>
      assertPrivateTmuxSocket(
        ["tmux", "-S", join(root, "default"), "list-sessions"],
        {}
      )
    ).toThrow("registered");
  } finally {
    unregister();
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(!Bun.which("tmux"))(
  "preload stops its private tmux server after a failing test",
  async () => {
    const root = mkdtempSync("/tmp/hack-mux-failure-");
    try {
      const receipt = join(root, "socket-root");
      const fixture = join(root, "failure.test.ts");
      writeFileSync(
        fixture,
        `
      import { test, expect } from "bun:test";
      import { writeFileSync } from "node:fs";
      test("deliberate failure after starting a session", () => {
        const child = Bun.spawnSync(["tmux", "new-session", "-d", "-s", "owned-test", "sleep 60"]);
        expect(child.exitCode).toBe(0);
        const pid = Bun.spawnSync(["tmux", "display-message", "-p", "#{pid}"]);
        expect(pid.exitCode).toBe(0);
        writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ root: process.env.TMUX_TMPDIR, pid: Number(pid.stdout.toString().trim()) }));
        throw new Error("expected fixture failure");
      });
    `
      );
      const child = Bun.spawnSync([process.execPath, "test", fixture], {
        cwd: resolve(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 20_000,
      });
      expect(child.exitCode).toBe(1);
      expect(child.stderr.toString()).toContain("expected fixture failure");
      const owned = JSON.parse(readFileSync(receipt, "utf8")) as {
        root: string;
        pid: number;
      };
      expect(existsSync(owned.root)).toBe(false);
      // kill-server acknowledges before tmux has finished exiting. Bound the
      // observation; a defunct process is no live server, even before reaping.
      let stopped = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        const server = Bun.spawnSync(
          ["ps", "-p", String(owned.pid), "-o", "stat="],
          {
            stdout: "pipe",
            stderr: "pipe",
            timeout: 1000,
          }
        );
        stopped =
          server.exitCode === 1 ||
          server.stdout.toString().trim().startsWith("Z");
        if (stopped) {
          break;
        }
        await Bun.sleep(50);
      }
      expect(stopped).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);
