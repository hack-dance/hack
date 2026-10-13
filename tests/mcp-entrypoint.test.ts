import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

/** Spawns the source CLI with a private HOME and environment. */
async function spawnCli(args: readonly string[]) {
  const root = await mkdtemp(join(tmpdir(), "hack-mcp-entrypoint-"));
  roots.push(root);
  return Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "..", "index.ts"), ...args],
    {
      env: privateCliEnv({ root }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
}

for (const args of [
  ["mcp", "serve", "--help"],
  ["--help", "mcp", "serve"],
  ["mcp", "serve", "--version"],
]) {
  test(`MCP entrypoint preserves parser behavior for ${args.join(" ")}`, async () => {
    const proc = await spawnCli(args);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain(
      args.includes("--version") ? "hack v" : "hack mcp serve"
    );
  });
}

test("MCP entrypoint rejects unknown options through the normal JSON error path", async () => {
  const proc = await spawnCli(["mcp", "serve", "--json", "--bogus-option"]);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code).toBe(1);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toMatchObject({ error: { code: "E_USAGE" } });
});
