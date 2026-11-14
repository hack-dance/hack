import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseSessionsMuxMode } from "../src/mux/mux-config.ts";
import {
  getMuxBackends,
  resolveDefaultBackendName,
  resolveMuxCandidates,
} from "../src/mux/mux-resolver.ts";

test("auto detects tmux only and never selects another backend", () => {
  expect([...getMuxBackends().keys()]).toEqual(["tmux"]);
  expect(resolveMuxCandidates({ mode: "auto" })).toEqual(["tmux"]);
  expect(resolveMuxCandidates({ mode: "none" })).toEqual([]);
  const backends = new Map(getMuxBackends());
  const tmux = backends.get("tmux");
  if (!tmux) {
    throw new Error("missing tmux adapter");
  }
  backends.set("tmux", { ...tmux, available: false });
  expect(resolveDefaultBackendName({ mode: "auto", backends })).toBeNull();
});

test("legacy zellij configuration fails with actionable v5 migration guidance", () => {
  for (const value of ["zellij", " ZELLIJ "]) {
    expect(() => parseSessionsMuxMode(value)).toThrow("removed in v5");
    expect(() => parseSessionsMuxMode(value)).toThrow("Install tmux");
    expect(() => parseSessionsMuxMode(value)).toThrow("unset sessions.mux");
  }
  expect(parseSessionsMuxMode("auto")).toBe("auto");
  expect(parseSessionsMuxMode("tmux")).toBe("tmux");
});

test("source CLI rejects zellij from environment, project and global configuration", async () => {
  const root = await mkdtemp("/tmp/hack-mux-config-");
  try {
    const home = join(root, "home");
    const project = join(root, "project");
    await mkdir(join(home, ".hack"), { recursive: true });
    await mkdir(join(project, ".hack"), { recursive: true });
    await writeFile(
      join(project, ".hack", "docker-compose.yml"),
      "services: {}\n"
    );
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      HACK_HOME: join(home, ".hack"),
      HACK_DAEMON_AUTOSTART_DISABLE: "1",
      HACK_NO_INTERACTIVE: "1",
    };
    const cli = resolve(import.meta.dir, "../index.ts");
    for (const source of ["environment", "project", "global"]) {
      await writeFile(
        join(project, ".hack", "hack.config.json"),
        JSON.stringify({
          name: "fixture",
          ...(source === "project" ? { sessions: { mux: "zellij" } } : {}),
        })
      );
      await writeFile(
        join(home, ".hack", "hack.config.json"),
        JSON.stringify(
          source === "global" ? { sessions: { mux: "zellij" } } : {}
        )
      );
      const child = Bun.spawn(
        [process.execPath, "--no-env-file", cli, "session", "list"],
        {
          cwd: project,
          env: {
            ...env,
            ...(source === "environment"
              ? { HACK_SESSIONS_MUX: "zellij" }
              : {}),
          },
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, source).not.toBe(0);
      expect(stdout + stderr).toContain(
        "sessions.mux=zellij was removed in v5"
      );
      expect(stdout + stderr).toContain("Install tmux");
      expect(stdout + stderr).not.toContain("at parseSessionsMuxMode");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("config set rejects zellij without poisoning the global configuration", async () => {
  const root = await mkdtemp("/tmp/hack-mux-write-");
  try {
    const config = join(root, "hack.config.json");
    await writeFile(config, '{"sessions":{"mux":"tmux"}}\n');
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        resolve(import.meta.dir, "../index.ts"),
        "config",
        "set",
        "--global",
        "sessions.mux",
        "zellij",
      ],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: root,
          HACK_HOME: root,
          HACK_GLOBAL_CONFIG_PATH: config,
          HACK_DAEMON_AUTOSTART_DISABLE: "1",
          HACK_NO_INTERACTIVE: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(1);
    expect(stdout + stderr).toContain("sessions.mux=zellij was removed in v5");
    expect(await Bun.file(config).json()).toEqual({
      sessions: { mux: "tmux" },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
