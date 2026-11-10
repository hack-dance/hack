import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDevCommand } from "../src/commands/dev.ts";

const fixtures: string[] = [];
afterEach(async () => {
  for (const path of fixtures.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});
async function fixture(value: unknown) {
  const root = await mkdtemp(join(tmpdir(), "hack-dev-test-"));
  fixtures.push(root);
  await mkdir(join(root, ".hack"));
  await mkdir(join(root, "nested"));
  await Bun.write(join(root, ".hack/dev.json"), JSON.stringify(value));
  return root;
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

test("SIGTERM reaches the declared runner and waits for cleanup", async () => {
  const root = await fixture({
    version: 1,
    command: [process.execPath, "runner.ts"],
  });
  await Bun.write(
    join(root, "runner.ts"),
    `
    process.on("SIGTERM", async () => {
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
    child.kill("SIGTERM");
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
