import { afterEach, beforeEach, expect } from "bun:test";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { testIntegration } from "./helpers/ci.ts";

const originalGlobalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;

beforeEach(() => {
  process.env.HACK_GLOBAL_CONFIG_PATH = join(
    tmpdir(),
    `hack-global-config-${Date.now()}-${Math.random()}.json`
  );
});

afterEach(() => {
  if (originalGlobalConfigPath === undefined) {
    process.env.HACK_GLOBAL_CONFIG_PATH = undefined;
  } else {
    process.env.HACK_GLOBAL_CONFIG_PATH = originalGlobalConfigPath;
  }
});

testIntegration(
  "tickets extension: create/list/show with isolated git ref",
  { timeout: 60_000 },
  async () => {
    const root = await mkdirTempDir({ prefix: "hack-cli-tickets-e2e-" });
    const projectDir = join(root, "project");
    const remoteDir = join(root, "remote.git");

    await mkdir(projectDir, { recursive: true });
    await copyDir({
      from: resolve(import.meta.dir, "../examples/tickets"),
      to: projectDir,
    });

    await run({ cwd: projectDir, cmd: ["git", "init"] });
    await run({
      cwd: projectDir,
      cmd: ["git", "config", "user.email", "tests@hack"],
    });
    await run({
      cwd: projectDir,
      cmd: ["git", "config", "user.name", "hack-cli-tests"],
    });
    await run({ cwd: projectDir, cmd: ["git", "add", "-A"] });
    await run({ cwd: projectDir, cmd: ["git", "commit", "-m", "init"] });

    await run({ cwd: root, cmd: ["git", "init", "--bare", remoteDir] });
    await run({
      cwd: projectDir,
      cmd: ["git", "remote", "add", "origin", remoteDir],
    });
    await run({
      cwd: projectDir,
      cmd: ["git", "push", "-u", "origin", "HEAD:main"],
    });

    const beforeHead = (
      await run({
        cwd: projectDir,
        cmd: ["git", "rev-parse", "--abbrev-ref", "HEAD"],
      })
    ).stdout.trim();

    const created = await runHack({
      cwd: projectDir,
      args: ["x", "tickets", "create", "--title", "First ticket", "--json"],
    });
    const createdJson = JSON.parse(created.stdout) as {
      ticket: { ticketId: string };
    };
    expect(createdJson.ticket.ticketId).toMatch(/^T-\d{5}$/);

    const afterHead = (
      await run({
        cwd: projectDir,
        cmd: ["git", "rev-parse", "--abbrev-ref", "HEAD"],
      })
    ).stdout.trim();
    expect(afterHead).toBe(beforeHead);

    const listed = await runHack({
      cwd: projectDir,
      args: ["x", "tickets", "list", "--json"],
    });
    const listJson = JSON.parse(listed.stdout) as {
      tickets: { ticketId: string; title: string }[];
    };
    expect(listJson.tickets.length).toBe(1);
    expect(listJson.tickets[0]?.title).toBe("First ticket");

    const shown = await runHack({
      cwd: projectDir,
      args: ["x", "tickets", "show", createdJson.ticket.ticketId, "--json"],
    });
    const showJson = JSON.parse(shown.stdout) as {
      ticket: { ticketId: string; title: string };
      events: { type: string }[];
    };
    expect(showJson.ticket.ticketId).toBe(createdJson.ticket.ticketId);
    expect(showJson.events.some((e) => e.type === "ticket.created")).toBe(true);

    const showRef = await runAllowFail({
      cwd: root,
      cmd: [
        "git",
        `--git-dir=${remoteDir}`,
        "show-ref",
        "--verify",
        "refs/hack/tickets",
      ],
    });
    expect(showRef.exitCode).toBe(0);

    await rm(root, { recursive: true, force: true });
  }
);

interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

async function run(opts: {
  readonly cwd: string;
  readonly cmd: readonly string[];
}): Promise<RunResult> {
  const result = await runAllowFail(opts);
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed (${result.exitCode}): ${opts.cmd.join(" ")}\n${result.stderr || result.stdout}`
    );
  }
  return result;
}

async function runAllowFail(opts: {
  readonly cwd: string;
  readonly cmd: readonly string[];
}): Promise<RunResult> {
  const proc = Bun.spawn([...opts.cmd], {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: process.env,
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

async function runHack(opts: {
  readonly cwd: string;
  readonly args: readonly string[];
}): Promise<RunResult> {
  return await run({
    cwd: opts.cwd,
    cmd: ["bun", resolve(import.meta.dir, "../index.ts"), ...opts.args],
  });
}

async function mkdirTempDir(opts: {
  readonly prefix: string;
}): Promise<string> {
  const root = join(tmpdir(), `${opts.prefix}${Date.now()}-${Math.random()}`);
  await mkdir(root, { recursive: true });
  return root;
}

async function copyDir(opts: {
  readonly from: string;
  readonly to: string;
}): Promise<void> {
  await mkdir(opts.to, { recursive: true });
  const entries = await readdir(opts.from, { withFileTypes: true });
  for (const entry of entries) {
    const fromPath = join(opts.from, entry.name);
    const toPath = join(opts.to, entry.name);
    if (entry.isDirectory()) {
      await copyDir({ from: fromPath, to: toPath });
    } else if (entry.isFile()) {
      const data = await readFile(fromPath);
      await writeFile(toPath, data);
    }
  }
}
