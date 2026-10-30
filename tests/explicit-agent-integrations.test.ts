import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli/run.ts";
import { restoreEnv } from "./helpers/env.ts";

/** No child processes or host checks: exercise only selected opt-in/retired handlers. */
test("CLI retirement preserves project/global originals; selected skill and MCP remain opt-in", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-explicit-agent-cli-"));
  const home = join(root, "home"),
    repo = join(root, "repo");
  const oldHome = process.env.HOME,
    oldPath = process.env.PATH,
    oldCwd = process.cwd();
  const out = process.stdout.write,
    err = process.stderr.write;
  const paths = [
    "AGENTS.md",
    "CLAUDE.md",
    ".claude/settings.json",
    ".cursor/rules/hack.mdc",
    ".ai/skills/hack-cli/SKILL.md",
  ];
  let output = "";
  try {
    for (const base of [home, repo]) {
      for (const path of paths) {
        await Bun.write(join(base, path), `original: ${path}\n`);
      }
    }
    await Bun.write(join(repo, ".git", "HEAD"), "ref: refs/heads/fixture\n");
    process.env.HOME = home;
    process.env.PATH = join(root, "empty-path");
    process.chdir(repo);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    expect(await runCli(["init", "--auto", "--name", "fixture"])).toBe(0);
    for (const args of [
      ["setup", "mcp"],
      ["setup", "agents"],
      ["setup", "agents", "--remove"],
      ["setup", "claude"],
      ["setup", "cursor", "--global"],
      ["setup", "sync", "--all-scopes", "--install-missing"],
      ["setup", "sync", "--remove"],
      ...["--docs", "--agents-md", "--claude-md"].map((flag) => [
        "mcp",
        "install",
        "--codex",
        flag,
      ]),
    ]) {
      output = "";
      expect(await runCli(args)).toBe(1);
      expect(await Bun.file(join(repo, ".codex/config.toml")).exists()).toBe(
        false
      );
    }
    output = "";
    expect(await runCli(["agent", "prime", "--check"])).toBe(0);
    expect(output).not.toContain("Hack integration inventory:");
    expect(await runCli(["setup", "codex"])).toBe(0);
    expect(
      await Bun.file(join(repo, ".codex/skills/hack-cli/SKILL.md")).text()
    ).toContain("explicit opt-ins");
    expect(
      await Bun.file(join(home, ".codex/skills/hack-cli/SKILL.md")).exists()
    ).toBe(false);
    expect(
      await runCli(["mcp", "install", "--codex", "--scope", "project"])
    ).toBe(0);
    expect(await Bun.file(join(repo, ".codex/config.toml")).text()).toContain(
      "mcp_servers.hack"
    );
    for (const base of [home, repo]) {
      for (const path of paths) {
        expect(await Bun.file(join(base, path)).text()).toBe(
          `original: ${path}\n`
        );
      }
    }
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
    process.chdir(oldCwd);
    restoreEnv("HOME", oldHome);
    restoreEnv("PATH", oldPath);
    await rm(root, { recursive: true, force: true });
  }
});
