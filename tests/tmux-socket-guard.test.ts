import { expect, test } from "bun:test";
import {
  exec,
  execFile,
  execFileSync,
  execSync,
  fork,
  spawn,
  spawnSync,
} from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { privateTmux } from "./helpers/private-tmux.ts";
import {
  assertPrivateTmuxSocket,
  registerPrivateTmuxRoot,
} from "./helpers/tmux-socket-guard.ts";

const childEnvironmentScript =
  "process.stdout.write(JSON.stringify({root:process.env.TMUX_TMPDIR,tmux:process.env.TMUX??null}))";

test("Bun and Node children receive private sockets with omitted or minimal envs", async () => {
  const mux = privateTmux();
  const root = process.env.TMUX_TMPDIR ?? "";
  try {
    expect(root).not.toBe("");
    // A synthetic inherited value must never reach a child or be dereferenced.
    process.env.TMUX = "/not-a-real-socket/default,1,0";
    const minimal = { PATH: process.env.PATH };
    for (const env of [undefined, minimal]) {
      const synchronous = Bun.spawnSync(
        [process.execPath, "-e", childEnvironmentScript],
        { env, stdout: "pipe", stderr: "pipe" }
      );
      expect(synchronous.exitCode, synchronous.stderr.toString()).toBe(0);
      expect(JSON.parse(synchronous.stdout.toString())).toEqual({
        root,
        tmux: null,
      });
      const asynchronous = Bun.spawn({
        cmd: [process.execPath, "-e", childEnvironmentScript],
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await new Response(asynchronous.stdout).text();
      expect(await asynchronous.exited).toBe(0);
      expect(JSON.parse(output)).toEqual({ root, tmux: null });
    }
    expect(
      JSON.parse(
        execFileSync(process.execPath, ["-e", childEnvironmentScript], {
          env: minimal,
          encoding: "utf8",
        })
      )
    ).toEqual({ root, tmux: null });
    const nodeChild = spawnSync(
      process.execPath,
      ["-e", childEnvironmentScript],
      { env: minimal, encoding: "utf8" }
    );
    expect(nodeChild.status).toBe(0);
    expect(JSON.parse(nodeChild.stdout)).toEqual({ root, tmux: null });
    expect(
      execSync('printf "%s" "$TMUX_TMPDIR"', { env: minimal, encoding: "utf8" })
    ).toBe(root);
  } finally {
    mux.close();
  }
});

test("Node callback, shell, spawn and fork overloads preserve private child envs", async () => {
  const root = process.env.TMUX_TMPDIR ?? "";
  expect(root).not.toBe("");
  const env = {
    PATH: process.env.PATH,
    TMUX: "/not-a-real-socket/default,1,0",
  };
  const fileOutput = await new Promise<string>((resolveOutput, reject) => {
    execFile(
      process.execPath,
      ["-e", childEnvironmentScript],
      { env, encoding: "utf8" },
      (error, stdout) => {
        if (error) {
          reject(error);
        } else {
          resolveOutput(stdout);
        }
      }
    );
  });
  expect(JSON.parse(fileOutput)).toEqual({ root, tmux: null });
  const shellOutput = await new Promise<string>((resolveOutput, reject) => {
    exec('printf "%s" "$TMUX_TMPDIR"', { env }, (error, stdout) => {
      if (error) {
        reject(error);
      } else {
        resolveOutput(stdout);
      }
    });
  });
  expect(shellOutput).toBe(root);
  const spawned = spawn(process.execPath, ["-e", childEnvironmentScript], {
    env,
  });
  let spawnedOutput = "";
  spawned.stdout.on("data", (chunk) => {
    spawnedOutput += chunk.toString();
  });
  const [code] = await once(spawned, "close");
  expect(code).toBe(0);
  expect(JSON.parse(spawnedOutput)).toEqual({ root, tmux: null });
  const fixtureRoot = mkdtempSync("/tmp/hack-fork-env-");
  try {
    const script = join(fixtureRoot, "child.js");
    writeFileSync(script, childEnvironmentScript);
    const forked = fork(script, { env, silent: true });
    if (!forked.stdout) {
      throw new Error("Expected piped fork output");
    }
    let output = "";
    forked.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    const [status] = await once(forked, "close");
    expect(status).toBe(0);
    expect(JSON.parse(output)).toEqual({ root, tmux: null });
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test.skipIf(!Bun.which("tmux"))(
  "indirect real tmux calls from both child env forms land on the owned server",
  () => {
    const mux = privateTmux();
    try {
      const pids: number[] = [];
      for (const [index, env] of [
        undefined,
        { PATH: process.env.PATH },
      ].entries()) {
        const name = `indirect-${index}`;
        const script = `
        const made=Bun.spawnSync(["tmux","new-session","-d","-s",${JSON.stringify(name)},"sleep 60"],{stdout:"pipe",stderr:"pipe"});
        if(made.exitCode!==0)process.exit(2);
        const pid=Bun.spawnSync(["tmux","display-message","-p","#{pid}"],{stdout:"pipe",stderr:"pipe"});
        process.stdout.write(pid.stdout);
      `;
        const child = Bun.spawnSync([process.execPath, "-e", script], {
          env,
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(child.exitCode, child.stderr.toString()).toBe(0);
        pids.push(Number(child.stdout.toString().trim()));
      }
      const pid = Bun.spawnSync(["tmux", "display-message", "-p", "#{pid}"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(pid.exitCode).toBe(0);
      expect(pids).toEqual([
        Number(pid.stdout.toString().trim()),
        Number(pid.stdout.toString().trim()),
      ]);
      const sessions = Bun.spawnSync(
        ["tmux", "list-sessions", "-F", "#{session_name}"],
        { stdout: "pipe", stderr: "pipe" }
      );
      expect(sessions.exitCode).toBe(0);
      expect(sessions.stdout.toString().trim().split("\n").sort()).toEqual([
        "indirect-0",
        "indirect-1",
      ]);
    } finally {
      mux.close();
    }
  }
);

test("both spawn forms refuse an unsafe explicit tmux socket before executing", () => {
  const root = mkdtempSync("/tmp/hack-mux-refused-");
  try {
    // If the guard regresses, this harmless stand-in runs, never real tmux.
    const tmux = join(root, "tmux");
    writeFileSync(tmux, "#!/bin/sh\nexit 91\n", { mode: 0o755 });
    expect(() =>
      Bun.spawn([tmux, "list-sessions"], { env: { TMUX_TMPDIR: "/tmp" } })
    ).toThrow("tmux-socket-guard");
    expect(() =>
      Bun.spawnSync({
        cmd: [tmux, "list-sessions"],
        env: { TMUX_TMPDIR: "/tmp" },
      })
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
