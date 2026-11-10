import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliUsageError } from "../src/cli/command.ts";
import { loadDevCommand } from "../src/commands/dev.ts";

const fixtures: string[] = [];
afterEach(async () => {
  for (const path of fixtures.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});
async function fixture(value: unknown) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hack-dev-test-")));
  fixtures.push(root);
  await initRepo(root);
  await mkdir(join(root, ".hack"), { mode: 0o700 });
  await mkdir(join(root, "nested"), { mode: 0o700 });
  await Bun.write(join(root, ".hack/dev.json"), JSON.stringify(value));
  await chmod(join(root, ".hack/dev.json"), 0o600);
  return root;
}
async function initRepo(root: string) {
  const child = Bun.spawn(["git", "init", "--quiet", "--template=", root], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await child.exited) !== 0) {
    throw new Error("Git is required for checkout boundary tests");
  }
}
test("native declaration resolves from a subdirectory without Compose", async () => {
  const root = await fixture({
    version: 1,
    command: ["bun", "scripts/dev.ts"],
  });
  expect(await loadDevCommand({ cwd: join(root, "nested") })).toEqual({
    root,
    command: ["bun", "scripts/dev.ts"],
  });
});
test("rejects shell strings, empty argv and unsupported versions", async () => {
  for (const value of [
    { version: 1, command: "sh dev.sh" },
    { version: 1, command: [] },
    { version: 2, command: ["bun"] },
  ]) {
    const root = await fixture(value);
    await expect(loadDevCommand({ cwd: root })).rejects.toThrow("Invalid");
  }
});
test("CLI preserves argv, cwd and child failure status", async () => {
  const root = await fixture({
    version: 1,
    command: [
      process.execPath,
      "-e",
      "console.log(process.cwd()); console.log(process.argv[1]); process.exit(7)",
      "literal $(echo unsafe)",
    ],
  });
  const child = Bun.spawn(
    [process.execPath, "index.ts", "dev", "--path", root],
    { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" }
  );
  expect(await child.exited).toBe(7);
  expect(await new Response(child.stdout).text()).toContain(
    "literal $(echo unsafe)"
  );
});

test.each([
  "SIGTERM",
  "SIGHUP",
] as const)("%s reaches the declared runner and waits for cleanup", async (signal) => {
  const root = await fixture({
    version: 1,
    command: [process.execPath, "runner.ts"],
  });
  await Bun.write(
    join(root, "runner.ts"),
    `
    process.on("${signal}", async () => {
      await Bun.write("stopped", "cleaned");
      process.exit(0);
    });
    console.log("ready");
    setInterval(() => {}, 1000);
  `
  );
  const child = Bun.spawn(
    [process.execPath, "index.ts", "dev", "--path", root],
    {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain("ready");
    reader.releaseLock();
    child.kill(signal);
    expect(await child.exited).toBe(0);
    expect(await Bun.file(join(root, "stopped")).text()).toBe("cleaned");
  } finally {
    child.kill();
    await child.exited;
  }
});

test("malformed JSON and missing executables return actionable errors", async () => {
  const root = await fixture({
    version: 1,
    command: ["hack-dev-nonexistent-executable"],
  });
  const child = Bun.spawn(
    [process.execPath, "index.ts", "dev", "--path", root],
    { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" }
  );
  expect(await child.exited).not.toBe(0);
  const output =
    (await new Response(child.stderr).text()) +
    (await new Response(child.stdout).text());
  expect(output).toContain("Cannot start the declared dev command");
  await Bun.write(join(root, ".hack/dev.json"), "{bad json");
  await expect(loadDevCommand({ cwd: root })).rejects.toThrow(
    "expected valid JSON"
  );
});

test("does not execute declarations outside the selected checkout", async () => {
  const outer = await fixture({ version: 1, command: ["attacker-command"] });
  const inner = join(outer, "victim");
  await mkdir(inner);
  await initRepo(inner);
  await mkdir(join(inner, "nested"));
  await expect(loadDevCommand({ cwd: join(inner, "nested") })).rejects.toThrow(
    "No .hack/dev.json found in this repository"
  );
  await mkdir(join(inner, ".hack"));
  await symlink(join(outer, ".hack/dev.json"), join(inner, ".hack/dev.json"));
  await expect(loadDevCommand({ cwd: inner })).rejects.toThrow(
    "must stay inside this repository"
  );
});

test("missing --path returns an actionable usage error", async () => {
  const root = await fixture({ version: 1, command: ["unused"] });
  await expect(loadDevCommand({ cwd: join(root, "missing") })).rejects.toThrow(
    "Check --path"
  );
});

test("a false Git marker above a non-Git project grants no discovery boundary", async () => {
  const outer = await fixture({ version: 1, command: ["attacker-command"] });
  await rm(join(outer, ".git"), { recursive: true });
  await mkdir(join(outer, ".git"));
  const victim = join(outer, "victim");
  await mkdir(victim);
  await expect(loadDevCommand({ cwd: victim })).rejects.toThrow(
    "No .hack/dev.json found in this repository"
  );
});

test("empty non-executable argv values remain literal", async () => {
  const root = await fixture({
    version: 1,
    command: [
      process.execPath,
      "-e",
      "console.log(JSON.stringify(process.argv.slice(1)))",
      "",
    ],
  });
  const child = Bun.spawn(
    [process.execPath, "index.ts", "dev", "--path", root],
    { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" }
  );
  expect(await child.exited).toBe(0);
  expect((await new Response(child.stdout).text()).trim()).toBe('[""]');
});

test("shared write access cannot replace the checked declaration or launch directory", async () => {
  if (process.getuid === undefined) {
    return;
  }
  const root = await fixture({ version: 1, command: ["unused"] });
  const declaration = join(root, ".hack/dev.json");
  await chmod(declaration, 0o666);
  await expect(loadDevCommand({ cwd: root })).rejects.toThrow(
    "without shared write access"
  );
  await chmod(declaration, 0o600);
  await chmod(join(root, ".hack"), 0o777);
  await expect(loadDevCommand({ cwd: root })).rejects.toThrow(
    "replaceable by other users"
  );
  await chmod(join(root, ".hack"), 0o700);
  await chmod(root, 0o777);
  await expect(loadDevCommand({ cwd: root })).rejects.toThrow(
    "replaceable by other users"
  );
  await chmod(root, 0o700);
});

test("a replacement file cannot supply bytes after a different inode passed validation", async () => {
  if (process.getuid === undefined) {
    return;
  }
  const root = await fixture({ version: 1, command: ["trusted"] });
  const destination = join(root, ".hack/dev.json");
  const swapping = (async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const next = join(root, ".hack/replacement");
      const trusted = attempt % 2 === 0;
      await writeFile(
        next,
        JSON.stringify({
          version: 1,
          command: [trusted ? "trusted" : "untrusted"],
        })
      );
      await chmod(next, trusted ? 0o600 : 0o666);
      await rename(next, destination);
    }
  })();
  try {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        expect((await loadDevCommand({ cwd: root })).command).toEqual([
          "trusted",
        ]);
      } catch (error) {
        if (
          !(
            error instanceof CliUsageError &&
            (error.message.includes("without shared write access") ||
              error.message.startsWith("Cannot safely open") ||
              error.message.startsWith("Cannot verify private dev access"))
          )
        ) {
          throw error;
        }
      }
    }
  } finally {
    await swapping;
  }
  await writeFile(
    destination,
    JSON.stringify({ version: 1, command: ["trusted"] })
  );
  await chmod(destination, 0o600);
  expect((await loadDevCommand({ cwd: root })).command).toEqual(["trusted"]);
}, 15_000);

test("umask 002 checkouts receive path, mode and remediation instead of an opaque refusal", async () => {
  if (process.getuid === undefined) {
    return;
  }
  const root = await fixture({ version: 1, command: ["unused"] });
  const path = join(root, ".hack/dev.json");
  await chmod(path, 0o664);
  for (const expected of [path, "mode 664", "chmod g-w", "umask 022"]) {
    await expect(loadDevCommand({ cwd: root })).rejects.toThrow(expected);
  }
  await chmod(path, 0o600);
  await chmod(root, 0o775);
  for (const expected of [root, "mode 775", "chmod g-w", "umask 022"]) {
    await expect(loadDevCommand({ cwd: root })).rejects.toThrow(expected);
  }
  await chmod(root, 0o700);
});
